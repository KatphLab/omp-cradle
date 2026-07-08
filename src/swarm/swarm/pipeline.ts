/**
 * Pipeline controller for swarm execution.
 *
 * Orchestrates execution waves within each iteration:
 * - Agents in the same wave execute in parallel
 * - Waves execute sequentially (wave N+1 starts after wave N completes)
 * - For pipeline mode, iterations repeat the full DAG execution
 */
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { SingleResult } from '@oh-my-pi/pi-coding-agent/task/types'
import { executeSwarmAgent, type SwarmExecutorOptions } from './executor'
import type { SwarmDefinition } from './schema'
import type { StateTracker } from './state'

export interface PipelineOptions {
  workspace: string
  signal?: AbortSignal
  onProgress?: (state: PipelineProgress) => void
  modelRegistry?: ModelRegistry
  settings?: Settings
}

interface PipelineProgress {
  iteration: number
  targetCount: number
  currentWave: number
  totalWaves: number
  agents: Record<string, { status: string; iteration: number }>
}

export interface PipelineResult {
  status: 'completed' | 'failed' | 'aborted'
  iterations: number
  agentResults: Map<string, SingleResult[]>
  errors: string[]
}

interface IterationOptions extends PipelineOptions {
  emitProgress: (currentWave: number) => void
}

export class PipelineController {
  readonly #swarmDefinition: SwarmDefinition
  readonly #waves: string[][]
  readonly #stateTracker: StateTracker

  constructor(
    swarmDefinition: SwarmDefinition,
    waves: string[][],
    stateTracker: StateTracker,
  ) {
    this.#swarmDefinition = swarmDefinition
    this.#waves = waves
    this.#stateTracker = stateTracker
  }

  async run(options: PipelineOptions): Promise<PipelineResult> {
    const allResults = this.#createResultMap()
    const errors: string[] = []
    const targetCount = this.#swarmDefinition.targetCount

    await this.#stateTracker.appendOrchestratorLog(
      `Pipeline '${this.#swarmDefinition.name}' starting: mode=${this.#swarmDefinition.mode} iterations=${targetCount} waves=${this.#waves.length} agents=${this.#swarmDefinition.agents.size}`,
    )

    try {
      const completedIterations = await this.#runIterations(
        options,
        allResults,
        errors,
      )
      return await this.#finishRun(completedIterations, allResults, errors)
    } catch (error_) {
      return await this.#failRun(error_, allResults, errors)
    }
  }

  async #runIterations(
    options: PipelineOptions,
    allResults: Map<string, SingleResult[]>,
    errors: string[],
  ): Promise<number> {
    for (
      let iteration = 0;
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

      const emitProgress = (currentWave: number) => {
        options.onProgress?.({
          iteration,
          targetCount: this.#swarmDefinition.targetCount,
          currentWave,
          totalWaves: this.#waves.length,
          agents: this.#buildProgressSnapshot(),
        })
      }

      const iterationResults = await this.#runIteration(iteration, {
        ...options,
        emitProgress,
      })
      this.#collectIterationResults(
        iteration,
        iterationResults,
        allResults,
        errors,
      )
    }

    return this.#swarmDefinition.targetCount
  }

  #collectIterationResults(
    iteration: number,
    iterationResults: Map<string, SingleResult>,
    allResults: Map<string, SingleResult[]>,
    errors: string[],
  ): void {
    for (const [agentName, result] of iterationResults) {
      allResults.get(agentName)?.push(result)
      if (result.exitCode !== 0) {
        const resultError = result.error ?? `exit code ${result.exitCode}`
        errors.push(`${agentName} (iteration ${iteration + 1}): ${resultError}`)
      }
    }
  }

  async #finishRun(
    completedIterations: number,
    allResults: Map<string, SingleResult[]>,
    errors: string[],
  ): Promise<PipelineResult> {
    if (completedIterations < this.#swarmDefinition.targetCount) {
      return {
        status: 'aborted',
        iterations: completedIterations,
        agentResults: allResults,
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
      agentResults: allResults,
      errors,
    }
  }

  async #failRun(
    error_: unknown,
    allResults: Map<string, SingleResult[]>,
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
    return { status: 'failed', iterations: 0, agentResults: allResults, errors }
  }

  async #runIteration(
    iteration: number,
    options: IterationOptions,
  ): Promise<Map<string, SingleResult>> {
    const results = new Map<string, SingleResult>()
    let agentIndex = 0

    for (let waveIndex = 0; waveIndex < this.#waves.length; waveIndex++) {
      const wave = this.#waves[waveIndex]
      if (options.signal?.aborted || wave === undefined) break

      await this.#prepareWave(wave, waveIndex, iteration)
      options.emitProgress(waveIndex)

      const waveResults = await Promise.all(
        wave.map((agentName) =>
          this.#runAgent(
            agentName,
            agentIndex++,
            iteration,
            waveIndex,
            options,
          ),
        ),
      )

      for (const { agentName, result } of waveResults) {
        results.set(agentName, result)
      }
      options.emitProgress(waveIndex)
    }

    return results
  }

  async #prepareWave(
    wave: string[],
    waveIndex: number,
    iteration: number,
  ): Promise<void> {
    await this.#stateTracker.appendOrchestratorLog(
      `Wave ${waveIndex + 1}/${this.#waves.length}: [${wave.join(', ')}]`,
    )

    for (const agentName of wave) {
      await this.#stateTracker.updateAgent(agentName, {
        status: 'waiting',
        iteration,
        wave: waveIndex,
      })
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
    if (agent === undefined) {
      throw new Error(`Unknown swarm agent '${agentName}'`)
    }

    try {
      const executorOptions: SwarmExecutorOptions = {
        workspace: options.workspace,
        swarmName: this.#swarmDefinition.name,
        iteration,
        onProgress: () => {
          options.emitProgress(waveIndex)
        },
        stateTracker: this.#stateTracker,
      }
      const modelOverride = agent.model ?? this.#swarmDefinition.model
      if (modelOverride !== undefined)
        executorOptions.modelOverride = modelOverride
      if (options.signal !== undefined) executorOptions.signal = options.signal
      if (options.modelRegistry !== undefined) {
        executorOptions.modelRegistry = options.modelRegistry
      }
      if (options.settings !== undefined)
        executorOptions.settings = options.settings

      const result = await executeSwarmAgent(
        agent,
        currentIndex,
        executorOptions,
      )
      return { agentName, result }
    } catch (error_) {
      const error = error_ instanceof Error ? error_.message : String(error_)
      return {
        agentName,
        result: {
          index: currentIndex,
          id: `swarm-${this.#swarmDefinition.name}-${agentName}-${iteration}`,
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

  #createResultMap(): Map<string, SingleResult[]> {
    const results = new Map<string, SingleResult[]>()
    for (const name of this.#swarmDefinition.agents.keys()) {
      results.set(name, [])
    }
    return results
  }

  #buildProgressSnapshot(): Record<
    string,
    { status: string; iteration: number }
  > {
    const agents: Record<string, { status: string; iteration: number }> = {}
    for (const [name, state] of Object.entries(
      this.#stateTracker.state.agents,
    )) {
      agents[name] = { status: state.status, iteration: state.iteration }
    }
    return agents
  }
}
