import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { SingleResult } from '@oh-my-pi/pi-coding-agent/task/types'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { executeSwarmBashNode, type BashNodeResult } from './bash-node-executor'
import { readNodeControlDecision, type ControlDecision } from './control'
import {
  buildDependencyGraph,
  buildExecutionWaves,
  collectTransitiveDependents,
  detectCycles,
} from './dag'
import { executeSwarmAgent, type SwarmExecutorOptions } from './executor'
import type {
  SwarmBashNode,
  SwarmDefinition,
  SwarmGraphReference,
  SwarmGraphRepeat,
  SwarmNodeControl,
} from './schema'
import {
  createInitializedStateTracker,
  type RestartEvent,
  type StateTracker,
} from './state'

interface AgentConcurrencyLimiter {
  run<T>(operation: () => Promise<T>): Promise<T>
  available(): number
}

export interface PipelineOptions {
  workspace: string
  signal?: AbortSignal
  onProgress?: (state: PipelineProgress) => void
  modelRegistry?: ModelRegistry
  settings?: Settings
  agentConcurrencyLimiter?: AgentConcurrencyLimiter
  resume?: {
    startIteration: number
    settledNodes: readonly string[]
  }
}

interface PipelineProgress {
  iteration: number
  targetCount: number
  currentWave: number
  totalWaves: number
  nodes: Record<string, { status: string; iteration: number }>
}
type PipelineStatus = 'completed' | 'failed' | 'aborted'
interface RepeatStopSignalResult {
  status: PipelineStatus | 'continue'
  errors: string[]
}

export interface GraphResult {
  index: number
  id: string
  graph: string
  path: string
  status: PipelineStatus
  rounds: number
  errors: string[]
  durationMs: number
  stateDirs: string[]
}

export interface PipelineResult {
  status: PipelineStatus
  iterations: number
  agentResults: Map<string, SingleResult[]>
  bashResults: Map<string, BashNodeResult[]>
  graphResults: Map<string, GraphResult[]>
  errors: string[]
}

interface IterationOptions extends PipelineOptions {
  emitProgress: (currentWave: number, totalWaves: number) => void
  initialSettledNodes?: ReadonlySet<string>
}

interface IterationResults {
  agentResults: SingleResult[]
  bashResults: BashNodeResult[]
  graphResults: GraphResult[]
  errors: string[]
}

type NodeRunResult =
  | { kind: 'agent'; name: string; result: SingleResult }
  | { kind: 'bash'; name: string; result: BashNodeResult }
  | { kind: 'graph'; name: string; result: GraphResult }

interface ControlNodeDecision {
  nodeName: string
  control: SwarmNodeControl
  decision: ControlDecision
}

type FinishGraphArguments = [
  graph: SwarmGraphReference,
  currentIndex: number,
  attempt: number,
  startedAt: number,
  rounds: number,
  stateDirectories: string[],
  status: PipelineStatus,
  errors: string[],
]

class Semaphore implements AgentConcurrencyLimiter {
  readonly #max: number
  #active = 0
  readonly #queue: (() => void)[] = []

  constructor(max: number) {
    this.#max = max
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.#acquire()
    try {
      return await operation()
    } finally {
      this.#release()
    }
  }

  available(): number {
    if (this.#queue.length > 0) return 0
    return Math.max(0, this.#max - this.#active)
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#max) {
      this.#active++
      return
    }

    await new Promise<void>((resolve) => {
      this.#queue.push(resolve)
    })
    this.#active++
  }

  #release(): void {
    this.#active--
    this.#queue.shift()?.()
  }
}

export class PipelineController {
  readonly #swarmDefinition: SwarmDefinition
  readonly #waves: string[][]
  readonly #stateTracker: StateTracker
  readonly #dependencies: Map<string, Set<string>>
  readonly #agentConcurrencyLimiter: AgentConcurrencyLimiter

  constructor(
    swarmDefinition: SwarmDefinition,
    waves: string[][],
    stateTracker: StateTracker,
  ) {
    this.#swarmDefinition = swarmDefinition
    this.#waves = waves
    this.#stateTracker = stateTracker
    this.#dependencies = buildDependencyGraph(swarmDefinition)
    this.#agentConcurrencyLimiter = new Semaphore(swarmDefinition.concurrency)
  }

  async run(options: PipelineOptions): Promise<PipelineResult> {
    const allAgentResults = this.#createAgentResultMap()
    const allBashResults = this.#createBashResultMap()
    const allGraphResults = this.#createGraphResultMap()
    const errors: string[] = []
    const targetCount = this.#swarmDefinition.targetCount
    const runOptions: PipelineOptions = {
      ...options,
      agentConcurrencyLimiter:
        options.agentConcurrencyLimiter ?? this.#agentConcurrencyLimiter,
    }

    await this.#syncAgentModelMetadata()

    await this.#stateTracker.appendOrchestratorLog(
      `Pipeline '${this.#swarmDefinition.name}' starting: mode=${this.#swarmDefinition.mode} iterations=${targetCount} waves=${this.#waves.length} nodes=${this.#swarmDefinition.nodes.size} agents=${this.#swarmDefinition.agents.size} bash=${this.#swarmDefinition.bashNodes.size} graphs=${this.#swarmDefinition.graphs.size} concurrency=${this.#swarmDefinition.concurrency}`,
    )

