import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { buildDependencyGraph, collectTransitiveDependents } from './dag'
import { validateEvidenceReferences } from './evidence'
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
  SwarmNode,
  SwarmNodeControl,
  SwarmResumeContract,
} from './schema'

const CURRENT_SWARM_STATE_VERSION = 2

interface StateRecoveryIssue {
  scope: 'pipeline' | 'node'
  node?: string
  severity: 'normalized' | 'node-invalidated' | 'fatal'
  message: string
}

interface PersistedNodeResult {
  resumeId: string
  nodeType: 'agent' | 'bash' | 'graph'
  contractVersion: number
  stateVersion: number
  inputRefs: Record<string, string>
  outputRefs: Record<string, string>
  executedDefinitionFingerprint: string
}
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
type NodeStatus = AgentStatus | BashNodeStatus | GraphStatus

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

interface NodeStateEvidence {
  result?: PersistedNodeResult
}
export interface AgentState extends NodeStateEvidence {
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

export interface BashNodeState extends NodeStateEvidence {
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

export interface GraphState extends NodeStateEvidence {
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

type NodeState = AgentState | BashNodeState | GraphState

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
  resume: SwarmResumeContract
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
  stateVersion: number
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
  recoveryIssues?: StateRecoveryIssue[]
}

interface PersistedSwarmState {
  name: string
  status: unknown
  mode?: unknown
  iteration?: unknown
  targetCount?: unknown
  definitionFingerprint?: unknown
  definitionSummary?: unknown
  modelRoutingPlan?: ModelRoutingPlan
  agents: unknown
  bashNodes?: unknown
  graphs?: unknown
  restartCount?: unknown
  restartTargetCounts?: unknown
  restartHistory?: unknown
  stateVersion?: unknown
  startedAt?: unknown
  completedAt?: unknown
}

export class StateTracker {
  readonly #swarmDir: string
  #state: SwarmState
  #rawBackupPath?: string

