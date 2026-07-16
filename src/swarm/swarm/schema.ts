interface RawSwarmRestartPolicyConfig {
  max_restarts?: unknown
  max_restarts_per_target?: unknown
  max_node_attempts?: unknown
}

interface RawSwarmNodeControlConfig {
  signal?: unknown
  allowed_restart_targets?: unknown
}

interface RawModelUsageEstimateConfig {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_tokens?: unknown
  cache_write_tokens?: unknown
}

interface RawSwarmModelRoutingConfig {
  enabled?: unknown
  allowed_aliases?: unknown
  minimum_quality?: unknown
  max_estimated_cost_usd?: unknown
  allow_zero_marginal_cost?: unknown
  default_usage?: unknown
}

interface RawSwarmAgentWorkloadConfig {
  profile?: unknown
  estimated_usage?: unknown
}

interface RawSwarmAgentConfig {
  type?: unknown
  role?: unknown
  task?: unknown
  extra_context?: unknown
  reports_to?: unknown
  waits_for?: unknown
  model?: unknown
  tools?: unknown
  control?: unknown
  workload?: unknown
  [key: string]: unknown
}

interface RawSwarmBashConfig {
  type?: unknown
  command?: unknown
  output_path?: unknown
  cwd?: unknown
  reports_to?: unknown
  waits_for?: unknown
  [key: string]: unknown
}

interface RawSwarmGraphRepeatConfig {
  max_rounds?: unknown
  stop_signal?: unknown
  success_value?: unknown
  continue_value?: unknown
}

interface RawSwarmGraphConfig {
  type?: unknown
  path?: unknown
  swarm?: unknown
  waits_for?: unknown
  reports_to?: unknown
  repeat?: unknown
  control?: unknown
  [key: string]: unknown
}

type RawSwarmNodeConfig =
  RawSwarmAgentConfig | RawSwarmBashConfig | RawSwarmGraphConfig

interface RawSwarmConfig {
  name?: unknown
  workspace?: unknown
  mode?: unknown
  target_count?: unknown
  concurrency?: unknown
  model?: unknown
  restart_policy?: unknown
  model_routing?: unknown
  nodes?: unknown
}

type SwarmMode = 'pipeline' | 'parallel' | 'sequential'

interface SwarmRestartPolicy {
  maxRestarts: number
  maxRestartsPerTarget: number
  maxNodeAttempts: number
}

export type ModelRoutingQuality = 'economy' | 'standard' | 'premium'

export type SwarmWorkloadProfile =
  'general' | 'implementation' | 'planning' | 'review' | 'design' | 'vision'

