import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { buildDependencyGraph, collectTransitiveDependents } from './dag'
import {
  findModelRoutingNode,
  type ModelRoutingPlan,
  sliceModelRoutingPlan,
} from './model-routing'
import type {
  SwarmAgent,
  SwarmAgentWorkload,
  SwarmBashNode,
  SwarmDefinition,
  SwarmGraphNode,
  SwarmNodeControl,
} from './schema'

type PipelineStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'
type AgentStatus =
  'pending' | 'waiting' | 'running' | 'completed' | 'failed' | 'stale'
export type BashNodeStatus =
  'pending' | 'waiting' | 'running' | 'completed' | 'failed' | 'stale' | 'idle'
type GraphStatus =
  | 'pending'
  | 'waiting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'stale'

export interface ControlDecisionState {
  action: 'continue' | 'restart' | 'fail'
  signal: string
  at: number
  target?: string
  reason?: string
}

export interface RestartEvent {
  index: number
  iteration: number
  requestedBy: string[]
  targets: string[]
  invalidated: string[]
  reasons: string[]
  createdAt: number
}

export interface AgentState {
  name: string
  status: AgentStatus
  iteration: number
  wave: number
  attempt: number
  model?: string
  resolvedModel?: string
  lastControlDecision?: ControlDecisionState
  startedAt?: number
  completedAt?: number
  error?: string
}

export interface BashNodeState {
  name: string
  status: BashNodeStatus
  iteration: number
  wave: number
  attempt: number
  startedAt?: number
  completedAt?: number
  error?: string
  outputPath?: string
  exitCode?: number
}

export interface GraphState {
  name: string
  status: GraphStatus
  iteration: number
  wave: number
  attempt: number
  lastControlDecision?: ControlDecisionState
  currentRound?: number
  maxRounds?: number
  startedAt?: number
  completedAt?: number
  error?: string
  stateDir?: string
  childState?: SwarmState
}

interface SwarmDefinitionStateSummary {
  name: string
  workspace: string
  mode: string
  targetCount: number
  concurrency: number
  model?: string
  modelRouting?: SwarmDefinition['modelRouting']
  restartPolicy?: {
    maxRestarts: number
    maxRestartsPerTarget: number
    maxNodeAttempts: number
  }
  nodes: SwarmDefinitionNodeSummary[]
}

interface SwarmDefinitionNodeSummaryBase {
  name: string
  type: 'agent' | 'bash' | 'graph'
  waitsFor: string[]
  reportsTo: string[]
  control?: SwarmNodeControl
}

interface SwarmDefinitionAgentNodeSummary extends SwarmDefinitionNodeSummaryBase {
  type: 'agent'
  role: string
  task: string
  model?: string
  workload?: SwarmAgentWorkload
  tools?: string[]
}

interface SwarmDefinitionBashNodeSummary extends SwarmDefinitionNodeSummaryBase {
  type: 'bash'
  command: string
  outputPath: string
  cwd?: string
}

interface SwarmDefinitionGraphNodeSummary extends SwarmDefinitionNodeSummaryBase {
  type: 'graph'
  path?: string
  repeat?: SwarmGraphNode['repeat']
  definition?: SwarmDefinitionStateSummary
}

type SwarmDefinitionNodeSummary =
  | SwarmDefinitionAgentNodeSummary
  | SwarmDefinitionBashNodeSummary
  | SwarmDefinitionGraphNodeSummary

export interface SwarmState {
  name: string
  status: PipelineStatus
  mode: string
  iteration: number
  targetCount: number
  definitionFingerprint: string
  definitionSummary: SwarmDefinitionStateSummary
  modelRoutingPlan?: ModelRoutingPlan
  agents: Record<string, AgentState>
  bashNodes: Record<string, BashNodeState>
  graphs: Record<string, GraphState>
  restartCount: number
  restartTargetCounts: Record<string, number>
  restartHistory: RestartEvent[]
  startedAt: number
  completedAt?: number
}

type PersistedAgentState = Omit<AgentState, 'attempt'> & { attempt?: number }
type PersistedBashNodeState = Omit<BashNodeState, 'attempt'> & {
  attempt?: number
}
type PersistedGraphState = Omit<GraphState, 'attempt'> & { attempt?: number }

interface PersistedSwarmState extends Omit<
  SwarmState,
  | 'agents'
  | 'bashNodes'
  | 'graphs'
  | 'restartCount'
  | 'restartTargetCounts'
  | 'restartHistory'
  | 'definitionFingerprint'
  | 'definitionSummary'