    try {
      const completedIterations = await this.#runIterations(
        runOptions,
        allAgentResults,
        allBashResults,
        allGraphResults,
        errors,
      )
      return await this.#finishRun(
        completedIterations,
        allAgentResults,
        allBashResults,
        allGraphResults,
        errors,
      )
    } catch (error_) {
      return await this.#failRun(
        error_,
        allAgentResults,
        allBashResults,
        allGraphResults,
        errors,
      )
    }
  }

  async #syncAgentModelMetadata(): Promise<void> {
    for (const [name, agent] of this.#swarmDefinition.agents) {
      const model = agent.model ?? this.#swarmDefinition.model
      if (model !== undefined)
        await this.#stateTracker.updateAgent(name, { model })
    }
  }

  async #runIterations(
    options: PipelineOptions,
    allAgentResults: Map<string, SingleResult[]>,
    allBashResults: Map<string, BashNodeResult[]>,
    allGraphResults: Map<string, GraphResult[]>,
    errors: string[],
  ): Promise<number> {
    const resumeStartIteration = options.resume?.startIteration ?? 0
    const initialSettledNodes =
      options.resume === undefined
        ? undefined
        : new Set(options.resume.settledNodes)
    for (
      let iteration = resumeStartIteration;
      iteration < this.#swarmDefinition.targetCount;
      iteration++
    ) {
      if (options.signal?.aborted) {
        await this.#stateTracker.updatePipeline({ status: 'aborted' })
        return iteration
      }

      await this.#stateTracker.updatePipeline({ iteration })
      await this.#stateTracker.appendOrchestratorLog(
        `--- Iteration ${iteration + 1}/${this.#swarmDefinition.targetCount} ---`,
      )

      const emitProgress = (currentWave: number, totalWaves: number) => {
        options.onProgress?.({
          iteration,
          targetCount: this.#swarmDefinition.targetCount,
          currentWave,
          totalWaves,
          nodes: this.#buildProgressSnapshot(),
        })
      }

      const iterationResults = await this.#runIteration(iteration, {
        ...options,
        emitProgress,
        ...(iteration === resumeStartIteration &&
        initialSettledNodes !== undefined
          ? { initialSettledNodes }
          : {}),
      })
      this.#collectIterationResults(
        iteration,
        iterationResults,
        allAgentResults,
        allBashResults,
        allGraphResults,
        errors,
      )
    }

    return this.#swarmDefinition.targetCount
  }

  #collectIterationResults(
    iteration: number,
    iterationResults: IterationResults,
    allAgentResults: Map<string, SingleResult[]>,
    allBashResults: Map<string, BashNodeResult[]>,
    allGraphResults: Map<string, GraphResult[]>,
    errors: string[],
  ): void {
    collectAgentIterationResults(
      iteration,
      iterationResults.agentResults,
      allAgentResults,
      errors,
    )
    collectBashIterationResults(
      iteration,
      iterationResults.bashResults,
      allBashResults,
      errors,
    )
    collectGraphIterationResults(
      iteration,
      iterationResults.graphResults,
      allGraphResults,
      errors,
    )
    errors.push(...iterationResults.errors)
  }

  async #finishRun(
    completedIterations: number,
    allAgentResults: Map<string, SingleResult[]>,
    allBashResults: Map<string, BashNodeResult[]>,
    allGraphResults: Map<string, GraphResult[]>,
    errors: string[],
  ): Promise<PipelineResult> {
    if (completedIterations < this.#swarmDefinition.targetCount) {
      return {
        status: 'aborted',
        iterations: completedIterations,
        agentResults: allAgentResults,
        bashResults: allBashResults,
        graphResults: allGraphResults,
        errors,
      }
    }

    const status =
      errors.length > 0 ? ('failed' as const) : ('completed' as const)
    await this.#stateTracker.updatePipeline({ status, completedAt: Date.now() })
    await this.#stateTracker.appendOrchestratorLog(
      `Pipeline ${status} (${errors.length} errors)`,
    )

    return {
      status,
      iterations: completedIterations,
      agentResults: allAgentResults,
      bashResults: allBashResults,
      graphResults: allGraphResults,
      errors,
    }
  }

  async #failRun(
    error_: unknown,
    allAgentResults: Map<string, SingleResult[]>,
    allBashResults: Map<string, BashNodeResult[]>,
    allGraphResults: Map<string, GraphResult[]>,
    errors: string[],
  ): Promise<PipelineResult> {
    const error = error_ instanceof Error ? error_.message : String(error_)
    await this.#stateTracker.updatePipeline({
      status: 'failed',
      completedAt: Date.now(),
    })
    await this.#stateTracker.appendOrchestratorLog(
      `Pipeline fatal error: ${error}`,
    )
    errors.push(error)
    return {
      status: 'failed',
      iterations: 0,
      agentResults: allAgentResults,
      bashResults: allBashResults,
      graphResults: allGraphResults,
      errors,
    }
  }

  async #runIteration(
    iteration: number,
    options: IterationOptions,
  ): Promise<IterationResults> {
    if (this.#hasControlNodes()) {
      return await this.#runBarrierIteration(iteration, options)
    }
    return await this.#runStreamingIteration(iteration, options)
  }

  #hasControlNodes(): boolean {
    return (
      [...this.#swarmDefinition.agents.values()].some(
        (agent) => agent.control !== undefined,
      ) ||
      [...this.#swarmDefinition.graphs.values()].some(
        (graph) => graph.control !== undefined,
      )
    )
  }

  async #runBarrierIteration(
    iteration: number,
    options: IterationOptions,
  ): Promise<IterationResults> {
    const agentResults: SingleResult[] = []
    const bashResults: BashNodeResult[] = []
    const graphResults: GraphResult[] = []
    const errors: string[] = []
    const settled = new Set(options.initialSettledNodes)
    const pending = new Set(
      [...this.#dependencies.keys()].filter((node) => !settled.has(node)),
    )
    let nodeIndex = 0
    let currentWave = 0
    if (pending.size === 0) {
      return { agentResults, bashResults, graphResults, errors }
    }

    while (pending.size > 0) {
      if (options.signal?.aborted) break

      const ready = this.#getReadyNodes(pending, settled)
      if (ready.length === 0) {
        throw new Error(
          `Deadlock: nodes [${[...pending].join(', ')}] cannot make progress after restart invalidation`,
        )
      }

      const totalWaves = Math.max(this.#waves.length, currentWave + 1)
      await this.#prepareWave(ready, currentWave, iteration)
      options.emitProgress(currentWave, totalWaves)

      const waveResults = await Promise.all(
        ready.map((nodeName) =>
          this.#runNode(nodeName, nodeIndex++, iteration, currentWave, options),
        ),
      )

      collectWaveResults(waveResults, agentResults, bashResults, graphResults)
      markWaveSettled(waveResults, pending, settled)
      options.emitProgress(currentWave, totalWaves)

      const controlDecisions = await this.#collectControlDecisions(
        waveResults,
        options.workspace,
      )
      const controlResult = await this.#applyControlDecisions(
        controlDecisions,
        pending,
        settled,
        iteration,
      )
      errors.push(...controlResult.errors)
      if (controlResult.terminate) break

      currentWave++
    }

    return { agentResults, bashResults, graphResults, errors }
  }

  async #runStreamingIteration(
    iteration: number,
    options: IterationOptions,
  ): Promise<IterationResults> {
    const agentResults: SingleResult[] = []
    const bashResults: BashNodeResult[] = []
    const graphResults: GraphResult[] = []
    const errors: string[] = []
    const settled = new Set(options.initialSettledNodes)
    const pending = new Set(
      [...this.#dependencies.keys()].filter((node) => !settled.has(node)),
    )
    const running = new Map<string, Promise<NodeRunResult>>()
    let nodeIndex = 0
    let dispatchIndex = 0
    if (pending.size === 0) {
      return { agentResults, bashResults, graphResults, errors }
    }

    while (pending.size > 0 || running.size > 0) {
      if (options.signal?.aborted) break

      const ready = this.#getReadyNodes(pending, settled)
      const dispatchable = this.#selectStreamingDispatchNodes(
        ready,
        running,
        options,
      )

      for (const nodeName of dispatchable) {
        const totalWaves = Math.max(this.#waves.length, dispatchIndex + 1)
        await this.#prepareWave([nodeName], dispatchIndex, iteration)
        options.emitProgress(dispatchIndex, totalWaves)
        pending.delete(nodeName)
        running.set(
          nodeName,
          this.#runNode(
            nodeName,
            nodeIndex++,
            iteration,
            dispatchIndex,
            options,
          ),
        )
        dispatchIndex++
      }

      if (running.size === 0) {
        if (pending.size === 0) break
        throw new Error(
          `Deadlock: nodes [${[...pending].join(', ')}] cannot make progress during streaming scheduling`,
        )
      }

      const completed = await Promise.race(
        [...running].map(async ([nodeName, promise]) => ({
          nodeName,
          result: await promise,
        })),
      )
      running.delete(completed.nodeName)
      collectNodeResult(
        completed.result,
        agentResults,
        bashResults,
        graphResults,
      )
      markNodeSettled(completed.result, pending, settled)
      options.emitProgress(
        Math.max(0, dispatchIndex - 1),
        Math.max(this.#waves.length, dispatchIndex),
      )
    }

    return { agentResults, bashResults, graphResults, errors }
  }

  #selectStreamingDispatchNodes(
    ready: string[],
    running: Map<string, Promise<NodeRunResult>>,
    options: IterationOptions,
  ): string[] {
    const sortedReady = ready.toSorted((left, right) => {
      const leftDepth = this.#dependencies.get(left)?.size ?? 0
      const rightDepth = this.#dependencies.get(right)?.size ?? 0
      return leftDepth - rightDepth || left.localeCompare(right)
    })
    const agentBudget = this.#getStreamingAgentDispatchBudget(running, options)
    let selectedAgents = 0
    const selected: string[] = []
    for (const nodeName of sortedReady) {
      const node = this.#swarmDefinition.nodes.get(nodeName)
      if (node?.type !== 'agent') {
        selected.push(nodeName)
        continue
      }
      if (selectedAgents >= agentBudget) continue
      selected.push(nodeName)
      selectedAgents++
    }
    return selected
  }

  #getStreamingAgentDispatchBudget(
    running: Map<string, Promise<NodeRunResult>>,
    options: IterationOptions,
  ): number {
    const available =
      options.agentConcurrencyLimiter?.available() ?? Number.POSITIVE_INFINITY
    if (available > 0) return available
    if (available === 0 && running.size === 0) return 1
    return 0
  }

  #getReadyNodes(pending: Set<string>, settled: Set<string>): string[] {
    return [...pending]
      .filter((node) => this.#isReadyNode(node, settled))
      .toSorted((left, right) => left.localeCompare(right))
  }

  #isReadyNode(node: string, settled: Set<string>): boolean {
    const dependencies = this.#dependencies.get(node)
    return (
      dependencies !== undefined &&
      [...dependencies].every((dependency) => settled.has(dependency))
    )
  }

  async #prepareWave(
    wave: string[],
    waveIndex: number,
    iteration: number,
  ): Promise<void> {
    await this.#stateTracker.appendOrchestratorLog(
      `Wave ${waveIndex + 1}/${Math.max(this.#waves.length, waveIndex + 1)}: [${wave.join(', ')}]`,
    )

    for (const nodeName of wave) {
      const node = this.#swarmDefinition.nodes.get(nodeName)
      switch (node?.type) {
        case 'agent': {
          await this.#stateTracker.updateAgent(nodeName, {
            status: 'waiting',
            iteration,
            wave: waveIndex,
          })

          break
        }
        case 'bash': {
          await this.#stateTracker.updateBashNode(nodeName, {
            status: 'waiting',
            iteration,
            wave: waveIndex,
          })

          break
        }
        case 'graph': {
          await this.#stateTracker.updateGraph(nodeName, {
            status: 'waiting',
            iteration,
            wave: waveIndex,
          })

          break
        }
        // No default
      }
    }
  }

  async #runNode(
    nodeName: string,
    currentIndex: number,
    iteration: number,
    waveIndex: number,
    options: IterationOptions,
  ): Promise<NodeRunResult> {
    const node = this.#swarmDefinition.nodes.get(nodeName)
    if (node === undefined) throw new Error(`Unknown swarm node '${nodeName}'`)

    switch (node.type) {
      case 'agent': {
        const { agentName, result } = await this.#runAgent(
          nodeName,
          currentIndex,
          iteration,
          waveIndex,
          options,
        )
        return { kind: 'agent', name: agentName, result }
      }
      case 'bash': {
        return {
          kind: 'bash',
          name: nodeName,
          result: await this.#runBashNode(
            node,
            currentIndex,
            iteration,
            waveIndex,
            options,
          ),
        }
      }
      case 'graph': {
        return {
          kind: 'graph',
          name: nodeName,
          result: await this.#runGraph(
            node,
            currentIndex,
            iteration,
            waveIndex,
            options,
          ),
        }
      }
    }
  }

  async #runAgent(
    agentName: string,
    currentIndex: number,
    iteration: number,
    waveIndex: number,
    options: IterationOptions,
  ): Promise<{ agentName: string; result: SingleResult }> {
    const agent = this.#swarmDefinition.agents.get(agentName)
    if (agent === undefined)
      throw new Error(`Unknown swarm node '${agentName}'`)

    const attempt = this.#stateTracker.state.agents[agentName]?.attempt ?? 1
    try {
      const executorOptions = this.#buildAgentExecutorOptions(
        agent,
        iteration,
        attempt,
        waveIndex,
        options,
      )

      const limiter = options.agentConcurrencyLimiter
      const result =
        limiter === undefined
          ? await executeSwarmAgent(agent, currentIndex, executorOptions)
          : await limiter.run(
              async () =>
                await executeSwarmAgent(agent, currentIndex, executorOptions),
            )

      return { agentName, result }
    } catch (error_) {
      const error = error_ instanceof Error ? error_.message : String(error_)
      return {
        agentName,
        result: {
          index: currentIndex,
          id: `swarm-${this.#swarmDefinition.name}-${agentName}-${iteration}-attempt${attempt}`,
          agent: agentName,
          agentSource: 'project',
          task: agent.task,
          exitCode: 1,
          output: '',
          stderr: error,
          truncated: false,
          durationMs: 0,
          tokens: 0,
          requests: 0,
          error,
        },
      }
    }
  }

  async #runBashNode(
    node: SwarmBashNode,
    currentIndex: number,
    iteration: number,
    waveIndex: number,
    options: IterationOptions,
  ): Promise<BashNodeResult> {
    const attempt = this.#stateTracker.state.bashNodes[node.name]?.attempt ?? 1
    try {
      const result = await executeSwarmBashNode(node, currentIndex, {
        workspace: options.workspace,
        swarmName: this.#swarmDefinition.name,
        iteration,
        attempt,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        stateTracker: this.#stateTracker,
      })
      options.emitProgress(
        waveIndex,
        Math.max(this.#waves.length, waveIndex + 1),
      )
      return result
    } catch (error_) {
      const error = error_ instanceof Error ? error_.message : String(error_)
      return {
        index: currentIndex,
        id: `swarm-${this.#swarmDefinition.name}-${node.name}-${iteration}-attempt${attempt}`,
        node: node.name,
        command: node.command,
        exitCode: options.signal?.aborted ? 130 : 1,
        outputPath: node.outputPath,
        output: '',
        truncated: false,
        durationMs: 0,
        error,
      }
    }
  }

  #buildAgentExecutorOptions(
    agent: { model?: string },
    iteration: number,
    attempt: number,
    waveIndex: number,
    options: IterationOptions,
  ): SwarmExecutorOptions {
    const executorOptions: SwarmExecutorOptions = {
      workspace: options.workspace,
      swarmName: this.#swarmDefinition.name,
      iteration,
      attempt,
      onProgress: () => {
        options.emitProgress(
          waveIndex,
          Math.max(this.#waves.length, waveIndex + 1),
        )
      },
      stateTracker: this.#stateTracker,
    }
    const modelOverride = agent.model ?? this.#swarmDefinition.model
    if (modelOverride !== undefined)
      executorOptions.modelOverride = modelOverride
    if (options.signal !== undefined) executorOptions.signal = options.signal
    if (options.modelRegistry !== undefined)
      executorOptions.modelRegistry = options.modelRegistry
    if (options.settings !== undefined)
      executorOptions.settings = options.settings
    return executorOptions
  }

  async #runGraph(
    graph: SwarmGraphReference,
    currentIndex: number,
    iteration: number,
    waveIndex: number,
    options: IterationOptions,
  ): Promise<GraphResult> {
    const attempt = this.#stateTracker.state.graphs[graph.name]?.attempt ?? 1
    const startedAt = Date.now()
    const stateDirectories: string[] = []
    await this.#markGraphRunning(graph, startedAt, iteration, waveIndex)

    if (graph.definition === undefined || graph.resolvedPath === undefined) {
      return await this.#finishGraph(
        graph,
        currentIndex,
        attempt,
        startedAt,
        0,
        stateDirectories,
        'failed',
        [`Graph '${graph.name}' was not loaded`],
      )
    }

    if (graph.repeat === undefined) {
      return await this.#runSingleGraph(
        graph,
        currentIndex,
        attempt,
        startedAt,
        stateDirectories,
        waveIndex,
        options,
      )
    }

    return await this.#runRepeatedGraph(
      graph,
      currentIndex,
      attempt,
      startedAt,
      stateDirectories,
      waveIndex,
      options,
    )
  }

  async #markGraphRunning(
    graph: SwarmGraphReference,
    startedAt: number,
    iteration: number,
    waveIndex: number,
  ): Promise<void> {
    await this.#stateTracker.updateGraph(graph.name, {
      status: 'running',
      startedAt,
      iteration,
      wave: waveIndex,
      ...(graph.repeat === undefined
        ? {}
        : { maxRounds: graph.repeat.maxRounds }),
    })
    await this.#stateTracker.appendGraphLog(
      graph.name,
      `Graph '${graph.name}' starting`,
    )
  }

  async #runSingleGraph(
    graph: SwarmGraphReference,
    currentIndex: number,
    attempt: number,
    startedAt: number,
    stateDirectories: string[],
    waveIndex: number,
    options: IterationOptions,
  ): Promise<GraphResult> {
    if (graph.definition === undefined) {
      return await this.#finishGraph(
        graph,
        currentIndex,
        attempt,
        startedAt,
        0,
        stateDirectories,
        'failed',
        [`Graph '${graph.name}' was not loaded`],
      )
    }
    const childName = `${this.#swarmDefinition.name}.${graph.name}.attempt${attempt}`
    const childResult = await this.#runChildGraph(
      graph.name,
      graph.definition,
      childName,
      waveIndex,
      options,
    )
    stateDirectories.push(childResult.stateDirectory)
    return await this.#finishGraph(
      graph,
      currentIndex,
      attempt,
      startedAt,
      1,
      stateDirectories,
      childResult.result.status,
      childResult.result.errors,
    )
  }

  async #runRepeatedGraph(
    graph: SwarmGraphReference,
    currentIndex: number,
    attempt: number,
    startedAt: number,
    stateDirectories: string[],
    waveIndex: number,
    options: IterationOptions,
  ): Promise<GraphResult> {
    const repeat: SwarmGraphRepeat | undefined = graph.repeat
    const definition = graph.definition
    if (repeat === undefined || definition === undefined) {
      return await this.#finishGraphNotLoaded(
        graph,
        currentIndex,
        attempt,
        startedAt,
        stateDirectories,
      )
    }

    for (let round = 1; round <= repeat.maxRounds; round++) {
      const childResult = await this.#runRepeatRound(
        graph,
        definition,
        attempt,
        round,
        stateDirectories,
        waveIndex,
        options,
      )
      if (childResult.result.status !== 'completed') {
        return await this.#finishGraph(
          graph,
          currentIndex,
          attempt,
          startedAt,
          round,
          stateDirectories,
          childResult.result.status,
          childResult.result.errors,
        )
      }
      const stopSignalResult = await this.#readStopSignalResult(
        graph,
        options.workspace,
      )
      if (stopSignalResult.status !== 'continue') {
        return await this.#finishGraph(
          graph,
          currentIndex,
          attempt,
          startedAt,
          round,
          stateDirectories,
          stopSignalResult.status,
          stopSignalResult.errors,
        )
      }
      if (round === repeat.maxRounds) {
        return await this.#finishRepeatLimitExceeded(
          graph,
          currentIndex,
          attempt,
          startedAt,
          round,
          stateDirectories,
          repeat,
        )
      }
    }

    return await this.#finishRepeatLimitExceeded(
      graph,
      currentIndex,
      attempt,
      startedAt,
      repeat.maxRounds,
      stateDirectories,
      repeat,
    )
  }

  async #finishGraphNotLoaded(
    graph: SwarmGraphReference,
    currentIndex: number,
    attempt: number,
    startedAt: number,
    stateDirectories: string[],
  ): Promise<GraphResult> {
    return await this.#finishGraph(
      graph,
      currentIndex,
      attempt,
      startedAt,
      0,
      stateDirectories,
      'failed',
      [`Graph '${graph.name}' was not loaded`],
    )
  }

  async #finishRepeatLimitExceeded(
    graph: SwarmGraphReference,
    currentIndex: number,
    attempt: number,
    startedAt: number,
    round: number,
    stateDirectories: string[],
    repeat: SwarmGraphRepeat,
  ): Promise<GraphResult> {
    return await this.#finishGraph(
      graph,
      currentIndex,
      attempt,
      startedAt,
      round,
      stateDirectories,
      'failed',
      [
        `Graph '${graph.name}' did not reach '${repeat.successValue}' within ${repeat.maxRounds} rounds`,
      ],
    )
  }

  async #runRepeatRound(
    graph: SwarmGraphReference,
    definition: SwarmDefinition,
    attempt: number,
    round: number,
    stateDirectories: string[],
    waveIndex: number,
    options: IterationOptions,
  ): Promise<{ result: PipelineResult; stateDirectory: string }> {
    await this.#stateTracker.updateGraph(graph.name, {
      currentRound: round,
      ...(graph.repeat === undefined
        ? {}
        : { maxRounds: graph.repeat.maxRounds }),
    })
    const childName = `${this.#swarmDefinition.name}.${graph.name}.attempt${attempt}.round${round}`
    const childResult = await this.#runChildGraph(
      graph.name,
      definition,
      childName,
      waveIndex,
      options,
    )
    stateDirectories.push(childResult.stateDirectory)
    return childResult
  }

  async #readStopSignalResult(
    graph: SwarmGraphReference,
    workspace: string,
  ): Promise<RepeatStopSignalResult> {
    const repeat = graph.repeat
    if (repeat === undefined) {
      return {
        status: 'failed',
        errors: [`Graph '${graph.name}' was not loaded`],
      }
    }
    try {
      const stopSignal = await readRepeatStopSignal(workspace, graph)
      if (stopSignal === repeat.successValue) {
        return { status: 'completed', errors: [] }
      }
      if (stopSignal === repeat.continueValue) {
        return { status: 'continue', errors: [] }
      }
      return {
        status: 'failed',
        errors: [
          `Graph '${graph.name}' repeat stop signal '${repeat.stopSignal}' contained unexpected value '${stopSignal}'`,
        ],
      }
    } catch (error_) {
      const error = error_ instanceof Error ? error_.message : String(error_)
      return { status: 'failed', errors: [error] }
    }
  }

  async #collectControlDecisions(
    waveResults: NodeRunResult[],
    workspace: string,
  ): Promise<ControlNodeDecision[]> {
    const decisions: ControlNodeDecision[] = []

    for (const waveResult of waveResults) {
      const control = this.#getNodeControl(waveResult.name)
      if (control === undefined || !isSuccessfulNodeResult(waveResult)) continue
      const decision = await readNodeControlDecision(
        workspace,
        waveResult.name,
        control,
      )
      decisions.push({ nodeName: waveResult.name, control, decision })
      await this.#stateTracker.recordControlDecision(waveResult.name, {
        action: decision.action,
        signal: control.signal,
        at: Date.now(),
        ...(decision.target === undefined ? {} : { target: decision.target }),
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      })
    }

    return decisions
  }

  async #applyControlDecisions(
    decisions: ControlNodeDecision[],
    pending: Set<string>,
    settled: Set<string>,
    iteration: number,
  ): Promise<{ terminate: boolean; errors: string[] }> {
    const failDecision = decisions.find(
      (decision) => decision.decision.action === 'fail',
    )
    if (failDecision !== undefined) {
      return {
        terminate: true,
        errors: [
          `Control node '${failDecision.nodeName}' failed: ${failDecision.decision.reason ?? ''}`,
        ],
      }
    }

    const restartDecisions = decisions.filter(
      (decision) => decision.decision.action === 'restart',
    )
    if (restartDecisions.length === 0) return { terminate: false, errors: [] }

    const targets = uniqueSorted(
      restartDecisions
        .map((decision) => decision.decision.target)
        .filter((target): target is string => target !== undefined),
    )
    const invalidated = uniqueSorted(
      targets.flatMap((target) => [
        ...collectTransitiveDependents(this.#dependencies, target),
      ]),
    )
    const limitError = this.#validateRestartLimits(
      targets,
      invalidated,
      settled,
    )
    if (limitError !== undefined) {
      return { terminate: true, errors: [limitError] }
    }

    for (const nodeName of invalidated) {
      settled.delete(nodeName)
      pending.add(nodeName)
    }
    await this.#stateTracker.markNodesStaleForRestart(invalidated, iteration)

    const event: RestartEvent = {
      index: this.#stateTracker.state.restartHistory.length,
      iteration,
      requestedBy: uniqueSorted(
        restartDecisions.map((decision) => decision.nodeName),
      ),
      targets,
      invalidated,
      reasons: restartDecisions
        .map((decision) => decision.decision.reason)
        .filter((reason): reason is string => reason !== undefined),
      createdAt: Date.now(),
    }
    await this.#stateTracker.recordRestart(event)
    await this.#stateTracker.appendOrchestratorLog(
      `Restart ${event.index}: requested by [${event.requestedBy.join(', ')}], targets [${targets.join(', ')}], invalidated [${invalidated.join(', ')}]`,
    )
    return { terminate: false, errors: [] }
  }

  #validateRestartLimits(
    targets: string[],
    invalidated: string[],
    settled: Set<string>,
  ): string | undefined {
    const policy = this.#swarmDefinition.restartPolicy
    if (policy === undefined) return undefined

    if (this.#stateTracker.state.restartCount + 1 > policy.maxRestarts) {
      return `Restart limit exceeded: max_restarts ${policy.maxRestarts}`
    }

    for (const target of targets) {
      const targetCount =
        this.#stateTracker.state.restartTargetCounts[target] ?? 0
      if (targetCount + 1 > policy.maxRestartsPerTarget) {
        return `Restart target '${target}' exceeded max_restarts_per_target ${policy.maxRestartsPerTarget}`
      }
    }

    for (const nodeName of invalidated) {
      if (!settled.has(nodeName)) continue
      const attempt = this.#getNodeAttempt(nodeName)
      if (attempt + 1 > policy.maxNodeAttempts) {
        return `Node '${nodeName}' exceeded max_node_attempts ${policy.maxNodeAttempts}`
      }
    }

    return undefined
  }

  #getNodeControl(nodeName: string): SwarmNodeControl | undefined {
    return (
      this.#swarmDefinition.agents.get(nodeName)?.control ??
      this.#swarmDefinition.graphs.get(nodeName)?.control
    )
  }

  #getNodeAttempt(nodeName: string): number {
    return (
      this.#stateTracker.state.agents[nodeName]?.attempt ??
      this.#stateTracker.state.bashNodes[nodeName]?.attempt ??
      this.#stateTracker.state.graphs[nodeName]?.attempt ??
      1
    )
  }

  async #runChildGraph(
    graphName: string,
    definition: SwarmDefinition,
    childName: string,
    waveIndex: number,
    options: IterationOptions,
  ): Promise<{ result: PipelineResult; stateDirectory: string }> {
    const childDefinition = cloneSwarmDefinition(definition, childName)
    const dependencies = buildDependencyGraph(childDefinition)
    const cycles = detectCycles(dependencies)
    if (cycles !== undefined) {
      throw new Error(
        `Cycle detected in graph '${childName}': [${cycles.join(', ')}]`,
      )
    }
    const waves = buildExecutionWaves(dependencies)
    const stateTracker = await createInitializedStateTracker(
      options.workspace,
      childDefinition,
    )
    const controller = new PipelineController(
      childDefinition,
      waves,
      stateTracker,
    )
    const runOptions: PipelineOptions = {
      workspace: options.workspace,
      onProgress: () => {
        void this.#publishChildGraphState(
          graphName,
          stateTracker,
          waveIndex,
          options,
        ).catch(ignoreProgressPersistenceError)
      },
    }
    if (options.signal !== undefined) runOptions.signal = options.signal
    if (options.modelRegistry !== undefined)
      runOptions.modelRegistry = options.modelRegistry
    if (options.settings !== undefined) runOptions.settings = options.settings
    runOptions.agentConcurrencyLimiter =
      options.agentConcurrencyLimiter ?? this.#agentConcurrencyLimiter
    const result = await controller.run(runOptions)
    await this.#publishChildGraphState(
      graphName,
      stateTracker,
      waveIndex,
      options,
    )
    return { result, stateDirectory: stateTracker.swarmDir }
  }

  async #publishChildGraphState(
    graphName: string,
    childTracker: StateTracker,
    waveIndex: number,
    options: IterationOptions,
  ): Promise<void> {
    await this.#stateTracker.updateGraph(graphName, {
      childState: childTracker.snapshot(),
    })
    options.emitProgress(waveIndex, Math.max(this.#waves.length, waveIndex + 1))
  }

  async #finishGraph(
    ...[
      graph,
      currentIndex,
      attempt,
      startedAt,
      rounds,
      stateDirectories,
      status,
      errors,
    ]: FinishGraphArguments
  ): Promise<GraphResult> {
    const completedAt = Date.now()
    const error = errors[0]
    const stateDirectory = stateDirectories.at(-1)
    const update = {
      status,
      completedAt,
      ...(stateDirectory === undefined ? {} : { stateDir: stateDirectory }),
      ...(error === undefined ? {} : { error }),
    }
    await this.#stateTracker.updateGraph(graph.name, update)
    await this.#stateTracker.appendGraphLog(
      graph.name,
      `Graph '${graph.name}' ${status} (${errors.length} errors)`,
    )
    return {
      index: currentIndex,
      id: `swarm-${this.#swarmDefinition.name}-${graph.name}-attempt${attempt}`,
      graph: graph.name,
      path: graph.resolvedPath ?? graph.path,
      status,
      rounds,
      errors,
      durationMs: completedAt - startedAt,
      stateDirs: stateDirectories,
    }
  }

  #createAgentResultMap(): Map<string, SingleResult[]> {
    const results = new Map<string, SingleResult[]>()
    for (const name of this.#swarmDefinition.agents.keys()) {
      results.set(name, [])
    }
    return results
  }

  #createBashResultMap(): Map<string, BashNodeResult[]> {
    const results = new Map<string, BashNodeResult[]>()
    for (const name of this.#swarmDefinition.bashNodes.keys()) {
      results.set(name, [])
    }
    return results
  }

  #createGraphResultMap(): Map<string, GraphResult[]> {
    const results = new Map<string, GraphResult[]>()
    for (const name of this.#swarmDefinition.graphs.keys()) {
      results.set(name, [])
    }
    return results
  }

  #buildProgressSnapshot(): Record<
    string,
    { status: string; iteration: number }
  > {
    const nodes: Record<string, { status: string; iteration: number }> = {}
    for (const [name, state] of Object.entries(
      this.#stateTracker.state.agents,
    )) {
      nodes[name] = { status: state.status, iteration: state.iteration }
    }
    for (const [name, state] of Object.entries(
      this.#stateTracker.state.bashNodes,
    )) {
      nodes[name] = { status: state.status, iteration: state.iteration }
    }
    for (const [name, state] of Object.entries(
      this.#stateTracker.state.graphs,
    )) {
      nodes[name] = { status: state.status, iteration: state.iteration }
    }
    return nodes
  }
}