export interface ModelUsageEstimate {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface SwarmModelRoutingPolicy {
  enabled: true
  allowedAliases: string[]
  minimumQuality: ModelRoutingQuality
  maxEstimatedCostUsd: number
  allowZeroMarginalCost: boolean
  defaultUsage: ModelUsageEstimate
}

export interface SwarmAgentWorkload {
  profile: SwarmWorkloadProfile
  estimatedUsage?: ModelUsageEstimate
}

export interface SwarmNodeControl {
  signal: string
  allowedRestartTargets: string[]
}

export type SwarmNodeType = 'agent' | 'bash' | 'graph'

export interface SwarmNodeBase {
  name: string
  type: SwarmNodeType
  reportsTo: string[]
  waitsFor: string[]
}

export interface SwarmAgent extends SwarmNodeBase {
  type: 'agent'
  role: string
  task: string
  extraContext?: string
  model?: string
  control?: SwarmNodeControl
  workload?: SwarmAgentWorkload
  tools?: string[]
}

export interface SwarmBashNode extends SwarmNodeBase {
  type: 'bash'
  command: string
  outputPath: string
  cwd?: string
}

export interface SwarmGraphRepeat {
  maxRounds: number
  stopSignal: string
  successValue: string
  continueValue: string
}

export interface SwarmGraphNode extends SwarmNodeBase {
  type: 'graph'
  path?: string
  repeat?: SwarmGraphRepeat
  control?: SwarmNodeControl
  resolvedPath?: string
  definition?: SwarmDefinition
}

export type SwarmNode = SwarmAgent | SwarmBashNode | SwarmGraphNode

export interface SwarmDefinition {
  name: string
  workspace: string
  mode: SwarmMode
  targetCount: number
  concurrency: number
  model?: string
  modelRouting?: SwarmModelRoutingPolicy
  restartPolicy?: SwarmRestartPolicy
  nodes: Map<string, SwarmNode>
  nodeOrder: string[]
  agents: Map<string, SwarmAgent>
  bashNodes: Map<string, SwarmBashNode>
  graphs: Map<string, SwarmGraphNode>
  sourcePath?: string
  sourceDir?: string
}

const VALID_MODES: readonly SwarmMode[] = ['pipeline', 'parallel', 'sequential']
const VALID_SWARM_NAME = /^[\w.-]+$/
const VALID_ROUTING_QUALITIES: readonly ModelRoutingQuality[] = [
  'economy',
  'standard',
  'premium',
]
const VALID_WORKLOAD_PROFILES: readonly SwarmWorkloadProfile[] = [
  'general',
  'implementation',
  'planning',
  'review',
  'design',
  'vision',
]

const MODEL_ROUTING_PROPERTIES: Record<string, true> = {
  enabled: true,
  allowed_aliases: true,
  minimum_quality: true,
  max_estimated_cost_usd: true,
  allow_zero_marginal_cost: true,
  default_usage: true,
}
const WORKLOAD_PROPERTIES: Record<string, true> = {
  profile: true,
  estimated_usage: true,
}
const USAGE_ESTIMATE_PROPERTIES: Record<string, true> = {
  input_tokens: true,
  output_tokens: true,
  cache_read_tokens: true,
  cache_write_tokens: true,
}

export function parseSwarmYaml(content: string): SwarmDefinition {
  return parseSwarmConfig(extractRawSwarm(Bun.YAML.parse(content)))
}

function parseSwarmConfig(swarm: RawSwarmConfig): SwarmDefinition {
  const name = requireString(
    swarm.name,
    'swarm.name is required and must be a string',
  )
  const workspace = requireString(
    swarm.workspace,
    'swarm.workspace is required and must be a string',
  )

  if (!VALID_SWARM_NAME.test(name)) {
    throw new Error(
      'swarm.name may only contain letters, numbers, dot, underscore, and dash',
    )
  }

  const mode = parseMode(swarm.mode)
  const { nodes, nodeOrder, agents, bashNodes, graphs } = parseNodes(
    extractNodeEntries(swarm.nodes),
  )
  const targetCount =
    typeof swarm.target_count === 'number' ? swarm.target_count : 1
  if (typeof swarm.concurrency !== 'number') {
    throw new TypeError('swarm.concurrency is required and must be a number')
  }
  const swarmDefinition: SwarmDefinition = {
    name,
    workspace,
    mode,
    targetCount,
    concurrency: swarm.concurrency,
    nodes,
    nodeOrder,
    agents,
    bashNodes,
    graphs,
  }
  if (typeof swarm.model === 'string') {
    swarmDefinition.model = swarm.model.trim()
  }
  if (swarm.model_routing !== undefined) {
    swarmDefinition.modelRouting = parseModelRoutingPolicy(swarm.model_routing)
  }
  if (swarm.restart_policy !== undefined) {
    swarmDefinition.restartPolicy = parseRestartPolicy(swarm.restart_policy)
  }
  return swarmDefinition
}

function extractRawSwarm(value: unknown): RawSwarmConfig {
  if (!isRecord(value) || !isRecord(value['swarm'])) {
    throw new Error("YAML must have a top-level 'swarm' key")
  }
  return value['swarm']
}

function requireString(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(error)
  return value
}

function parseMode(value: unknown): SwarmMode {
  if (value === undefined) return 'sequential'
  if (isSwarmMode(value)) return value
  const mode = typeof value === 'string' ? value : '<non-string>'
  throw new Error(
    `Invalid mode '${mode}'. Must be one of: ${VALID_MODES.join(', ')}`,
  )
}

function isSwarmMode(value: unknown): value is SwarmMode {
  return value === 'pipeline' || value === 'parallel' || value === 'sequential'
}

function extractNodeEntries(
  value: unknown,
): [string, Record<string, unknown>][] {
  if (
    value === undefined ||
    !isRecord(value) ||
    Object.keys(value).length === 0
  ) {
    throw new Error(
      'swarm.nodes is required and must contain at least one node',
    )
  }

  return Object.entries(value).map(([name, config]) => {
    if (!isRecord(config)) {
      throw new Error(`Node '${name}' must be an object`)
    }
    return [name, config]
  })
}

function parseNodes(entries: [string, RawSwarmNodeConfig][]): {
  nodes: Map<string, SwarmNode>
  nodeOrder: string[]
  agents: Map<string, SwarmAgent>
  bashNodes: Map<string, SwarmBashNode>
  graphs: Map<string, SwarmGraphNode>
} {
  const nodes = new Map<string, SwarmNode>()
  const nodeOrder: string[] = []
  const agents = new Map<string, SwarmAgent>()
  const bashNodes = new Map<string, SwarmBashNode>()
  const graphs = new Map<string, SwarmGraphNode>()

  for (const [name, config] of entries) {
    const type = parseNodeType(name, config.type)
    const node = parseNode(name, type, config)
    nodes.set(name, node)
    nodeOrder.push(name)
    if (node.type === 'agent') agents.set(name, node)
    else if (node.type === 'bash') bashNodes.set(name, node)
    else graphs.set(name, node)
  }

  return { nodes, nodeOrder, agents, bashNodes, graphs }
}

function parseNode(
  name: string,
  type: SwarmNodeType,
  config: RawSwarmNodeConfig,
): SwarmNode {
  switch (type) {
    case 'agent': {
      return parseAgentNode(name, config)
    }
    case 'bash': {
      return parseBashNode(name, config)
    }
    case 'graph': {
      return parseGraphNode(name, config)
    }
  }
}

function parseNodeType(name: string, value: unknown): SwarmNodeType {
  if (value === undefined) throw new Error(`Node '${name}': 'type' is required`)
  if (isSwarmNodeType(value)) return value
  throw new Error(`Node '${name}': 'type' must be one of agent, bash, graph`)
}

function isSwarmNodeType(value: unknown): value is SwarmNodeType {
  return value === 'agent' || value === 'bash' || value === 'graph'
}

function parseAgentNode(name: string, config: RawSwarmAgentConfig): SwarmAgent {
  const role = requireString(config.role, `Agent '${name}': 'role' is required`)
  const task = requireString(config.task, `Agent '${name}': 'task' is required`)
  const agent: SwarmAgent = {
    name,
    type: 'agent',
    role,
    task: task.trim(),
    reportsTo: stringArray(config.reports_to),
    waitsFor: stringArray(config.waits_for),
  }
  const tools = parseAgentTools(name, config.tools)
  if (tools !== undefined) agent.tools = tools
  if (typeof config.extra_context === 'string') {
    agent.extraContext = config.extra_context.trim()
  }
  if (typeof config.model === 'string') {
    agent.model = config.model.trim()
  }
  if (config.workload !== undefined) {
    agent.workload = parseAgentWorkload(name, config.workload)
  }
  if (config.control !== undefined) {
    agent.control = parseNodeControl('Agent', name, config.control)
  }
  return agent
}

function parseAgentTools(name: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined

  const error = `Agent '${name}': 'tools' must be a non-empty array of unique, non-empty strings`
  if (!Array.isArray(value) || value.length === 0) throw new Error(error)

  const tools: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(error)
    const tool = item.trim()
    if (tool.length === 0 || seen.has(tool)) throw new Error(error)
    seen.add(tool)
    tools.push(tool)
  }
  return tools
}

