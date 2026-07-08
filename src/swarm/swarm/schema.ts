interface RawSwarmAgentConfig {
  role?: unknown
  task?: unknown
  extra_context?: unknown
  reports_to?: unknown
  waits_for?: unknown
  model?: unknown
}

interface RawSwarmConfig {
  name?: unknown
  workspace?: unknown
  mode?: unknown
  target_count?: unknown
  model?: unknown
  agents?: unknown
}

type SwarmMode = 'pipeline' | 'parallel' | 'sequential'

export interface SwarmAgent {
  name: string
  role: string
  task: string
  extraContext?: string
  reportsTo: string[]
  waitsFor: string[]
  model?: string
}

export interface SwarmDefinition {
  name: string
  workspace: string
  mode: SwarmMode
  targetCount: number
  model?: string
  agents: Map<string, SwarmAgent>
  /** Preserves YAML declaration order for implicit pipeline sequencing. */
  agentOrder: string[]
}

const VALID_MODES: readonly SwarmMode[] = ['pipeline', 'parallel', 'sequential']
const VALID_SWARM_NAME = /^[\w.-]+$/

export function parseSwarmYaml(content: string): SwarmDefinition {
  const swarm = extractRawSwarm(Bun.YAML.parse(content))
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
  const agentEntries = extractAgentEntries(swarm.agents)
  const { agents, agentOrder } = parseAgents(agentEntries)
  const targetCount =
    typeof swarm.target_count === 'number' ? swarm.target_count : 1
  const swarmDefinition: SwarmDefinition = {
    name,
    workspace,
    mode,
    targetCount,
    agents,
    agentOrder,
  }
  if (typeof swarm.model === 'string') {
    swarmDefinition.model = swarm.model.trim()
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

function extractAgentEntries(value: unknown): [string, RawSwarmAgentConfig][] {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error('swarm.agents must contain at least one agent')
  }

  return Object.entries(value).map(([name, config]) => {
    if (!isRecord(config)) {
      throw new Error(`Agent '${name}' must be an object`)
    }
    return [name, config]
  })
}

function parseAgents(entries: [string, RawSwarmAgentConfig][]): {
  agents: Map<string, SwarmAgent>
  agentOrder: string[]
} {
  const agentOrder: string[] = []
  const agents = new Map<string, SwarmAgent>()

  for (const [name, config] of entries) {
    const role = requireString(
      config.role,
      `Agent '${name}': 'role' is required`,
    )
    const task = requireString(
      config.task,
      `Agent '${name}': 'task' is required`,
    )

    agentOrder.push(name)
    const agent: SwarmAgent = {
      name,
      role,
      task: task.trim(),
      reportsTo: stringArray(config.reports_to),
      waitsFor: stringArray(config.waits_for),
    }
    if (typeof config.extra_context === 'string') {
      agent.extraContext = config.extra_context.trim()
    }
    if (typeof config.model === 'string') {
      agent.model = config.model.trim()
    }
    agents.set(name, agent)
  }

  return { agents, agentOrder }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateSwarmDefinition(
  swarmDefinition: SwarmDefinition,
): string[] {
  const errors: string[] = []
  const agentNames = new Set(swarmDefinition.agents.keys())

  validateModel(swarmDefinition.model, 'swarm.model', errors)
  validateAgentReferences(swarmDefinition, agentNames, errors)
  validateTargetCount(swarmDefinition, errors)

  return errors
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

function validateAgentReferences(
  swarmDefinition: SwarmDefinition,
  agentNames: Set<string>,
  errors: string[],
): void {
  for (const [name, agent] of swarmDefinition.agents) {
    validateNamedReferences(
      name,
      'waits_for',
      agent.waitsFor,
      agentNames,
      errors,
    )
    validateNamedReferences(
      name,
      'reports_to',
      agent.reportsTo,
      agentNames,
      errors,
    )
    validateModel(agent.model, `Agent '${name}' model`, errors)
  }
}

function validateNamedReferences(
  name: string,
  field: 'reports_to' | 'waits_for',
  references: string[],
  agentNames: Set<string>,
  errors: string[],
): void {
  for (const reference of references) {
    if (!agentNames.has(reference)) {
      errors.push(`Agent '${name}' ${field} unknown agent '${reference}'`)
    }
    if (reference === name) {
      errors.push(
        `Agent '${name}' cannot ${field === 'waits_for' ? 'wait for' : 'report to'} itself`,
      )
    }
  }
}

function validateTargetCount(
  swarmDefinition: SwarmDefinition,
  errors: string[],
): void {
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