function ignoreProgressPersistenceError(error: unknown): void {
  if (error instanceof Error) return
}

function collectAgentIterationResults(
  iteration: number,
  agentResults: SingleResult[],
  allAgentResults: Map<string, SingleResult[]>,
  errors: string[],
): void {
  for (const result of agentResults) {
    allAgentResults.get(result.agent)?.push(result)
    if (result.exitCode !== 0) {
      const resultError = result.error ?? `exit code ${result.exitCode}`
      errors.push(
        `${result.agent} (iteration ${iteration + 1}): ${resultError}`,
      )
    }
  }
}

function collectBashIterationResults(
  iteration: number,
  bashResults: BashNodeResult[],
  allBashResults: Map<string, BashNodeResult[]>,
  errors: string[],
): void {
  for (const result of bashResults) {
    allBashResults.get(result.node)?.push(result)
    if (result.error !== undefined) {
      errors.push(
        `${result.node} (iteration ${iteration + 1}): ${result.error}`,
      )
    }
  }
}

function collectGraphIterationResults(
  iteration: number,
  graphResults: GraphResult[],
  allGraphResults: Map<string, GraphResult[]>,
  errors: string[],
): void {
  for (const result of graphResults) {
    allGraphResults.get(result.graph)?.push(result)
    if (result.status !== 'completed') {
      const resultError = result.errors.join('; ') || result.status
      errors.push(
        `${result.graph} (iteration ${iteration + 1}): ${resultError}`,
      )
    }
  }
}