function parseBashNode(
  name: string,
  config: RawSwarmBashConfig,
): SwarmBashNode {
  const command = requireString(
    config.command,
    `Bash node '${name}': 'command' is required`,
  ).trim()
  const outputPath = requireString(
    config.output_path,
    `Bash node '${name}': 'output_path' is required`,
  ).trim()
  if (!isSafeRelativePath(outputPath)) {
    throw new Error(
      `Bash node '${name}' output_path must be a workspace-relative path without '..'`,
    )
  }
  const bashNode: SwarmBashNode = {
    name,
    type: 'bash',
    command,
    outputPath,
    reportsTo: stringArray(config.reports_to),
    waitsFor: stringArray(config.waits_for),
  }
  if (typeof config.cwd === 'string') {
    const cwd = config.cwd.trim()
    if (!isSafeRelativePath(cwd)) {
      throw new Error(
        `Bash node '${name}' cwd must be a workspace-relative path without '..'`,
      )
    }
    bashNode.cwd = cwd
  }
  return bashNode
}

function parseGraphNode(
  name: string,
  config: RawSwarmGraphConfig,
): SwarmGraphNode {
  const graph: SwarmGraphNode = {
    name,
    type: 'graph',
    reportsTo: stringArray(config.reports_to),
    waitsFor: stringArray(config.waits_for),
    ...parseGraphSource(name, config),
  }
  applyGraphOptions(name, config, graph)
  return graph
}