  constructor(workspaceDirectory: string, name: string) {
    this.#swarmDir = path.join(workspaceDirectory, `.swarm_${name}`)
    this.#state = {
      stateVersion: CURRENT_SWARM_STATE_VERSION,
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

  get rawBackupPath(): string | undefined {
    return this.#rawBackupPath
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
    this.#state.stateVersion = CURRENT_SWARM_STATE_VERSION
    delete this.#state.recoveryIssues
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

  async recordNodeResult(
    definition: SwarmDefinition,
    nodeName: string,
    outputReferences: Record<string, string>,
  ): Promise<void> {
    const node = definition.nodes.get(nodeName)
    if (node === undefined) return
    const nodeState = nodeStateFor(this.#state, node)
    if (nodeState === undefined) return
    const inputReferences: Record<string, string> = {}
    for (const dependencyName of buildDependencyGraph(definition).get(
      nodeName,
    ) ?? []) {
      const dependency = definition.nodes.get(dependencyName)
      if (dependency === undefined) continue
      const dependencyResult = nodeStateFor(this.#state, dependency)?.result
      if (!isPersistedNodeResult(dependencyResult)) continue
      inputReferences[dependency.resume.id] = fingerprintReferences(
        dependencyResult.outputRefs,
      )
    }
    nodeState.result = {
      resumeId: node.resume.id,
      nodeType: node.type,
      contractVersion: node.resume.contractVersion,
      stateVersion: node.resume.stateVersion,
      inputRefs: inputReferences,
      outputRefs: outputReferences,
      executedDefinitionFingerprint: buildNodeDefinitionFingerprint(
        buildNodeSummary(node),
      ),
    }
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

  async persistRestartManifest(manifest: RestartManifest): Promise<string> {
    const content = JSON.stringify(manifest, undefined, 2)
    const fingerprint = createHash('sha256').update(content).digest('hex')
    const stateDirectory = path.join(this.#swarmDir, 'state')
    await fs.mkdir(stateDirectory, { recursive: true })
    const manifestPath = path.join(
      stateDirectory,
      `restart-plan-${fingerprint}.json`,
    )
    try {
      await fs.writeFile(manifestPath, content, { flag: 'wx' })
    } catch (error_) {
      const error = normalizeUnknownError(error_)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await fs.writeFile(path.join(stateDirectory, 'restart-plan.json'), content)
    return manifestPath
  }

  async prepareForRestart(
    definition: SwarmDefinition,
    startIteration: number,
    settledNodes: readonly string[],
    rerunNodes: readonly string[],
    modelRoutingPlan?: ModelRoutingPlan,
    graphPath = 'root',
  ): Promise<void> {
    await fs.mkdir(path.join(this.#swarmDir, 'state'), { recursive: true })
    await fs.mkdir(path.join(this.#swarmDir, 'logs'), { recursive: true })
    await fs.mkdir(path.join(this.#swarmDir, 'context'), { recursive: true })

    const definitionSummary = buildDefinitionStateSummary(definition)
    const settled = new Set(settledNodes)
    const rerun = new Set(rerunNodes)
    const previousState = this.snapshot()
    this.#state.status = 'running'
    this.#state.stateVersion = CURRENT_SWARM_STATE_VERSION
    this.#state.iteration = startIteration
    this.#state.targetCount = definition.targetCount
    this.#state.mode = definition.mode
    this.#state.definitionSummary = definitionSummary
    this.#state.definitionFingerprint =
      buildDefinitionFingerprint(definitionSummary)
    delete this.#state.completedAt
    if (modelRoutingPlan === undefined) {
      delete this.#state.modelRoutingPlan
    } else {
      this.#state.modelRoutingPlan = sliceModelRoutingPlan(
        modelRoutingPlan,
        graphPath,
      )
    }

    const rebuilt = rebuildNodeStatesForRestart(
      definition,
      previousState,
      settled,
      startIteration,
      modelRoutingPlan,
      graphPath,
    )
    this.#state.agents = rebuilt.agents
    this.#state.bashNodes = rebuilt.bashNodes
    this.#state.graphs = rebuilt.graphs
    assertRestartPlanCoverage(definition, settled, rerun)
    await this.#persist()
  }

  async load(
    options: { backupRaw?: boolean } = {},
  ): Promise<SwarmState | undefined> {
    const failures: string[] = []
    for (const statePath of [
      path.join(this.#swarmDir, 'state', 'pipeline.json'),
      path.join(this.#swarmDir, 'state.json'),
    ]) {
      const candidate = await this.#loadStateCandidate(
        statePath,
        options.backupRaw === true,
      )
      if (candidate.state !== undefined) return candidate.state
      if (candidate.failure !== undefined) failures.push(candidate.failure)
    }
    if (failures.length > 0) {
      const details = failures.map((failure) => `  - ${failure}`).join('\n')
      throw new Error(
        `Prior swarm state exists but cannot be recovered:\n${details}`,
      )
    }
    return undefined
  }

  async #loadStateCandidate(
    statePath: string,
    backupRaw: boolean,
  ): Promise<{ state?: SwarmState; failure?: string }> {
    let content: string
    try {
      content = await fs.readFile(statePath, 'utf8')
    } catch (error_) {
      const error = normalizeUnknownError(error_)
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? {}
        : { failure: `${statePath}: ${error.message}` }
    }
    try {
      const parsed: unknown = JSON.parse(content)
      if (!isPersistedSwarmEnvelope(parsed)) {
        return { failure: `${statePath}: invalid pipeline envelope` }
      }
      if (backupRaw) {
        this.#rawBackupPath = await this.#backupRawState(content, statePath)
      }
      const issues: StateRecoveryIssue[] = []
      this.#state = normalizePersistedState(parsed, issues)
      if (issues.length > 0) this.#state.recoveryIssues = issues
      return { state: this.#state }
    } catch (error_) {
      const message = normalizeUnknownError(error_).message
      return { failure: `${statePath}: ${message}` }
    }
  }

  async #backupRawState(content: string, statePath: string): Promise<string> {
    const backupDirectory = path.join(this.#swarmDir, 'state', 'backups')
    await fs.mkdir(backupDirectory, { recursive: true })
    const fingerprint = createHash('sha256').update(content).digest('hex')
    const backupPath = path.join(
      backupDirectory,
      `${fingerprint}-${path.basename(statePath)}`,
    )
    try {
      await fs.writeFile(backupPath, content, { flag: 'wx' })
    } catch (error_) {
      const error = normalizeUnknownError(error_)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return backupPath
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

interface RebuiltNodeStates {
  agents: Record<string, AgentState>
  bashNodes: Record<string, BashNodeState>
  graphs: Record<string, GraphState>
}

function rebuildNodeStatesForRestart(
  definition: SwarmDefinition,
  previous: SwarmState,
  settled: ReadonlySet<string>,
  iteration: number,
  modelRoutingPlan: ModelRoutingPlan | undefined,
  graphPath: string,
): RebuiltNodeStates {
  return {
    agents: Object.fromEntries(
      [...definition.agents.entries()].map(([name, node]) => {
        const priorNode = findPriorNode(previous.definitionSummary, node)
        const prior =
          priorNode?.type === 'agent'
            ? previous.agents[priorNode.name]
            : undefined
        if (settled.has(name) && prior !== undefined) {
          return [
            name,
            preparePersistedNodeForReuse(name, node, priorNode, prior),
          ]
        }
        const pending = createPendingAgentState(name, prior, iteration)
        const plannedModel =
          modelRoutingPlan === undefined
            ? undefined
            : findModelRoutingNode(modelRoutingPlan, `${graphPath}/${name}`)
                .selectedAlias
        return [
          name,
          plannedModel === undefined
            ? pending
            : { ...pending, model: plannedModel },
        ]
      }),
    ),
    bashNodes: Object.fromEntries(
      [...definition.bashNodes.entries()].map(([name, node]) => {
        const priorNode = findPriorNode(previous.definitionSummary, node)
        const prior =
          priorNode?.type === 'bash'
            ? previous.bashNodes[priorNode.name]
            : undefined
        return [
          name,
          settled.has(name) && prior !== undefined
            ? preparePersistedNodeForReuse(name, node, priorNode, prior)
            : createPendingBashNodeState(name, prior, iteration),
        ]
      }),
    ),
    graphs: Object.fromEntries(
      [...definition.graphs.entries()].map(([name, node]) => {
        const priorNode = findPriorNode(previous.definitionSummary, node)
        const prior =
          priorNode?.type === 'graph'
            ? previous.graphs[priorNode.name]
            : undefined
        return [
          name,
          settled.has(name) && prior !== undefined
            ? preparePersistedNodeForReuse(name, node, priorNode, prior)
            : createPendingGraphState(name, prior, iteration),
        ]
      }),
    ),
  }
}

function findPriorNode(
  summary: SwarmDefinitionStateSummary,
  node: SwarmNode,
): SwarmDefinitionNodeSummary | undefined {
  return summary.nodes.find(
    (prior) => priorResumeContract(prior).id === node.resume.id,
  )
}

function assertRestartPlanCoverage(
  definition: SwarmDefinition,
  settled: ReadonlySet<string>,
  rerun: ReadonlySet<string>,
): void {
  for (const name of settled) {
    if (rerun.has(name) || !definition.nodes.has(name)) {
      throw new Error(`Invalid restart plan entry '${name}'`)
    }
  }
  for (const name of rerun) {
    if (!definition.nodes.has(name)) {
      throw new Error(`Invalid restart plan entry '${name}'`)
    }
  }
  if (settled.size + rerun.size !== definition.nodes.size) {
    throw new Error('Restart plan does not cover every current DAG node')
  }
}

function preparePersistedNodeForReuse<TState extends NodeState>(
  name: string,
  node: SwarmNode,
  priorNode: SwarmDefinitionNodeSummary | undefined,
  previous: TState,
): TState {
  const priorResult = isPersistedNodeResult(previous.result)
    ? previous.result
    : undefined
  const result: PersistedNodeResult = {
    resumeId: node.resume.id,
    nodeType: node.type,
    contractVersion: node.resume.contractVersion,
    stateVersion: node.resume.stateVersion,
    inputRefs: priorResult?.inputRefs ?? {},
    outputRefs: priorResult?.outputRefs ?? {},
    executedDefinitionFingerprint:
      priorResult?.executedDefinitionFingerprint ??
      buildNodeDefinitionFingerprint(priorNode ?? buildNodeSummary(node)),
  }
  return { ...previous, name, result }
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

function createPendingNodeState<TStatus extends NodeStatus>(
  name: string,
  previous: NodeState | undefined,
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

function shouldIncrementAttempt(status: NodeStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'running'
}

function normalizePersistedState(
  parsed: PersistedSwarmState,
  issues: StateRecoveryIssue[],
): SwarmState {
  const persistedVersion = positiveInteger(parsed.stateVersion) ?? 1
  if (persistedVersion !== CURRENT_SWARM_STATE_VERSION) {
    issues.push({
      scope: 'pipeline',
      severity: 'normalized',
      message: `Migrated state schema ${persistedVersion} to ${CURRENT_SWARM_STATE_VERSION}`,
    })
  }
  return {
    stateVersion: CURRENT_SWARM_STATE_VERSION,
    name: parsed.name,
    ...normalizePipelineScalars(parsed, issues),
    definitionSummary: isDefinitionStateSummary(parsed.definitionSummary)
      ? parsed.definitionSummary
      : createEmptyDefinitionSummary(parsed.name),
    graphs: normalizeGraphStates(parsed.graphs, issues),
    bashNodes: normalizeBashNodeStates(parsed.bashNodes, issues),
    agents: normalizeAgentStates(parsed.agents, issues),
    ...normalizeRestartMetadata(parsed),
    ...(parsed.modelRoutingPlan === undefined
      ? {}
      : { modelRoutingPlan: parsed.modelRoutingPlan }),
    ...(typeof parsed.completedAt === 'number'
      ? { completedAt: parsed.completedAt }
      : {}),
  }
}

function normalizePipelineScalars(
  parsed: PersistedSwarmState,
  issues: StateRecoveryIssue[],
): Pick<
  SwarmState,
  | 'status'
  | 'mode'
  | 'iteration'
  | 'targetCount'
  | 'startedAt'
  | 'definitionFingerprint'
> {
  return {
    status: normalizePipelineStatus(parsed.status, issues),
    mode: normalizePipelineMode(parsed.mode, issues),
    iteration: nonNegativeInteger(parsed.iteration) ?? 0,
    targetCount: positiveInteger(parsed.targetCount) ?? 1,
    startedAt:
      typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
    definitionFingerprint:
      typeof parsed.definitionFingerprint === 'string'
        ? parsed.definitionFingerprint
        : '',
  }
}

function normalizeRestartMetadata(
  parsed: PersistedSwarmState,
): Pick<SwarmState, 'restartCount' | 'restartTargetCounts' | 'restartHistory'> {
  return {
    restartCount: nonNegativeInteger(parsed.restartCount) ?? 0,
    restartTargetCounts: isRecord(parsed.restartTargetCounts)
      ? normalizeCountRecord(parsed.restartTargetCounts)
      : {},
    restartHistory: Array.isArray(parsed.restartHistory)
      ? parsed.restartHistory.filter(isRestartEvent)
      : [],
  }
}

interface DecodedNodeStateBase<TStatus> {
  candidate: Record<string, unknown>
  name: string
  status: TStatus
  iteration: number
  wave: number
  attempt: number
}

function normalizeAgentStates(
  agents: unknown,
  issues: StateRecoveryIssue[],
): Record<string, AgentState> {
  return normalizeNodeStateMap(agents, 'agent', issues, (name, candidate) =>
    decodeAgentState(name, candidate, issues),
  )
}

function normalizeNodeStateMap<TState>(
  value: unknown,
  nodeType: PersistedNodeResult['nodeType'],
  issues: StateRecoveryIssue[],
  decode: (name: string, candidate: unknown) => TState | undefined,
): Record<string, TState> {
  if (!isRecord(value)) {
    issues.push({
      scope: 'pipeline',
      severity: 'normalized',
      message: `Defaulted missing ${nodeType} state map`,
    })
    return {}
  }
  const normalized: Record<string, TState> = {}
  for (const [name, candidate] of Object.entries(value)) {
    const state = decode(name, candidate)
    if (state === undefined) {
      issues.push({
        scope: 'node',
        node: name,
        severity: 'node-invalidated',
        message: `Discarded invalid ${nodeType} state`,
      })
      continue
    }
    normalized[name] = state
  }
  return normalized
}

function decodeAgentState(
  name: string,
  candidate: unknown,
  issues: StateRecoveryIssue[],
): AgentState | undefined {
  const base = decodeNodeStateBase(name, candidate, isAgentStatus)
  if (base === undefined) return undefined
  if (!nodeResultMatchesType(base.candidate, 'agent')) return undefined
  const status = normalizeInterruptedStatus(name, base.status, issues)
  return {
    name,
    status,
    iteration: base.iteration,
    wave: base.wave,
    attempt: base.attempt,
    ...readNodeStateEvidence(base.candidate),
    ...readNodeTimestamps(base.candidate),
    ...readOptionalString(base.candidate, 'model'),
    ...readOptionalString(base.candidate, 'resolvedModel'),
    ...readOptionalString(base.candidate, 'error'),
  }
}

function decodeNodeStateBase<TStatus>(
  name: string,
  candidate: unknown,
  isStatus: (value: unknown) => value is TStatus,
): DecodedNodeStateBase<TStatus> | undefined {
  if (!isRecord(candidate) || !isStatus(candidate['status'])) return undefined
  const iteration = nonNegativeInteger(candidate['iteration'])
  const wave =
    typeof candidate['wave'] === 'number' && Number.isInteger(candidate['wave'])
      ? candidate['wave']
      : undefined
  if (iteration === undefined || wave === undefined) return undefined
  return {
    candidate,
    name,
    status: candidate['status'],
    iteration,
    wave,
    attempt: positiveInteger(candidate['attempt']) ?? 1,
  }
}

function normalizeInterruptedStatus(
  name: string,
  status: AgentStatus,
  issues: StateRecoveryIssue[],
): AgentStatus
function normalizeInterruptedStatus(
  name: string,
  status: BashNodeStatus,
  issues: StateRecoveryIssue[],
): BashNodeStatus
function normalizeInterruptedStatus(
  name: string,
  status: GraphStatus,
  issues: StateRecoveryIssue[],
): GraphStatus
function normalizeInterruptedStatus(
  name: string,
  status: AgentStatus | BashNodeStatus | GraphStatus,
  issues: StateRecoveryIssue[],
): AgentStatus | BashNodeStatus | GraphStatus {
  if (status !== 'running') return status
  issues.push({
    scope: 'node',
    node: name,
    severity: 'normalized',
    message: "Converted crash-interrupted status 'running' to 'stale'",
  })
  return 'stale'
}

function readNodeStateEvidence(
  candidate: Record<string, unknown>,
): NodeStateEvidence {
  return isPersistedNodeResult(candidate['result'])
    ? { result: candidate['result'] }
    : {}
}

function readNodeTimestamps(candidate: Record<string, unknown>): {
  startedAt?: number
  completedAt?: number
} {
  return {
    ...(typeof candidate['startedAt'] === 'number'
      ? { startedAt: candidate['startedAt'] }
      : {}),
    ...(typeof candidate['completedAt'] === 'number'
      ? { completedAt: candidate['completedAt'] }
      : {}),
  }
}

function readOptionalString(
  candidate: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = candidate[key]
  return typeof value === 'string' ? { [key]: value } : {}
}

function normalizePipelineMode(
  mode: unknown,
  issues: StateRecoveryIssue[],
): string {
  if (typeof mode === 'string') return mode
  issues.push({
    scope: 'pipeline',
    severity: 'normalized',
    message: "Defaulted missing pipeline mode to 'sequential'",
  })
  return 'sequential'
}

function nodeResultMatchesType(
  candidate: Record<string, unknown>,
  nodeType: PersistedNodeResult['nodeType'],
): boolean {
  const result = candidate['result']
  return (
    result === undefined ||
    (isPersistedNodeResult(result) && result.nodeType === nodeType)
  )
}

function normalizePipelineStatus(
  status: unknown,
  issues: StateRecoveryIssue[],
): PipelineStatus {
  if (
    status === 'idle' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'aborted'
  ) {
    return status
  }
  issues.push({
    scope: 'pipeline',
    severity: 'normalized',
    message: "Converted invalid pipeline status to 'failed'",
  })
  return 'failed'
}

function isAgentStatus(status: unknown): status is AgentStatus {
  return (
    status === 'pending' ||
    status === 'waiting' ||
    status === 'running' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'stale'
  )
}

function isBashNodeStatus(status: unknown): status is BashNodeStatus {
  return isAgentStatus(status) || status === 'idle'
}

function isGraphStatus(status: unknown): status is GraphStatus {
  return isAgentStatus(status) || status === 'aborted'
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

function normalizeCountRecord(
  value: Record<string, unknown>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, count]) => {
      const normalized = nonNegativeInteger(count)
      return normalized === undefined ? [] : [[name, normalized]]
    }),
  )
}

function isRestartEvent(value: unknown): value is RestartEvent {
  return (
    isRecord(value) &&
    nonNegativeInteger(value['index']) !== undefined &&
    nonNegativeInteger(value['iteration']) !== undefined &&
    Array.isArray(value['requestedBy']) &&
    Array.isArray(value['targets']) &&
    Array.isArray(value['invalidated']) &&
    Array.isArray(value['reasons']) &&
    typeof value['createdAt'] === 'number'
  )
}

function normalizeUnknownError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export type NodeReuseDecision =
  | {
      action: 'reuse'
      basis: 'contract' | 'policy' | 'override'
      warnings: string[]
    }
  | {
      action: 'rerun'
      reason:
        | 'missing-state'
        | 'incomplete'
        | 'state-invalid'
        | 'contract-changed'
        | 'upstream-rerun'
        | 'output-missing'
        | 'workspace-changed'
        | 'explicit-rerun'
    }
  | {
      action: 'migrate'
      fromStateVersion: number
      toStateVersion: number
    }

interface RestartNodeDecision {
  node: string
  resumeId: string
  previousNode?: string
  decision: NodeReuseDecision
}

export interface RestartOverrides {
  reuse?: readonly string[]
  rerun?: readonly string[]
  from?: string
}

interface RestartManifest {
  sourceDefinitionFingerprint?: string
  targetDefinitionFingerprint: string
  createdAt: number
  overrides: {
    reuse: string[]
    rerun: string[]
    from?: string
  }
  decisions: RestartNodeDecision[]
  definitionChanges: string[]
  recoveryIssues: StateRecoveryIssue[]
  rawBackupPath?: string
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
  decisions: RestartNodeDecision[]
  manifestPath?: string
  rawBackupPath?: string
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
  assertPersistedDefinitionIntegrity(stateTracker, loadedState)
  const definitionUnchanged =
    loadedState.definitionFingerprint ===
    buildDefinitionFingerprint(buildDefinitionStateSummary(definition))
  if (
    definition.modelRouting !== undefined &&
    loadedState.modelRoutingPlan === undefined
  ) {
    return {
      loadedExistingState: true,
      alreadyCompleted:
        loadedState.status === 'completed' && definitionUnchanged,
    }
  }
  return {
    loadedExistingState: true,
    alreadyCompleted: loadedState.status === 'completed' && definitionUnchanged,
    ...(loadedState.modelRoutingPlan === undefined
      ? {}
      : { modelRoutingPlan: loadedState.modelRoutingPlan }),
  }
}

export async function createRestartStateTracker(
  workspace: string,
  definition: SwarmDefinition,
  modelRoutingPlan?: ModelRoutingPlan,
  overrides: RestartOverrides = {},
): Promise<RestartResumePlan> {
  const stateTracker = new StateTracker(workspace, definition.name)
  const loadedState = await stateTracker.load({ backupRaw: true })
  const nodeNames = [...definition.nodes.keys()].toSorted(compareStrings)

  if (loadedState === undefined) {
    await stateTracker.init(definition, modelRoutingPlan)
    const decisions = nodeNames.map((node): RestartNodeDecision => ({
      node,
      resumeId: definition.nodes.get(node)?.resume.id ?? node,
      decision: { action: 'rerun', reason: 'missing-state' },
    }))
    const manifestPath = await stateTracker.persistRestartManifest({
      targetDefinitionFingerprint: stateTracker.state.definitionFingerprint,
      createdAt: Date.now(),
      overrides: normalizeOverrides(overrides),
      decisions,
      definitionChanges: [],
      recoveryIssues: [],
    })
    return {
      stateTracker,
      loadedExistingState: false,
      alreadyCompleted: false,
      startIteration: 0,
      settledNodes: [],
      rerunNodes: nodeNames,
      invalidatedNodes: [],
      decisions,
      manifestPath,
      message: 'No prior state found; starting from scratch',
    }
  }

  assertPersistedDefinitionIntegrity(stateTracker, loadedState)
  return await createResumableRestartPlan(
    stateTracker,
    definition,
    loadedState,
    nodeNames,
    modelRoutingPlan,
    overrides,
  )
}

function assertPersistedDefinitionIntegrity(
  stateTracker: StateTracker,
  loadedState: SwarmState,
): void {
  const fingerprint = loadedState.definitionFingerprint
  const summary = loadedState.definitionSummary
  if (
    fingerprint.length > 0 &&
    isDefinitionStateSummary(summary) &&
    fingerprint === buildDefinitionFingerprint(summary)
  ) {
    return
  }

  throw new Error(
    [
      'Prior swarm state cannot be resumed because its saved DAG definition is missing or corrupted.',
      `  - state dir: ${stateTracker.swarmDir}`,
      'The raw state backup was preserved. Start a new run only after inspecting it.',
    ].join('\n'),
  )
}

async function createResumableRestartPlan(
  stateTracker: StateTracker,
  definition: SwarmDefinition,
  loadedState: SwarmState,
  nodeNames: string[],
  modelRoutingPlan: ModelRoutingPlan | undefined,
  overrides: RestartOverrides,
): Promise<RestartResumePlan> {
  const wasCompleted = loadedState.status === 'completed'
  const comparison = compareDefinitions(loadedState, definition)
  const startIteration = Math.min(
    Math.max(loadedState.iteration, 0),
    definition.targetCount - 1,
  )
  const { decisions, invalidatedNodes, rerunNodes, settledNodes } =
    await planRestartNodes(
      definition,
      loadedState,
      nodeNames,
      startIteration,
      overrides,
      path.dirname(stateTracker.swarmDir),
    )
  const needsMoreIterations =
    wasCompleted && definition.targetCount > loadedState.targetCount

  await stateTracker.prepareForRestart(
    definition,
    startIteration,
    settledNodes,
    rerunNodes,
    modelRoutingPlan,
  )
  const alreadyCompleted =
    wasCompleted && rerunNodes.length === 0 && !needsMoreIterations
  if (alreadyCompleted) {
    await stateTracker.updatePipeline({
      status: 'completed',
      completedAt: loadedState.completedAt ?? Date.now(),
    })
  }

  const manifestPath = await persistPreparedRestartManifest(stateTracker, {
    loadedState,
    overrides,
    decisions,
    comparison,
    startIteration,
    targetCount: definition.targetCount,
    settledNodes,
    rerunNodes,
  })

  const message = formatRestartMessage(
    alreadyCompleted,
    comparison.changed,
    settledNodes.length,
    rerunNodes.length,
  )
  return {
    stateTracker,
    loadedExistingState: true,
    alreadyCompleted,
    startIteration: alreadyCompleted ? definition.targetCount : startIteration,
    settledNodes,
    rerunNodes,
    invalidatedNodes,
    decisions,
    manifestPath,
    ...(stateTracker.rawBackupPath === undefined
      ? {}
      : { rawBackupPath: stateTracker.rawBackupPath }),
    message,
  }
}

interface DefinitionComparison {
  sourceFingerprint: string
  targetFingerprint: string
  changed: boolean
  changes: string[]
}

function compareDefinitions(
  loadedState: SwarmState,
  definition: SwarmDefinition,
): DefinitionComparison {
  const priorSummary = structuredClone(loadedState.definitionSummary)
  const currentSummary = buildDefinitionStateSummary(definition)
  const sourceFingerprint = loadedState.definitionFingerprint
  const targetFingerprint = buildDefinitionFingerprint(currentSummary)
  const changed = sourceFingerprint !== targetFingerprint
  return {
    sourceFingerprint,
    targetFingerprint,
    changed,
    changes: changed
      ? diffDefinitionSummaries(priorSummary, currentSummary)
      : [],
  }
}

interface PreparedRestartManifestOptions {
  loadedState: SwarmState
  overrides: RestartOverrides
  decisions: RestartNodeDecision[]
  comparison: DefinitionComparison
  startIteration: number
  targetCount: number
  settledNodes: string[]
  rerunNodes: string[]
}

async function persistPreparedRestartManifest(
  stateTracker: StateTracker,
  options: PreparedRestartManifestOptions,
): Promise<string> {
  const {
    loadedState,
    overrides,
    decisions,
    comparison,
    startIteration,
    targetCount,
    settledNodes,
    rerunNodes,
  } = options
  const manifestPath = await stateTracker.persistRestartManifest({
    sourceDefinitionFingerprint: comparison.sourceFingerprint,
    targetDefinitionFingerprint: comparison.targetFingerprint,
    createdAt: Date.now(),
    overrides: normalizeOverrides(overrides),
    decisions,
    definitionChanges: comparison.changes,
    recoveryIssues: loadedState.recoveryIssues ?? [],
    ...(stateTracker.rawBackupPath === undefined
      ? {}
      : { rawBackupPath: stateTracker.rawBackupPath }),
  })
  await stateTracker.appendOrchestratorLog(
    `Restart prepared: iteration=${startIteration + 1}/${targetCount} settled=[${settledNodes.join(', ')}] rerun=[${rerunNodes.join(', ')}] definitionChanges=${comparison.changes.length} manifest=${manifestPath}`,
  )
  return manifestPath
}

function formatRestartMessage(
  alreadyCompleted: boolean,
  definitionChanged: boolean,
  settledCount: number,
  rerunCount: number,
): string {
  if (alreadyCompleted) {
    return definitionChanged
      ? 'The DAG changed, but every current node is compatible and settled; nothing to restart'
      : 'Prior state is already completed; nothing to restart'
  }
  return definitionChanged
    ? `DAG changed; reusing ${settledCount} compatible completed node(s) and rerunning ${rerunCount}`
    : `Restarting from saved state: settled ${settledCount}, rerun ${rerunCount}`
}

async function planRestartNodes(
  definition: SwarmDefinition,
  loadedState: SwarmState,
  nodeNames: string[],
  startIteration: number,
  overrides: RestartOverrides,
  workspace: string,
): Promise<{
  decisions: RestartNodeDecision[]
  invalidatedNodes: string[]
  rerunNodes: string[]
  settledNodes: string[]
}> {
  const normalizedOverrides = resolveRestartOverrides(definition, overrides)
  const decisions = await Promise.all(
    nodeNames.map(
      async (node) =>
        await evaluateNodeReuse(
          definition,
          loadedState,
          node,
          startIteration,
          normalizedOverrides,
          workspace,
        ),
    ),
  )
  const reusableNodes = decisions
    .filter(
      ({ decision }) =>
        decision.action === 'reuse' || decision.action === 'migrate',
    )
    .map(({ node }) => node)
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

  for (const nodeDecision of decisions) {
    if (
      invalidatedNodeSet.has(nodeDecision.node) &&
      reusableNodeSet.has(nodeDecision.node)
    ) {
      nodeDecision.decision = { action: 'rerun', reason: 'upstream-rerun' }
    }
  }
  const invalidatedNodes = [...invalidatedNodeSet].toSorted(compareStrings)
  const settledNodes = reusableNodes.filter(
    (name) => !invalidatedNodeSet.has(name),
  )
  const settledNodeSet = new Set(settledNodes)
  const rerunNodes = nodeNames.filter((name) => !settledNodeSet.has(name))
  return { decisions, invalidatedNodes, rerunNodes, settledNodes }
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
  bashNodes: unknown,
  issues: StateRecoveryIssue[],
): Record<string, BashNodeState> {
  return normalizeNodeStateMap(bashNodes, 'bash', issues, (name, candidate) =>
    decodeBashNodeState(name, candidate, issues),
  )
}

function decodeBashNodeState(
  name: string,
  candidate: unknown,
  issues: StateRecoveryIssue[],
): BashNodeState | undefined {
  const base = decodeNodeStateBase(name, candidate, isBashNodeStatus)
  if (base === undefined) return undefined
  if (!nodeResultMatchesType(base.candidate, 'bash')) return undefined
  return {
    name,
    status: normalizeInterruptedStatus(name, base.status, issues),
    iteration: base.iteration,
    wave: base.wave,
    attempt: base.attempt,
    ...readNodeStateEvidence(base.candidate),
    ...readNodeTimestamps(base.candidate),
    ...readOptionalString(base.candidate, 'error'),
    ...readOptionalString(base.candidate, 'outputPath'),
    ...(typeof base.candidate['exitCode'] === 'number'
      ? { exitCode: base.candidate['exitCode'] }
      : {}),
  }
}

function normalizeGraphStates(
  graphs: unknown,
  issues: StateRecoveryIssue[],
): Record<string, GraphState> {
  return normalizeNodeStateMap(graphs, 'graph', issues, (name, candidate) =>
    decodeGraphState(name, candidate, issues),
  )
}

function decodeGraphState(
  name: string,
  candidate: unknown,
  issues: StateRecoveryIssue[],
): GraphState | undefined {
  const base = decodeNodeStateBase(name, candidate, isGraphStatus)
  if (base === undefined) return undefined
  if (!nodeResultMatchesType(base.candidate, 'graph')) return undefined
  const currentRound = positiveInteger(base.candidate['currentRound'])
  const maxRounds = positiveInteger(base.candidate['maxRounds'])
  const graph: GraphState = {
    name,
    status: normalizeInterruptedStatus(name, base.status, issues),
    iteration: base.iteration,
    wave: base.wave,
    attempt: base.attempt,
    ...readNodeStateEvidence(base.candidate),
    ...readNodeTimestamps(base.candidate),
    ...readOptionalString(base.candidate, 'error'),
    ...readOptionalString(base.candidate, 'stateDir'),
    ...(currentRound === undefined ? {} : { currentRound }),
    ...(maxRounds === undefined ? {} : { maxRounds }),
  }
  const childState = base.candidate['childState']
  if (childState === undefined) return graph
  if (isPersistedSwarmEnvelope(childState)) {
    graph.childState = normalizePersistedState(childState, issues)
    return graph
  }
  graph.status = 'stale'
  issues.push({
    scope: 'node',
    node: name,
    severity: 'node-invalidated',
    message: 'Discarded malformed child graph state',
  })
  return graph
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
    resume: { ...node.resume },
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

interface ResolvedRestartOverrides {
  reuse: Set<string>
  rerun: Set<string>
}

function normalizeOverrides(overrides: RestartOverrides): {
  reuse: string[]
  rerun: string[]
  from?: string
} {
  return {
    reuse: [...(overrides.reuse ?? [])].toSorted(compareStrings),
    rerun: [...(overrides.rerun ?? [])].toSorted(compareStrings),
    ...(overrides.from === undefined ? {} : { from: overrides.from }),
  }
}

function resolveRestartOverrides(
  definition: SwarmDefinition,
  overrides: RestartOverrides,
): ResolvedRestartOverrides {
  const resolve = (identifier: string): string => {
    if (definition.nodes.has(identifier)) return identifier
    const matched = [...definition.nodes.values()].find(
      (node) => node.resume.id === identifier,
    )
    if (matched !== undefined) return matched.name
    throw new Error(`Restart override references unknown node '${identifier}'`)
  }
  const reuse = new Set(
    (overrides.reuse ?? []).map((identifier) => resolve(identifier)),
  )
  const rerun = new Set(
    (overrides.rerun ?? []).map((identifier) => resolve(identifier)),
  )
  if (overrides.from !== undefined) rerun.add(resolve(overrides.from))
  for (const name of reuse) {
    if (rerun.has(name)) {
      throw new Error(`Restart override cannot both reuse and rerun '${name}'`)
    }
  }
  return { reuse, rerun }
}

type RestartDecisionBase = Omit<RestartNodeDecision, 'decision'>

interface ReuseCandidate {
  base: RestartDecisionBase
  currentNode: SwarmNode
  priorNode: SwarmDefinitionNodeSummary
  result?: PersistedNodeResult
  priorResume: SwarmResumeContract
}

type ReuseCandidateResolution =
  | { ready: true; candidate: ReuseCandidate }
  | { ready: false; decision: RestartNodeDecision }

async function evaluateNodeReuse(
  definition: SwarmDefinition,
  state: SwarmState,
  nodeName: string,
  iteration: number,
  overrides: ResolvedRestartOverrides,
  workspace: string,
): Promise<RestartNodeDecision> {
  const resolved = resolveReuseCandidate(
    definition,
    state,
    nodeName,
    iteration,
    overrides,
  )
  if (!resolved.ready) return resolved.decision
  const { candidate } = resolved
  const ignoredPaths = [...definition.bashNodes.values()].map(
    (node) => node.outputPath,
  )
  const missingOutput = await validatePersistedFiles(
    workspace,
    candidate.result,
    ignoredPaths,
  )
  if (missingOutput) return rerunDecision(candidate.base, 'output-missing')
  const versionDecision = await evaluateVersionCompatibility(
    candidate,
    overrides.reuse.has(nodeName),
    workspace,
    ignoredPaths,
  )
  if (versionDecision !== undefined) return versionDecision
  return await evaluateResumePolicy(
    definition,
    state,
    candidate,
    workspace,
    ignoredPaths,
  )
}

function resolveReuseCandidate(
  definition: SwarmDefinition,
  state: SwarmState,
  nodeName: string,
  iteration: number,
  overrides: ResolvedRestartOverrides,
): ReuseCandidateResolution {
  const currentNode = definition.nodes.get(nodeName)
  if (currentNode === undefined) {
    return {
      ready: false,
      decision: rerunDecision(
        { node: nodeName, resumeId: nodeName },
        'missing-state',
      ),
    }
  }
  const priorNode = findPriorNode(state.definitionSummary, currentNode)
  const base: RestartDecisionBase = {
    node: nodeName,
    resumeId: currentNode.resume.id,
    ...(priorNode === undefined ? {} : { previousNode: priorNode.name }),
  }
  if (overrides.rerun.has(nodeName)) {
    return {
      ready: false,
      decision: rerunDecision(base, 'explicit-rerun'),
    }
  }
  if (priorNode === undefined) {
    return { ready: false, decision: rerunDecision(base, 'missing-state') }
  }
  if (priorNode.type !== currentNode.type) {
    return { ready: false, decision: rerunDecision(base, 'state-invalid') }
  }
  const nodeState = nodeStateFor(state, priorNode)
  if (nodeState === undefined) {
    return { ready: false, decision: rerunDecision(base, 'missing-state') }
  }
  if (nodeState.status !== 'completed' || nodeState.iteration !== iteration) {
    return { ready: false, decision: rerunDecision(base, 'incomplete') }
  }
  return {
    ready: true,
    candidate: {
      base,
      currentNode,
      priorNode,
      priorResume: priorResumeContract(priorNode),
      ...(isPersistedNodeResult(nodeState.result)
        ? { result: nodeState.result }
        : {}),
    },
  }
}

async function validatePersistedFiles(
  workspace: string,
  result: PersistedNodeResult | undefined,
  ignoredPaths: readonly string[],
): Promise<boolean> {
  if (result === undefined) return false
  const fileReferences = Object.fromEntries(
    Object.entries(result.outputRefs).filter(
      ([reference]) => reference !== 'workspace',
    ),
  )
  const status = await validateEvidenceReferences(
    workspace,
    fileReferences,
    ignoredPaths,
  )
  return status !== 'valid'
}

async function evaluateVersionCompatibility(
  candidate: ReuseCandidate,
  forcedReuse: boolean,
  workspace: string,
  ignoredPaths: readonly string[],
): Promise<RestartNodeDecision | undefined> {
  const { base, currentNode, priorResume, result } = candidate
  const stateVersion = result?.stateVersion ?? priorResume.stateVersion
  if (stateVersion !== currentNode.resume.stateVersion) {
    return rerunDecision(base, 'state-invalid')
  }
  if (forcedReuse) {
    return await evaluateForcedReuse(base, result, workspace, ignoredPaths)
  }
  const contractVersion = result?.contractVersion ?? priorResume.contractVersion
  if (contractVersion !== currentNode.resume.contractVersion) {
    return rerunDecision(base, 'contract-changed')
  }
  return undefined
}

async function evaluateForcedReuse(
  base: RestartDecisionBase,
  result: PersistedNodeResult | undefined,
  workspace: string,
  ignoredPaths: readonly string[],
): Promise<RestartNodeDecision> {
  const reason = await validateCompleteEvidence(workspace, result, ignoredPaths)
  return reason === undefined
    ? {
        ...base,
        decision: { action: 'reuse', basis: 'override', warnings: [] },
      }
    : rerunDecision(base, reason)
}

async function evaluateResumePolicy(
  definition: SwarmDefinition,
  state: SwarmState,
  candidate: ReuseCandidate,
  workspace: string,
  ignoredPaths: readonly string[],
): Promise<RestartNodeDecision> {
  const { base, currentNode, priorNode, result } = candidate
  const currentFingerprint = buildNodeDefinitionFingerprint(
    buildNodeSummary(currentNode),
  )
  const executedFingerprint =
    result?.executedDefinitionFingerprint ??
    buildNodeDefinitionFingerprint(priorNode)
  if (currentNode.resume.policy === 'never') {
    return rerunDecision(base, 'explicit-rerun')
  }
  if (currentNode.resume.policy === 'strict') {
    return executedFingerprint === currentFingerprint
      ? {
          ...base,
          decision: { action: 'reuse', basis: 'contract', warnings: [] },
        }
      : rerunDecision(base, 'contract-changed')
  }
  if (currentNode.resume.policy === 'inputs-unchanged') {
    return await evaluateInputCompatibility(
      definition,
      state,
      candidate,
      currentFingerprint,
      executedFingerprint,
      workspace,
      ignoredPaths,
    )
  }
  const warnings =
    executedFingerprint === currentFingerprint
      ? []
      : ['node definition changed; contract version permits reuse']
  if (result === undefined) {
    warnings.push('legacy result has no persisted evidence references')
  }
  return {
    ...base,
    decision: { action: 'reuse', basis: 'policy', warnings },
  }
}

async function evaluateInputCompatibility(
  definition: SwarmDefinition,
  state: SwarmState,
  candidate: ReuseCandidate,
  currentFingerprint: string,
  executedFingerprint: string,
  workspace: string,
  ignoredPaths: readonly string[],
): Promise<RestartNodeDecision> {
  const { base, currentNode, result } = candidate
  if (executedFingerprint !== currentFingerprint) {
    return rerunDecision(base, 'contract-changed')
  }
  if (
    result === undefined ||
    Object.keys(result.outputRefs).length === 0 ||
    !inputReferencesMatch(definition, state, currentNode, result.inputRefs)
  ) {
    return rerunDecision(base, 'output-missing')
  }
  const reason = await validateCompleteEvidence(workspace, result, ignoredPaths)
  return reason === undefined
    ? {
        ...base,
        decision: { action: 'reuse', basis: 'policy', warnings: [] },
      }
    : rerunDecision(base, reason)
}

async function validateCompleteEvidence(
  workspace: string,
  result: PersistedNodeResult | undefined,
  ignoredPaths: readonly string[],
): Promise<'output-missing' | 'workspace-changed' | undefined> {
  if (result === undefined || Object.keys(result.outputRefs).length === 0) {
    return 'output-missing'
  }
  const status = await validateEvidenceReferences(
    workspace,
    result.outputRefs,
    ignoredPaths,
  )
  return status === 'valid' ? undefined : status
}

function rerunDecision(
  base: RestartDecisionBase,
  reason: Extract<NodeReuseDecision, { action: 'rerun' }>['reason'],
): RestartNodeDecision {
  return { ...base, decision: { action: 'rerun', reason } }
}

function priorResumeContract(
  node: SwarmDefinitionNodeSummary,
): SwarmResumeContract {
  const resume: unknown = Reflect.get(node, 'resume')
  if (isRecord(resume)) {
    const id = resume['id']
    const contractVersion = positiveInteger(resume['contractVersion'])
    const stateVersion = positiveInteger(resume['stateVersion'])
    const policy = resume['policy']
    if (
      typeof id === 'string' &&
      contractVersion !== undefined &&
      stateVersion !== undefined &&
      isResumePolicyValue(policy)
    ) {
      return { id, contractVersion, stateVersion, policy }
    }
  }
  return {
    id: node.name,
    contractVersion: 1,
    stateVersion: 1,
    policy: 'preserve',
  }
}

function isResumePolicyValue(
  value: unknown,
): value is SwarmResumeContract['policy'] {
  return (
    value === 'preserve' ||
    value === 'inputs-unchanged' ||
    value === 'never' ||
    value === 'strict'
  )
}

function nodeStateFor(
  state: SwarmState,
  node: Pick<SwarmNode, 'name' | 'type'>,
): NodeState | undefined {
  switch (node.type) {
    case 'agent': {
      return state.agents[node.name]
    }
    case 'bash': {
      return state.bashNodes[node.name]
    }
    case 'graph': {
      return state.graphs[node.name]
    }
  }
}

function inputReferencesMatch(
  definition: SwarmDefinition,
  state: SwarmState,
  node: SwarmNode,
  persistedInputs: Record<string, string>,
): boolean {
  const dependencies = buildDependencyGraph(definition).get(node.name) ?? []
  const expected: Record<string, string> = {}
  for (const dependencyName of dependencies) {
    const dependency = definition.nodes.get(dependencyName)
    if (dependency === undefined) return false
    const prior = state.definitionSummary.nodes.find(
      (candidate) => priorResumeContract(candidate).id === dependency.resume.id,
    )
    if (prior === undefined) return false
    const dependencyResult = nodeStateFor(state, prior)?.result
    if (!isPersistedNodeResult(dependencyResult)) return false
    expected[dependency.resume.id] = fingerprintReferences(
      dependencyResult.outputRefs,
    )
  }
  return JSON.stringify(expected) === JSON.stringify(persistedInputs)
}

function buildNodeDefinitionFingerprint(
  summary: SwarmDefinitionNodeSummary,
): string {
  return createHash('sha256').update(JSON.stringify(summary)).digest('hex')
}

function fingerprintReferences(references: Record<string, string>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(references).toSorted(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    )
    .digest('hex')
}

function isPersistedNodeResult(value: unknown): value is PersistedNodeResult {
  return (
    isRecord(value) &&
    typeof value['resumeId'] === 'string' &&
    (value['nodeType'] === 'agent' ||
      value['nodeType'] === 'bash' ||
      value['nodeType'] === 'graph') &&
    positiveInteger(value['contractVersion']) !== undefined &&
    positiveInteger(value['stateVersion']) !== undefined &&
    isStringRecord(value['inputRefs']) &&
    isStringRecord(value['outputRefs']) &&
    typeof value['executedDefinitionFingerprint'] === 'string'
  )
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

function isDefinitionStateSummary(
  value: unknown,
): value is SwarmDefinitionStateSummary {
  if (!isRecord(value)) return false
  const nodes = value['nodes']
  if (!Array.isArray(nodes)) return false
  const names = new Set<string>()
  for (const node of nodes) {
    if (!isDefinitionStateNodeSummary(node) || names.has(node.name)) {
      return false
    }
    names.add(node.name)
  }
  return true
}

function isDefinitionStateNodeSummary(
  value: unknown,
): value is SwarmDefinitionNodeSummary {
  if (!isRecord(value) || typeof value['name'] !== 'string') return false
  switch (value['type']) {
    case 'agent':
    case 'bash': {
      return true
    }
    case 'graph': {
      return (
        value['definition'] === undefined ||
        isDefinitionStateSummary(value['definition'])
      )
    }
    default: {
      return false
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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
    'resume',
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

function isPersistedSwarmEnvelope(
  value: unknown,
): value is PersistedSwarmState {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    value['name'].length > 0 &&
    'status' in value &&
    'agents' in value
  )
}