function collectWaveResults(
  waveResults: NodeRunResult[],
  agentResults: SingleResult[],
  bashResults: BashNodeResult[],
  graphResults: GraphResult[],
): void {
  for (const result of waveResults) {
    if (result.kind === 'agent') {
      agentResults.push(result.result)
    } else if (result.kind === 'bash') {
      bashResults.push(result.result)
    } else {
      graphResults.push(result.result)
    }
  }
}

function collectNodeResult(
  nodeResult: NodeRunResult,
  agentResults: SingleResult[],
  bashResults: BashNodeResult[],
  graphResults: GraphResult[],
): void {
  if (nodeResult.kind === 'agent') {
    agentResults.push(nodeResult.result)
  } else if (nodeResult.kind === 'bash') {
    bashResults.push(nodeResult.result)
  } else {
    graphResults.push(nodeResult.result)
  }
}

function markNodeSettled(
  nodeResult: NodeRunResult,
  pending: Set<string>,
  settled: Set<string>,
): void {
  pending.delete(nodeResult.name)
  settled.add(nodeResult.name)
}

function markWaveSettled(
  waveResults: NodeRunResult[],
  pending: Set<string>,
  settled: Set<string>,
): void {
  for (const result of waveResults) {
    pending.delete(result.name)
    settled.add(result.name)
  }
}