function parseGraphSource(
  name: string,
  config: RawSwarmGraphConfig,
): Pick<SwarmGraphNode, 'path' | 'definition'> {
  const hasPath = config.path !== undefined
  const hasSwarm = config.swarm !== undefined
  if (hasPath === hasSwarm) {
    throw new Error(
      `Graph '${name}' must define exactly one of 'path' or 'swarm'`,
    )
  }
  if (hasPath) return { path: parseGraphPath(name, config.path) }
  return { definition: parseInlineGraphDefinition(name, config.swarm) }
}

function parseGraphPath(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `Graph '${name}' must define exactly one of 'path' or 'swarm'`,
    )
  }
  return value.trim()
}

function parseInlineGraphDefinition(
  name: string,
  value: unknown,
): SwarmDefinition {
  try {
    if (!isRecord(value)) throw new Error("'swarm' must be an object")
    return parseSwarmConfig(value)
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error))
    throw new Error(`Graph '${name}' inline swarm: ${normalizedError.message}`)
  }
}

function applyGraphOptions(
  name: string,
  config: RawSwarmGraphConfig,
  graph: SwarmGraphNode,
): void {
  if (config.repeat !== undefined)
    graph.repeat = parseGraphRepeat(name, config.repeat)
  if (config.control !== undefined)
    graph.control = parseNodeControl('Graph', name, config.control)
}

function parseModelRoutingPolicy(value: unknown): SwarmModelRoutingPolicy {
  if (!isRecord(value)) {
    throw new Error('swarm.model_routing must be an object')
  }
  assertAllowedProperties(
    value,
    MODEL_ROUTING_PROPERTIES,
    'swarm.model_routing',
  )
  const config = value as RawSwarmModelRoutingConfig
  if (config.enabled !== true) {
    throw new Error('swarm.model_routing.enabled must be true')
  }
  const allowedAliases = parseRequiredUniqueStrings(
    config.allowed_aliases,
    'swarm.model_routing.allowed_aliases',
  )
  const minimumQuality = parseEnum(
    config.minimum_quality,
    VALID_ROUTING_QUALITIES,
    'swarm.model_routing.minimum_quality',
  )
  const maxEstimatedCostUsd = numberOrNaN(config.max_estimated_cost_usd)
  if (typeof config.allow_zero_marginal_cost !== 'boolean') {
    throw new TypeError(
      'swarm.model_routing.allow_zero_marginal_cost is required and must be a boolean',
    )
  }
  return {
    enabled: true,
    allowedAliases,
    minimumQuality,
    maxEstimatedCostUsd,
    allowZeroMarginalCost: config.allow_zero_marginal_cost,
    defaultUsage: parseUsageEstimate(
      config.default_usage,
      'swarm.model_routing.default_usage',
    ),
  }
}