> {
  definitionFingerprint?: string
  definitionSummary?: SwarmDefinitionStateSummary
  agents: Record<string, PersistedAgentState>
  bashNodes?: Record<string, PersistedBashNodeState>
  graphs?: Record<string, PersistedGraphState>
  restartCount?: number
  restartTargetCounts?: Record<string, number>
  restartHistory?: RestartEvent[]
}

export class StateTracker {
  readonly #swarmDir: string
  #state: SwarmState

  constructor(workspaceDirectory: string, name: string) {
    this.#swarmDir = path.join(workspaceDirectory, `.swarm_${name}`)
    this.#state = {
      name,
      status: 'idle',
      mode: 'sequential',
      iteration: 0,
      targetCount: 1,
      definitionFingerprint: '',
      definitionSummary: createEmptyDefinitionSummary(name),
      agents: {},
      bashNodes: {},
      graphs: {},
      restartCount: 0,
      restartTargetCounts: {},
      restartHistory: [],
      startedAt: Date.now(),
    }
  }

  get swarmDir(): string {
    return this.#swarmDir
  }

  get state(): Readonly<SwarmState> {
    return this.#state
  }

  snapshot(): SwarmState {
    return structuredClone(this.#state)
  }

  async init(
    definition: SwarmDefinition,
    modelRoutingPlan?: ModelRoutingPlan,
    graphPath = 'root',
  ): Promise<void> {
    await fs.mkdir(path.join(this.#swarmDir, 'state'), { recursive: true })
    await fs.mkdir(path.join(this.#swarmDir, 'logs'), { recursive: true })
    await fs.mkdir(path.join(this.#swarmDir, 'context'), { recursive: true })

    const definitionSummary = buildDefinitionStateSummary(definition)
    this.#state.name = definition.name
    this.#state.targetCount = definition.targetCount
    this.#state.mode = definition.mode
    this.#state.definitionSummary = definitionSummary
    this.#state.definitionFingerprint =
      buildDefinitionFingerprint(definitionSummary)
    this.#state.status = 'running'
    this.#state.iteration = 0
    this.#state.startedAt = Date.now()
    delete this.#state.completedAt
    this.#state.agents = {}
    this.#state.bashNodes = {}
    this.#state.graphs = {}
    this.#state.restartCount = 0
    this.#state.restartTargetCounts = {}
    this.#state.restartHistory = []
    if (modelRoutingPlan === undefined) {
      delete this.#state.modelRoutingPlan
    } else {
      this.#state.modelRoutingPlan = sliceModelRoutingPlan(
        modelRoutingPlan,
        graphPath,
      )
    }

    for (const name of definition.agents.keys()) {
      const plannedModel =
        modelRoutingPlan === undefined
          ? undefined
          : findModelRoutingNode(modelRoutingPlan, `${graphPath}/${name}`)
              .selectedAlias
      this.#state.agents[name] = {
        name,
        status: 'pending',
        iteration: 0,
        wave: 0,
        attempt: 1,
        ...(plannedModel === undefined ? {} : { model: plannedModel }),
      }
    }

    for (const name of definition.bashNodes.keys()) {
      this.#state.bashNodes[name] = {
        name,
        status: 'pending',
        iteration: 0,
        wave: -1,
        attempt: 1,
      }
    }

    for (const name of definition.graphs.keys()) {
      this.#state.graphs[name] = {
        name,
        status: 'pending',
        iteration: 0,
        wave: 0,
        attempt: 1,
      }
    }

    await this.#persist()
  }

  async updateAgent(name: string, update: Partial<AgentState>): Promise<void> {
    const agent = this.#state.agents[name]
    if (!agent) return
    Object.assign(agent, update)
    await this.#persist()
  }

  async updateBashNode(
    name: string,
    update: Partial<BashNodeState>,
  ): Promise<void> {
    const bashNode = this.#state.bashNodes[name]
    if (!bashNode) return
    Object.assign(bashNode, update)
    await this.#persist()
  }

  async updateGraph(name: string, update: Partial<GraphState>): Promise<void> {
    const graph = this.#state.graphs[name]
    if (!graph) return
    Object.assign(graph, update)
    await this.#persist()
  }

  async updatePipeline(update: Partial<SwarmState>): Promise<void> {
    Object.assign(this.#state, update)
    await this.#persist()
  }

  async markNodesStaleForRestart(
    nodeNames: string[],
    iteration: number,
  ): Promise<void> {
    for (const nodeName of nodeNames) {
      const agent = this.#state.agents[nodeName]
      if (agent !== undefined) {
        this.#state.agents[nodeName] = markAgentStale(agent, iteration)
        continue
      }

      const bashNode = this.#state.bashNodes[nodeName]
      if (bashNode !== undefined) {
        this.#state.bashNodes[nodeName] = markBashNodeStale(bashNode, iteration)
        continue
      }

      const graph = this.#state.graphs[nodeName]
      if (graph !== undefined) {
        this.#state.graphs[nodeName] = markGraphStale(graph, iteration)
      }
    }
    await this.#persist()
  }

  async recordControlDecision(
    nodeName: string,
    decision: ControlDecisionState,
  ): Promise<void> {
    const agent = this.#state.agents[nodeName]
    if (agent !== undefined) {
      this.#state.agents[nodeName] = { ...agent, lastControlDecision: decision }
      await this.#persist()
      return
    }

    const graph = this.#state.graphs[nodeName]
    if (graph !== undefined) {
      this.#state.graphs[nodeName] = { ...graph, lastControlDecision: decision }
      await this.#persist()
    }
  }

  async recordRestart(event: RestartEvent): Promise<void> {
    this.#state.restartHistory = [...this.#state.restartHistory, event]
    this.#state.restartCount = this.#state.restartHistory.length
    this.#state.restartTargetCounts = { ...this.#state.restartTargetCounts }
    for (const target of event.targets) {
      this.#state.restartTargetCounts[target] =
        (this.#state.restartTargetCounts[target] ?? 0) + 1
    }
    await this.#persist()
  }

  async appendNodeLog(nodeName: string, message: string): Promise<void> {
    const logPath = path.join(
      this.#swarmDir,
      'logs',
      `${sanitizeLogName(nodeName)}.log`,
    )
    const timestamp = new Date().toISOString()
    await fs.appendFile(logPath, `[${timestamp}] ${message}\n`)
  }

  async appendGraphLog(graphName: string, message: string): Promise<void> {
    const logPath = path.join(
      this.#swarmDir,
      'logs',
      `${sanitizeLogName(graphName)}.log`,
    )
    const timestamp = new Date().toISOString()
    await fs.appendFile(logPath, `[${timestamp}] ${message}\n`)
  }

  async appendOrchestratorLog(message: string): Promise<void> {
    const logPath = path.join(this.#swarmDir, 'logs', 'orchestrator.log')
    const timestamp = new Date().toISOString()
    await fs.appendFile(logPath, `[${timestamp}] ${message}\n`)
  }

  async prepareForRestart(
    definition: SwarmDefinition,
    startIteration: number,
    settledNodes: readonly string[],
    rerunNodes: readonly string[],
  ): Promise<void> {
    await fs.mkdir(path.join(this.#swarmDir, 'state'), { recursive: true })
    await fs.mkdir(path.join(this.#swarmDir, 'logs'), { recursive: true })
    await fs.mkdir(path.join(this.#swarmDir, 'context'), { recursive: true })

    const definitionSummary = buildDefinitionStateSummary(definition)
    const settled = new Set(settledNodes)
    this.#state.status = 'running'
    this.#state.iteration = startIteration
    this.#state.targetCount = definition.targetCount
    this.#state.mode = definition.mode
    this.#state.definitionSummary = definitionSummary
    this.#state.definitionFingerprint =
      buildDefinitionFingerprint(definitionSummary)
    delete this.#state.completedAt

    for (const nodeName of rerunNodes) {
      if (settled.has(nodeName)) continue
      const agent = definition.agents.get(nodeName)
      if (agent !== undefined) {
        this.#state.agents[nodeName] = createPendingAgentState(
          nodeName,
          this.#state.agents[nodeName],
          startIteration,
        )
        continue
      }

      const bashNode = definition.bashNodes.get(nodeName)
      if (bashNode !== undefined) {
        this.#state.bashNodes[nodeName] = createPendingBashNodeState(
          nodeName,
          this.#state.bashNodes[nodeName],
          startIteration,
        )
        continue
      }

      const graph = definition.graphs.get(nodeName)
      if (graph !== undefined) {
        this.#state.graphs[nodeName] = createPendingGraphState(
          nodeName,
          this.#state.graphs[nodeName],
          startIteration,
        )
      }
    }

    await this.#persist()
  }

  async load(): Promise<SwarmState | undefined> {
    for (const statePath of [
      path.join(this.#swarmDir, 'state', 'pipeline.json'),
      path.join(this.#swarmDir, 'state.json'),
    ]) {
      try {
        const content = await fs.readFile(statePath, 'utf8')
        const parsed: unknown = JSON.parse(content)
        if (!isSwarmState(parsed)) continue
        this.#state = normalizePersistedState(parsed)
        return this.#state
      } catch {
        continue
      }
    }
    return undefined
  }

  async #persist(): Promise<void> {
    const content = JSON.stringify(this.#state, undefined, 2)
    await fs.writeFile(
      path.join(this.#swarmDir, 'state', 'pipeline.json'),
      content,
    )
    await fs.writeFile(path.join(this.#swarmDir, 'state.json'), content)
  }
}

function createPendingAgentState(
  name: string,
  previous: AgentState | undefined,
  iteration: number,
): AgentState {
  return {
    ...createPendingNodeState(name, previous, iteration, 0, 'pending'),
    ...(previous?.model === undefined ? {} : { model: previous.model }),
  }
}

function createPendingBashNodeState(
  name: string,
  previous: BashNodeState | undefined,
  iteration: number,
): BashNodeState {
  return createPendingNodeState(name, previous, iteration, -1, 'pending')
}

function createPendingGraphState(
  name: string,
  previous: GraphState | undefined,
  iteration: number,
): GraphState {
  return createPendingNodeState(name, previous, iteration, 0, 'pending')
}

function createPendingNodeState<
  TStatus extends AgentStatus | BashNodeStatus | GraphStatus,
>(
  name: string,
  previous: AgentState | BashNodeState | GraphState | undefined,
  iteration: number,
  wave: number,
  status: TStatus,
): {
  name: string
  status: TStatus
  iteration: number
  wave: number
  attempt: number
} {
  return {
    name,
    status,
    iteration,
    wave,
    attempt: nextAttempt(previous),
  }
}

function nextAttempt(
  previous: AgentState | BashNodeState | GraphState | undefined,
): number {
  if (previous === undefined) return 1
  return shouldIncrementAttempt(previous.status)
    ? previous.attempt + 1
    : previous.attempt
}

function markAgentStale(agent: AgentState, iteration: number): AgentState {
  return {
    name: agent.name,
    status: 'stale',
    iteration,
    wave: agent.wave,
    attempt: shouldIncrementAttempt(agent.status)
      ? agent.attempt + 1
      : agent.attempt,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.lastControlDecision === undefined
      ? {}
      : { lastControlDecision: agent.lastControlDecision }),
  }
}

function markBashNodeStale(
  bashNode: BashNodeState,
  iteration: number,
): BashNodeState {
  return {
    name: bashNode.name,
    status: 'stale',
    iteration,
    wave: bashNode.wave,
    attempt: shouldIncrementAttempt(bashNode.status)
      ? bashNode.attempt + 1
      : bashNode.attempt,
    ...(bashNode.outputPath === undefined
      ? {}
      : { outputPath: bashNode.outputPath }),
  }
}

function markGraphStale(graph: GraphState, iteration: number): GraphState {
  return {
    name: graph.name,
    status: 'stale',
    iteration,
    wave: graph.wave,
    attempt: shouldIncrementAttempt(graph.status)
      ? graph.attempt + 1
      : graph.attempt,
    ...(graph.lastControlDecision === undefined
      ? {}
      : { lastControlDecision: graph.lastControlDecision }),
  }
}

function shouldIncrementAttempt(
  status: AgentStatus | BashNodeStatus | GraphStatus,
): boolean {
  return status === 'completed' || status === 'failed' || status === 'running'
}

function normalizePersistedState(parsed: PersistedSwarmState): SwarmState {
  const name = parsed.name
  return {
    ...parsed,
    definitionFingerprint: parsed.definitionFingerprint ?? '',
    definitionSummary:
      parsed.definitionSummary ?? createEmptyDefinitionSummary(name),
    graphs: normalizeGraphStates(parsed.graphs ?? {}),
    bashNodes: normalizeBashNodeStates(parsed.bashNodes ?? {}),
    agents: normalizeAgentStates(parsed.agents),
    restartCount: parsed.restartCount ?? 0,
    restartTargetCounts: parsed.restartTargetCounts ?? {},
    restartHistory: parsed.restartHistory ?? [],
    ...(parsed.modelRoutingPlan === undefined
      ? {}
      : { modelRoutingPlan: parsed.modelRoutingPlan }),
  }
}

function normalizeAgentStates(
  agents: Record<string, PersistedAgentState>,
): Record<string, AgentState> {
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      { ...agent, attempt: agent.attempt ?? 1 },
    ]),
  )
}

export interface RestartResumePlan {
  stateTracker: StateTracker
  loadedExistingState: boolean
  alreadyCompleted: boolean
  startIteration: number
  settledNodes: string[]
  rerunNodes: string[]
  invalidatedNodes: string[]
  message: string
}

export async function loadPersistedModelRoutingPlan(
  workspace: string,
  definition: SwarmDefinition,
): Promise<{
  loadedExistingState: boolean
  alreadyCompleted: boolean
  modelRoutingPlan?: ModelRoutingPlan
}> {
  const stateTracker = new StateTracker(workspace, definition.name)
  const loadedState = await stateTracker.load()
  if (loadedState === undefined)
    return { loadedExistingState: false, alreadyCompleted: false }
  if (
    definition.modelRouting !== undefined &&
    loadedState.modelRoutingPlan === undefined
  ) {
    return {
      loadedExistingState: true,
      alreadyCompleted: loadedState.status === 'completed',
    }
  }
  assertRestartFingerprintMatches(stateTracker, loadedState, definition)
  return {
    loadedExistingState: true,
    alreadyCompleted: loadedState.status === 'completed',
    ...(loadedState.modelRoutingPlan === undefined
      ? {}
      : { modelRoutingPlan: loadedState.modelRoutingPlan }),
  }
}

export async function createRestartStateTracker(
  workspace: string,
  definition: SwarmDefinition,
  modelRoutingPlan?: ModelRoutingPlan,
): Promise<RestartResumePlan> {
  const stateTracker = new StateTracker(workspace, definition.name)
  const loadedState = await stateTracker.load()
  const nodeNames = [...definition.nodes.keys()].toSorted(compareStrings)

  if (loadedState === undefined) {
    await stateTracker.init(definition, modelRoutingPlan)
    return createNoStateRestartPlan(stateTracker, nodeNames)
  }

  assertRestartFingerprintMatches(stateTracker, loadedState, definition)
  if (loadedState.status === 'completed') {
    return createCompletedRestartPlan(stateTracker, definition, nodeNames)
  }

  return await createResumableRestartPlan(
    stateTracker,
    definition,
    loadedState,
    nodeNames,
  )
}

function createNoStateRestartPlan(
  stateTracker: StateTracker,
  nodeNames: string[],
): RestartResumePlan {
  return {
    stateTracker,
    loadedExistingState: false,
    alreadyCompleted: false,
    startIteration: 0,
    settledNodes: [],
    rerunNodes: nodeNames,
    invalidatedNodes: [],
    message: 'No prior state found; starting from scratch',
  }
}

function assertRestartFingerprintMatches(
  stateTracker: StateTracker,
  loadedState: SwarmState,
  definition: SwarmDefinition,
): void {
  const currentSummary = buildDefinitionStateSummary(definition)
  const currentFingerprint = buildDefinitionFingerprint(currentSummary)
  if (loadedState.definitionFingerprint.length === 0) {
    throw new Error(
      [
        'Prior swarm state cannot be resumed because the graph has changed or cannot be verified.',
        '  - prior state does not include a DAG fingerprint',
        `  - state dir: ${stateTracker.swarmDir}`,
        'Run `omp-swarm <path-to-yaml>` to start from scratch and overwrite the saved state.',
      ].join('\n'),
    )
  }

  if (loadedState.definitionFingerprint === currentFingerprint) return

  const diffLines = diffDefinitionSummaries(
    loadedState.definitionSummary,
    currentSummary,
  )
  throw new Error(
    [
      'Prior swarm state cannot be resumed because the graph has changed.',
      ...diffLines.map((line) => `  - ${line}`),
      'Run `omp-swarm <path-to-yaml>` to start from scratch and overwrite the saved state.',
    ].join('\n'),
  )
}

function createCompletedRestartPlan(
  stateTracker: StateTracker,
  definition: SwarmDefinition,
  nodeNames: string[],
): RestartResumePlan {
  return {
    stateTracker,
    loadedExistingState: true,
    alreadyCompleted: true,
    startIteration: definition.targetCount,
    settledNodes: nodeNames,
    rerunNodes: [],
    invalidatedNodes: [],
    message: 'Prior state is already completed; nothing to restart',
  }
}

async function createResumableRestartPlan(
  stateTracker: StateTracker,
  definition: SwarmDefinition,
  loadedState: SwarmState,
  nodeNames: string[],
): Promise<RestartResumePlan> {
  const startIteration = Math.min(
    Math.max(loadedState.iteration, 0),
    definition.targetCount - 1,
  )
  const { invalidatedNodes, rerunNodes, settledNodes } = planRestartNodes(
    definition,
    loadedState,
    nodeNames,
    startIteration,
  )

  await stateTracker.prepareForRestart(
    definition,
    startIteration,
    settledNodes,
    rerunNodes,
  )
  await stateTracker.appendOrchestratorLog(
    `Restart prepared: iteration=${startIteration + 1}/${definition.targetCount} settled=[${settledNodes.join(', ')}] rerun=[${rerunNodes.join(', ')}]`,
  )

  return {
    stateTracker,
    loadedExistingState: true,
    alreadyCompleted: false,
    startIteration,
    settledNodes,
    rerunNodes,
    invalidatedNodes,
    message: `Restarting from saved state: settled ${settledNodes.length}, rerun ${rerunNodes.length}`,
  }
}

function planRestartNodes(
  definition: SwarmDefinition,
  loadedState: SwarmState,
  nodeNames: string[],
  startIteration: number,
): {
  invalidatedNodes: string[]
  rerunNodes: string[]
  settledNodes: string[]
} {
  const reusableNodes = nodeNames.filter((name) =>
    isNodeReusable(loadedState, name, startIteration),
  )
  const reusableNodeSet = new Set(reusableNodes)
  const restartRoots = nodeNames.filter((name) => !reusableNodeSet.has(name))
  const dependencies = buildDependencyGraph(definition)
  const invalidatedNodeSet = new Set<string>(restartRoots)
  for (const nodeName of restartRoots) {
    for (const dependent of collectTransitiveDependents(
      dependencies,
      nodeName,
    )) {
      invalidatedNodeSet.add(dependent)
    }
  }

  const invalidatedNodes = [...invalidatedNodeSet].toSorted(compareStrings)
  const settledNodes = reusableNodes.filter(
    (name) => !invalidatedNodeSet.has(name),
  )
  const settledNodeSet = new Set(settledNodes)
  const rerunNodes = nodeNames.filter((name) => !settledNodeSet.has(name))
  return { invalidatedNodes, rerunNodes, settledNodes }
}

export async function createInitializedStateTracker(
  workspace: string,
  definition: SwarmDefinition,
  modelRoutingPlan?: ModelRoutingPlan,
  graphPath = 'root',
): Promise<StateTracker> {
  const stateTracker = new StateTracker(workspace, definition.name)
  await stateTracker.init(definition, modelRoutingPlan, graphPath)
  return stateTracker
}

function normalizeBashNodeStates(
  bashNodes: Record<string, PersistedBashNodeState>,
): Record<string, BashNodeState> {
  return Object.fromEntries(
    Object.entries(bashNodes).map(([name, bashNode]) => [
      name,
      { ...bashNode, attempt: bashNode.attempt ?? 1 },
    ]),
  )
}

function normalizeGraphStates(
  graphs: Record<string, PersistedGraphState>,
): Record<string, GraphState> {
  return Object.fromEntries(
    Object.entries(graphs).map(([name, graph]) => {
      const normalizedGraph: GraphState = {
        ...graph,
        attempt: graph.attempt ?? 1,
      }
      if (graph.childState !== undefined) {
        normalizedGraph.childState = normalizePersistedState(graph.childState)
      }
      return [name, normalizedGraph]
    }),
  )
}
function buildDefinitionStateSummary(
  definition: SwarmDefinition,
): SwarmDefinitionStateSummary {
  return {
    name: definition.name,
    workspace: definition.workspace,
    mode: definition.mode,
    targetCount: definition.targetCount,
    concurrency: definition.concurrency,
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.modelRouting === undefined
      ? {}
      : { modelRouting: definition.modelRouting }),
    ...(definition.restartPolicy === undefined
      ? {}
      : { restartPolicy: definition.restartPolicy }),
    nodes: [...definition.nodes.values()]
      .map((node) => buildNodeSummary(node))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  }
}

function buildDefinitionFingerprint(
  summary: SwarmDefinitionStateSummary,
): string {
  return createHash('sha256').update(JSON.stringify(summary)).digest('hex')
}

function buildNodeSummary(
  node: SwarmAgent | SwarmBashNode | SwarmGraphNode,
): SwarmDefinitionNodeSummary {
  switch (node.type) {
    case 'agent': {
      return buildAgentNodeSummary(node)
    }
    case 'bash': {
      return buildBashNodeSummary(node)
    }
    case 'graph': {
      return buildGraphNodeSummary(node)
    }
  }
}

function buildNodeSummaryBase(
  node: SwarmAgent | SwarmBashNode | SwarmGraphNode,
): Omit<SwarmDefinitionNodeSummaryBase, 'type'> {
  return {
    name: node.name,
    waitsFor: [...node.waitsFor].toSorted(compareStrings),
    reportsTo: [...node.reportsTo].toSorted(compareStrings),
  }
}

function buildControlledNodeSummaryBase(
  node: SwarmAgent | SwarmGraphNode,
): Omit<SwarmDefinitionNodeSummaryBase, 'type'> {
  return {
    ...buildNodeSummaryBase(node),
    ...buildControlSummary(node.control),
  }
}

function buildAgentNodeSummary(
  node: SwarmAgent,
): SwarmDefinitionAgentNodeSummary {
  return {
    ...buildControlledNodeSummaryBase(node),
    type: 'agent',
    role: node.role,
    task: node.task,
    ...(node.model === undefined ? {} : { model: node.model }),
    ...(node.workload === undefined ? {} : { workload: node.workload }),
    ...(node.tools === undefined
      ? {}
      : { tools: [...node.tools].toSorted(compareStrings) }),
  }
}

function buildBashNodeSummary(
  node: SwarmBashNode,
): SwarmDefinitionBashNodeSummary {
  return {
    ...buildNodeSummaryBase(node),
    type: 'bash',
    command: node.command,
    outputPath: node.outputPath,
    ...(node.cwd === undefined ? {} : { cwd: node.cwd }),
  }
}

function buildGraphNodeSummary(
  node: SwarmGraphNode,
): SwarmDefinitionGraphNodeSummary {
  return {
    ...buildControlledNodeSummaryBase(node),
    type: 'graph',
    ...(node.path === undefined ? {} : { path: node.path }),
    ...(node.repeat === undefined ? {} : { repeat: node.repeat }),
    ...(node.definition === undefined
      ? {}
      : { definition: buildDefinitionStateSummary(node.definition) }),
  }
}

function buildControlSummary(control: SwarmNodeControl | undefined): {
  control?: SwarmNodeControl
} {
  if (control === undefined) return {}
  return {
    control: {
      signal: control.signal,
      allowedRestartTargets: [...control.allowedRestartTargets].toSorted(
        compareStrings,
      ),
    },
  }
}

function createEmptyDefinitionSummary(
  name: string,
): SwarmDefinitionStateSummary {
  return {
    name,
    workspace: '',
    mode: '',
    targetCount: 0,
    concurrency: 0,
    nodes: [],
  }
}

function isNodeReusable(
  state: SwarmState,
  nodeName: string,
  iteration: number,
): boolean {
  const node =
    state.agents[nodeName] ??
    state.bashNodes[nodeName] ??
    state.graphs[nodeName]
  return node?.status === 'completed' && node.iteration === iteration
}

const EMPTY_NODE_SUMMARIES: readonly SwarmDefinitionNodeSummary[] = []

function diffDefinitionSummaries(
  prior: SwarmDefinitionStateSummary,
  current: SwarmDefinitionStateSummary,
): string[] {
  const lines: string[] = []
  appendScalarDiffs(lines, '', prior, current, [
    'name',
    'workspace',
    'mode',
    'targetCount',
    'concurrency',
    'model',
    'modelRouting',
    'restartPolicy',
  ])
  appendNodeDiffs(lines, '', prior.nodes, current.nodes)
  return lines.length === 0
    ? ['definition fingerprint changed but no structural diff was available']
    : lines
}

function appendNodeDiffs(
  lines: string[],
  prefix: string,
  priorNodes: readonly SwarmDefinitionNodeSummary[],
  currentNodes: readonly SwarmDefinitionNodeSummary[],
): void {
  const priorByName = new Map(priorNodes.map((node) => [node.name, node]))
  const currentByName = new Map(currentNodes.map((node) => [node.name, node]))
  const names = [
    ...new Set([...priorByName.keys(), ...currentByName.keys()]),
  ].toSorted(compareStrings)

  for (const name of names) {
    appendSingleNodeDiff(
      lines,
      `${prefix}${name}`,
      priorByName.get(name),
      currentByName.get(name),
    )
  }
}

function appendSingleNodeDiff(
  lines: string[],
  nodePath: string,
  prior: SwarmDefinitionNodeSummary | undefined,
  current: SwarmDefinitionNodeSummary | undefined,
): void {
  if (prior === undefined && current !== undefined) {
    lines.push(`node '${nodePath}' added as ${current.type}`)
    return
  }
  if (prior !== undefined && current === undefined) {
    lines.push(`node '${nodePath}' removed (was ${prior.type})`)
    return
  }
  if (prior === undefined || current === undefined) return
  if (prior.type !== current.type) {
    lines.push(
      `node '${nodePath}' type changed: prior ${prior.type}, current ${current.type}`,
    )
    return
  }
  appendMatchingNodeDiff(lines, nodePath, prior, current)
}

function appendMatchingNodeDiff(
  lines: string[],
  nodePath: string,
  prior: SwarmDefinitionNodeSummary,
  current: SwarmDefinitionNodeSummary,
): void {
  appendScalarDiffs(lines, `node '${nodePath}'`, prior, current, [
    'waitsFor',
    'reportsTo',
    'control',
  ])
  appendTypedNodeDiff(lines, nodePath, prior, current)
}

function appendTypedNodeDiff(
  lines: string[],
  nodePath: string,
  prior: SwarmDefinitionNodeSummary,
  current: SwarmDefinitionNodeSummary,
): void {
  if (prior.type === 'agent' && current.type === 'agent') {
    appendAgentNodeDiff(lines, nodePath, prior, current)
    return
  }
  if (prior.type === 'bash' && current.type === 'bash') {
    appendBashNodeDiff(lines, nodePath, prior, current)
    return
  }
  if (prior.type === 'graph' && current.type === 'graph') {
    appendGraphNodeDiff(lines, nodePath, prior, current)
  }
}

function appendAgentNodeDiff(
  lines: string[],
  nodePath: string,
  prior: SwarmDefinitionAgentNodeSummary,
  current: SwarmDefinitionAgentNodeSummary,
): void {
  appendScalarDiffs(lines, `node '${nodePath}'`, prior, current, [
    'role',
    'model',
    'workload',
    'tools',
  ])
  if (prior.task !== current.task) lines.push(`node '${nodePath}' task changed`)
}

function appendBashNodeDiff(
  lines: string[],
  nodePath: string,
  prior: SwarmDefinitionBashNodeSummary,
  current: SwarmDefinitionBashNodeSummary,
): void {
  appendScalarDiffs(lines, `node '${nodePath}'`, prior, current, [
    'cwd',
    'outputPath',
  ])
  if (prior.command !== current.command) {
    lines.push(`node '${nodePath}' command changed`)
  }
}

function appendGraphNodeDiff(
  lines: string[],
  nodePath: string,
  prior: SwarmDefinitionGraphNodeSummary,
  current: SwarmDefinitionGraphNodeSummary,
): void {
  appendScalarDiffs(lines, `node '${nodePath}'`, prior, current, [
    'path',
    'repeat',
  ])
  if (prior.definition !== undefined && current.definition !== undefined) {
    appendScalarDiffs(
      lines,
      `node '${nodePath}' child definition`,
      prior.definition,
      current.definition,
      [
        'name',
        'workspace',
        'mode',
        'targetCount',
        'concurrency',
        'model',
        'modelRouting',
        'restartPolicy',
      ],
    )
  }
  appendNodeDiffs(
    lines,
    `${nodePath}.`,
    prior.definition?.nodes ?? EMPTY_NODE_SUMMARIES,
    current.definition?.nodes ?? EMPTY_NODE_SUMMARIES,
  )
}

function appendScalarDiffs(
  lines: string[],
  prefix: string,
  prior: object,
  current: object,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const priorValue = readObjectField(prior, field)
    const currentValue = readObjectField(current, field)
    const priorJson = JSON.stringify(priorValue)
    const currentJson = JSON.stringify(currentValue)
    if (priorJson === currentJson) continue

    if (prefix.length === 0) {
      lines.push(
        `field '${field}' changed: prior ${priorJson}, current ${currentJson}`,
      )
    } else {
      lines.push(
        `${prefix} ${field} changed: prior ${priorJson}, current ${currentJson}`,
      )
    }
  }
}

function readObjectField(value: object, field: string): unknown {
  return Reflect.get(value, field)
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right)
}

function sanitizeLogName(name: string): string {
  return name.replaceAll(/[^\w.-]/g, '_')
}

function isSwarmState(value: unknown): value is PersistedSwarmState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'status' in value &&
    'agents' in value
  )
}