function isSuccessfulNodeResult(waveResult: NodeRunResult): boolean {
  if (waveResult.kind === 'agent') return waveResult.result.exitCode === 0
  if (waveResult.kind === 'bash') return waveResult.result.error === undefined
  return waveResult.result.status === 'completed'
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].toSorted((left, right) =>
    left.localeCompare(right),
  )
}

function cloneSwarmDefinition(
  definition: SwarmDefinition,
  name: string,
): SwarmDefinition {
  return {
    ...definition,
    name,
    nodes: new Map(definition.nodes),
    nodeOrder: [...definition.nodeOrder],
    agents: new Map(definition.agents),
    bashNodes: new Map(definition.bashNodes),
    graphs: new Map(definition.graphs),
  }
}

async function readRepeatStopSignal(
  workspace: string,
  graph: SwarmGraphReference,
): Promise<string> {
  const repeat = graph.repeat
  if (repeat === undefined)
    throw new Error(`Graph '${graph.name}' was not loaded`)
  if (
    path.isAbsolute(repeat.stopSignal) ||
    repeat.stopSignal.split(/[\\/]+/).includes('..')
  ) {
    throw new Error(
      `Graph '${graph.name}' repeat.stop_signal must be a workspace-relative path without '..'`,
    )
  }
  const signalPath = path.resolve(workspace, repeat.stopSignal)
  try {
    const content = await fs.readFile(signalPath, 'utf8')
    return content.trim()
  } catch {
    throw new Error(
      `Graph '${graph.name}' repeat stop signal '${repeat.stopSignal}' was not found`,
    )
  }
}