function parseAgentWorkload(name: string, value: unknown): SwarmAgentWorkload {
  const label = `Agent '${name}' workload`
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertAllowedProperties(value, WORKLOAD_PROPERTIES, label)
  const config = value as RawSwarmAgentWorkloadConfig
  const workload: SwarmAgentWorkload = {
    profile: parseEnum(
      config.profile,
      VALID_WORKLOAD_PROFILES,
      `${label}.profile`,
    ),
  }
  if (config.estimated_usage !== undefined) {
    workload.estimatedUsage = parseUsageEstimate(
      config.estimated_usage,
      `${label}.estimated_usage`,
    )
  }
  return workload
}

function parseUsageEstimate(value: unknown, label: string): ModelUsageEstimate {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertAllowedProperties(value, USAGE_ESTIMATE_PROPERTIES, label)
  const config = value as RawModelUsageEstimateConfig
  return {
    inputTokens: parseTokenCount(config.input_tokens, `${label}.input_tokens`),
    outputTokens: parseTokenCount(
      config.output_tokens,
      `${label}.output_tokens`,
    ),
    cacheReadTokens: parseTokenCount(
      config.cache_read_tokens,
      `${label}.cache_read_tokens`,
    ),
    cacheWriteTokens: parseTokenCount(
      config.cache_write_tokens,
      `${label}.cache_write_tokens`,
    ),
  }
}

function parseTokenCount(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    throw new TypeError(`${label} is required and must be a number`)
  }
  return value
}

function parseEnum<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string,
): T {
  const match = choices.find((choice) => choice === value)
  if (match !== undefined) return match
  throw new Error(`${label} must be one of ${choices.join(', ')}`)
}

function parseRequiredUniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`)
  }
  const result = value.map((item) =>
    typeof item === 'string' ? item.trim() : '',
  )
  if (
    result.some((item) => item.length === 0) ||
    new Set(result).size !== result.length
  ) {
    throw new Error(`${label} must contain unique, non-empty strings`)
  }
  return result
}

function parseRestartPolicy(value: unknown): SwarmRestartPolicy {
  if (!isRecord(value))
    throw new Error(`swarm.restart_policy must be an object`)
  const config = value as RawSwarmRestartPolicyConfig
  return {
    maxRestarts: numberOrNaN(config.max_restarts),
    maxRestartsPerTarget: numberOrNaN(config.max_restarts_per_target),
    maxNodeAttempts: numberOrNaN(config.max_node_attempts),
  }
}

function parseNodeControl(
  label: 'Agent' | 'Graph',
  name: string,
  value: unknown,
): SwarmNodeControl {
  if (!isRecord(value))
    throw new Error(`${label} '${name}': 'control' must be an object`)
  const config = value as RawSwarmNodeControlConfig
  return {
    signal: typeof config.signal === 'string' ? config.signal.trim() : '',
    allowedRestartTargets: stringArray(config.allowed_restart_targets),
  }
}

function parseGraphRepeat(name: string, value: unknown): SwarmGraphRepeat {
  if (!isRecord(value))
    throw new Error(`Graph '${name}': 'repeat' must be an object`)
  const config = value as RawSwarmGraphRepeatConfig
  return {
    maxRounds:
      typeof config.max_rounds === 'number' ? config.max_rounds : Number.NaN,
    stopSignal: requireString(
      config.stop_signal,
      `Graph '${name}': 'repeat.stop_signal' is required`,
    ).trim(),
    successValue: requireString(
      config.success_value,
      `Graph '${name}': 'repeat.success_value' is required`,
    ).trim(),
    continueValue: requireString(
      config.continue_value,
      `Graph '${name}': 'repeat.continue_value' is required`,
    ).trim(),
  }
}

function numberOrNaN(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function assertAllowedProperties(
  value: Record<string, unknown>,
  allowed: Readonly<Record<string, true>>,
  label: string,
): void {
  const unknownProperty = Object.keys(value).find(
    (key) => !Object.hasOwn(allowed, key),
  )
  if (unknownProperty !== undefined) {
    throw new Error(`${label} contains unknown property '${unknownProperty}'`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateSwarmDefinition(
  swarmDefinition: SwarmDefinition,
): string[] {
  const errors: string[] = []
  const nodeNames = new Set(swarmDefinition.nodes.keys())

  validateModel(swarmDefinition.model, 'swarm.model', errors)
  validateRestartPolicy(swarmDefinition, errors)
  validateNodeReferences(swarmDefinition, nodeNames, errors)
  validateTargetCount(swarmDefinition, errors)
  validateConcurrency(swarmDefinition, errors)
  validateModelRoutingShape(swarmDefinition.modelRouting, errors)
  for (const [name, agent] of swarmDefinition.agents) {
    validateWorkload(agent.workload, `Agent '${name}' workload`, errors)
  }

  return errors
}

function validateModelRoutingShape(
  policy: SwarmModelRoutingPolicy | undefined,
  errors: string[],
): void {
  if (policy === undefined) return
  if (
    !Number.isFinite(policy.maxEstimatedCostUsd) ||
    policy.maxEstimatedCostUsd <= 0
  ) {
    errors.push(
      'swarm.model_routing.max_estimated_cost_usd must be a finite number greater than zero',
    )
  }
  validateUsageEstimate(
    policy.defaultUsage,
    'swarm.model_routing.default_usage',
    errors,
  )
}

function validateWorkload(
  workload: SwarmAgentWorkload | undefined,
  label: string,
  errors: string[],
): void {
  if (workload?.estimatedUsage !== undefined) {
    validateUsageEstimate(
      workload.estimatedUsage,
      `${label}.estimated_usage`,
      errors,
    )
  }
}

function validateUsageEstimate(
  usage: ModelUsageEstimate,
  label: string,
  errors: string[],
): void {
  const buckets: [string, number][] = [
    ['input_tokens', usage.inputTokens],
    ['output_tokens', usage.outputTokens],
    ['cache_read_tokens', usage.cacheReadTokens],
    ['cache_write_tokens', usage.cacheWriteTokens],
  ]
  for (const [name, value] of buckets) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      errors.push(`${label}.${name} must be a finite non-negative integer`)
    }
  }
  if (buckets.every(([, value]) => value === 0)) {
    errors.push(`${label} must contain at least one positive token count`)
  }
}

function validateModel(
  model: string | undefined,
  label: string,
  errors: string[],
): void {
  if (model?.length === 0) {
    errors.push(`${label} must not be empty when provided`)
  }
}

function validateRestartPolicy(
  swarmDefinition: SwarmDefinition,
  errors: string[],
): void {
  const hasControl =
    [...swarmDefinition.agents.values()].some(
      (agent) => agent.control !== undefined,
    ) ||
    [...swarmDefinition.graphs.values()].some(
      (graph) => graph.control !== undefined,
    )
  if (hasControl && swarmDefinition.restartPolicy === undefined) {
    errors.push(
      'swarm.restart_policy is required when any node declares control',
    )
  }

  const policy = swarmDefinition.restartPolicy
  if (policy === undefined) return
  validatePositiveInteger(
    policy.maxRestarts,
    'swarm.restart_policy.max_restarts',
    errors,
  )
  validatePositiveInteger(
    policy.maxRestartsPerTarget,
    'swarm.restart_policy.max_restarts_per_target',
    errors,
  )
  validatePositiveInteger(
    policy.maxNodeAttempts,
    'swarm.restart_policy.max_node_attempts',
    errors,
  )
}

function validateConcurrency(
  swarmDefinition: SwarmDefinition,
  errors: string[],
): void {
  validatePositiveInteger(
    swarmDefinition.concurrency,
    'swarm.concurrency',
    errors,
  )
}

function validatePositiveInteger(
  value: number,
  label: string,
  errors: string[],
): void {
  if (!Number.isInteger(value) || value < 1) {
    errors.push(`${label} must be an integer greater than or equal to 1`)
  }
}

function validateNodeReferences(
  swarmDefinition: SwarmDefinition,
  nodeNames: Set<string>,
  errors: string[],
): void {
  for (const node of swarmDefinition.nodes.values()) {
    validateNamedReferences(
      node.name,
      'waits_for',
      node.waitsFor,
      nodeNames,
      errors,
    )
    validateNamedReferences(
      node.name,
      'reports_to',
      node.reportsTo,
      nodeNames,
      errors,
    )
    if (node.type === 'agent') {
      validateModel(node.model, `Agent '${node.name}' model`, errors)
      validateControl('Agent', node.name, node.control, nodeNames, errors)
    } else if (node.type === 'graph') {
      validateRepeat(node.name, node, errors)
      validateControl('Graph', node.name, node.control, nodeNames, errors)
    }
  }
}

function validateNamedReferences(
  name: string,
  field: 'reports_to' | 'waits_for',
  references: string[],
  nodeNames: Set<string>,
  errors: string[],
): void {
  for (const reference of references) {
    if (!nodeNames.has(reference)) {
      errors.push(`Node '${name}' ${field} unknown node '${reference}'`)
    }
    if (reference === name) {
      errors.push(
        `Node '${name}' cannot ${field === 'waits_for' ? 'wait for' : 'report to'} itself`,
      )
    }
  }
}

function validateRepeat(
  name: string,
  graph: SwarmGraphNode,
  errors: string[],
): void {
  if (graph.repeat === undefined) return
  if (!Number.isInteger(graph.repeat.maxRounds) || graph.repeat.maxRounds < 1) {
    errors.push(
      `Graph '${name}' repeat.max_rounds must be an integer greater than or equal to 1`,
    )
  }
  if (!isSafeRelativePath(graph.repeat.stopSignal)) {
    errors.push(
      `Graph '${name}' repeat.stop_signal must be a workspace-relative path without '..'`,
    )
  }
  if (graph.repeat.successValue.trim().length === 0) {
    errors.push(`Graph '${name}' repeat.success_value must not be empty`)
  }
  if (graph.repeat.continueValue.trim().length === 0) {
    errors.push(`Graph '${name}' repeat.continue_value must not be empty`)
  }
  if (graph.definition !== undefined && graph.definition.targetCount !== 1) {
    errors.push(
      `Graph '${name}' repeat requires imported graph target_count: 1`,
    )
  }
}

function validateControl(
  label: 'Agent' | 'Graph',
  name: string,
  control: SwarmNodeControl | undefined,
  nodeNames: Set<string>,
  errors: string[],
): void {
  if (control === undefined) return
  if (!isSafeRelativePath(control.signal)) {
    errors.push(
      `${label} '${name}' control.signal must be a workspace-relative path without '..'`,
    )
  }
  if (control.allowedRestartTargets.length === 0) {
    errors.push(
      `${label} '${name}' control.allowed_restart_targets must contain at least one node`,
    )
  }
  for (const target of control.allowedRestartTargets) {
    if (!nodeNames.has(target)) {
      errors.push(
        `${label} '${name}' control.allowed_restart_targets unknown node '${target}'`,
      )
    }
  }
}

export function isSafeRelativePath(value: string): boolean {
  if (value.trim().length === 0) return false
  if (value.startsWith('/')) return false
  return !value.split(/[\\/]+/).includes('..')
}

function validateTargetCount(
  swarmDefinition: SwarmDefinition,
  errors: string[],
): void {
  if (!Number.isInteger(swarmDefinition.targetCount)) {
    errors.push('target_count must be an integer')
  }
  if (swarmDefinition.targetCount < 1) {
    errors.push('target_count must be at least 1')
  }
  if (
    swarmDefinition.mode !== 'pipeline' &&
    swarmDefinition.targetCount !== 1
  ) {
    errors.push('target_count is only supported in pipeline mode')
  }
}
