import type { Model } from '@oh-my-pi/pi-ai'
import type {
  ModelRegistry,
  ProviderDiscoveryState,
} from '@oh-my-pi/pi-coding-agent/config/model-registry'
import {
  formatModelStringWithRouting,
  getModelMatchPreferences,
  type ModelMatchPreferences,
  resolveModelRoleValue,
} from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import { MODEL_ROLE_IDS } from '@oh-my-pi/pi-coding-agent/config/model-roles'
import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import {
  AUTO_THINKING,
  parseEffort,
  parseThinkingLevel,
} from '@oh-my-pi/pi-coding-agent/thinking'
import { buildDependencyGraph, collectTransitiveDependents } from './dag'
import type {
  ModelRoutingQuality,
  ModelUsageEstimate,
  SwarmAgent,
  SwarmDefinition,
  SwarmModelRoutingPolicy,
  SwarmWorkloadProfile,
} from './schema'

export interface ModelRoutingPlan {
  version: 1
  createdAt: number
  registryRefresh: {
    strategy: 'online-if-uncached'
    completedAt: number
  }
  rootPolicy: SwarmModelRoutingPolicy
  nodes: ModelRoutingNodePlan[]
  subtreeEstimatedCostUsd: Record<string, number>
  totalEstimatedCostUsd: number
  assumptions: string[]
}

export interface ModelRoutingNodePlan {
  path: string
  source: 'agent-model' | 'swarm-model' | 'automatic'
  profile: SwarmWorkloadProfile
  selectedAlias: string
  plannedModel: string
  thinkingLevel?: string
  requiredCapabilities: string[]
  qualityFloor: ModelRoutingQuality
  reason: string
  usage: ModelUsageEstimate
  catalogRates: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  catalogFreshness: {
    status: 'fresh' | 'stale' | 'unknown'
    providerStatus?: ProviderDiscoveryState['status']
    fetchedAt?: number
  }
  baseEstimatedCostUsd: number
  exposure: {
    iterations: number
    repeatRounds: number
    nodeAttempts: number
    providerAttempts: number
  }
  estimatedCostUsd: number
  assumptions: string[]
}

interface RoutingContext {
  iterations: number
  repeatRounds: number
  nodeAttempts: number
}

interface PricedSelection {
  alias: string
  model: Model
  thinkingLevel?: string
  rates: ModelRoutingNodePlan['catalogRates']
  baseEstimatedCostUsd: number
  estimatedCostUsd: number
  assumptions: string[]
}
const BUILT_IN_ROLE_IDS: readonly string[] = MODEL_ROLE_IDS

const QUALITY_RANK: Record<ModelRoutingQuality, number> = {
  economy: 0,
  standard: 1,
  premium: 2,
}

const ALIAS_QUALITY: Readonly<Record<string, ModelRoutingQuality>> = {
  'pi/tiny': 'economy',
  'pi/smol': 'economy',
  'pi/commit': 'economy',
  'pi/task': 'standard',
  'pi/default': 'standard',
  'pi/slow': 'premium',
  'pi/plan': 'premium',
  'pi/advisor': 'premium',
  'pi/designer': 'premium',
  'pi/vision': 'premium',
}

const GENERIC_ALIASES = ['pi/smol', 'pi/task', 'pi/default', 'pi/slow'] as const
const GENERIC_ALIAS_RANK: Readonly<Record<string, number>> = {
  'pi/smol': 0,
  'pi/task': 1,
  'pi/default': 2,
  'pi/slow': 3,
}

const SPECIALTY_ALIAS: Partial<Record<SwarmWorkloadProfile, string>> = {
  planning: 'pi/plan',
  review: 'pi/advisor',
  design: 'pi/designer',
  vision: 'pi/vision',
}

const PROFILE_REQUIREMENTS: Record<
  SwarmWorkloadProfile,
  { capabilities: string[]; quality: ModelRoutingQuality }
> = {
  general: { capabilities: ['native tools'], quality: 'economy' },
  implementation: { capabilities: ['native tools'], quality: 'standard' },
  planning: {
    capabilities: ['native tools', 'reasoning'],
    quality: 'premium',
  },
  review: {
    capabilities: ['native tools', 'reasoning'],
    quality: 'premium',
  },
  design: {
    capabilities: ['native tools', 'reasoning'],
    quality: 'premium',
  },
  vision: {
    capabilities: ['native tools', 'image input'],
    quality: 'premium',
  },
}

const GLOBAL_ASSUMPTIONS = [
  'All monetary values are estimates in USD; actual provider-billed cost remains authoritative.',
  'Token usage is supplied by the DAG defaults or per-agent workload estimate.',
  'Retries may fail before billable usage, and provider fallback can change actual rates.',
  'Exposure-adjusted estimates apply declared iteration, repeat, restart, and provider-retry upper bounds; they are not exact forecasts.',
]

function formatRoutingErrors(label: string, errors: readonly string[]): string {
  return [label, ...errors.map((error) => `  - ${error}`)].join('\n')
}

export function normalizeModelRoutingCatalogError(error: unknown): Error {
  const cause = error instanceof Error ? error : new Error(String(error))
  return new Error(
    'Unable to refresh the authenticated model catalog for routing. Check OMP authentication and provider settings, then retry.',
    { cause },
  )
}

export function validateModelRoutingPolicies(
  definition: SwarmDefinition,
): string[] {
  const errors: string[] = []
  const rootPolicy = definition.modelRouting
  validateDefinitionRouting(definition, 'root', rootPolicy, rootPolicy, errors)
  return errors
}

export function buildModelRoutingPlan(options: {
  definition: SwarmDefinition
  modelRegistry: ModelRegistry
  settings: Settings
  refreshedAt: number
}): Promise<ModelRoutingPlan> {
  const { definition, modelRegistry, settings, refreshedAt } = options
  const rootPolicy = definition.modelRouting
  if (rootPolicy === undefined) {
    throw new Error(
      'Model planning requires swarm.model_routing.enabled: true at the root.',
    )
  }
  const validationErrors = validateModelRoutingPolicies(definition)
  if (validationErrors.length > 0) {
    throw new Error(
      formatRoutingErrors('Model routing policy errors:', validationErrors),
    )
  }

  const nodes: ModelRoutingNodePlan[] = []
  const subtreeEstimatedCostUsd: Record<string, number> = {}
  const planningErrors: string[] = []
  const providerAttempts = settings.get('retry.enabled')
    ? 1 + Math.max(0, Math.trunc(settings.get('retry.maxRetries')))
    : 1
  const availableModels = modelRegistry.getAvailable()
  const seenPaths = new Set<string>()
  planDefinition({
    definition,
    path: 'root',
    effectivePolicy: rootPolicy,
    modelRegistry,
    settings,
    availableModels,
    providerAttempts,
    context: {
      iterations: definition.targetCount,
      repeatRounds: 1,
      nodeAttempts: 1,
    },
    nodes,
    subtreeEstimatedCostUsd,
    errors: planningErrors,
    seenPaths,
  })

  if (planningErrors.length > 0) {
    throw new Error(
      formatRoutingErrors(
        'Unable to build model routing plan:',
        planningErrors,
      ),
    )
  }

  const totalEstimatedCostUsd = subtreeEstimatedCostUsd['root'] ?? 0
  if (totalEstimatedCostUsd > rootPolicy.maxEstimatedCostUsd) {
    throw new Error(
      `Model routing estimate $${formatCost(totalEstimatedCostUsd)} exceeds root max_estimated_cost_usd $${formatCost(rootPolicy.maxEstimatedCostUsd)}. Increase the cap, reduce token assumptions, or narrow the allowed aliases.`,
    )
  }

  return Promise.resolve({
    version: 1,
    createdAt: Date.now(),
    registryRefresh: {
      strategy: 'online-if-uncached',
      completedAt: refreshedAt,
    },
    rootPolicy,
    nodes: nodes.toSorted((left, right) => left.path.localeCompare(right.path)),
    subtreeEstimatedCostUsd,
    totalEstimatedCostUsd,
    assumptions: [...GLOBAL_ASSUMPTIONS],
  })
}

export function renderModelRoutingPlan(plan: ModelRoutingPlan): string[] {
  const lines = [
    'Model routing plan (estimates; actual provider billing is authoritative)',
    `Root policy: aliases=${plan.rootPolicy.allowedAliases.join(',')} | minimum_quality=${plan.rootPolicy.minimumQuality} | max_estimated_cost_usd=$${formatCost(plan.rootPolicy.maxEstimatedCostUsd)} | allow_zero_marginal_cost=${String(plan.rootPolicy.allowZeroMarginalCost)}`,
  ]
  for (const node of plan.nodes.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const freshness = [
      node.catalogFreshness.status,
      node.catalogFreshness.providerStatus,
      node.catalogFreshness.fetchedAt === undefined
        ? undefined
        : new Date(node.catalogFreshness.fetchedAt).toISOString(),
    ]
      .filter((value) => value !== undefined)
      .join('/')
    lines.push(
      `${node.path} | profile=${node.profile} | source=${node.source} | alias=${node.selectedAlias} | planned=${node.plannedModel} | quality=${node.qualityFloor} | capabilities=${node.requiredCapabilities.join('+')} | base=$${formatCost(node.baseEstimatedCostUsd)} | exposure=${node.exposure.iterations}x${node.exposure.repeatRounds}x${node.exposure.nodeAttempts}x${node.exposure.providerAttempts} | estimate=$${formatCost(node.estimatedCostUsd)} | freshness=${freshness}`,
      `  reason: ${node.reason}`,
      `  usage: input=${node.usage.inputTokens}, output=${node.usage.outputTokens}, cache_read=${node.usage.cacheReadTokens}, cache_write=${node.usage.cacheWriteTokens}`,
      `  rates USD/1M: input=${node.catalogRates.input}, output=${node.catalogRates.output}, cache_read=${node.catalogRates.cacheRead}, cache_write=${node.catalogRates.cacheWrite}`,
    )
    for (const assumption of node.assumptions) {
      lines.push(`  assumption: ${assumption}`)
    }
  }
  lines.push(
    `Total exposure-adjusted estimate: $${formatCost(plan.totalEstimatedCostUsd)}`,
  )
  for (const [path, cost] of Object.entries(
    plan.subtreeEstimatedCostUsd,
  ).toSorted(([left], [right]) => left.localeCompare(right))) {
    lines.push(`Subtree ${path}: $${formatCost(cost)}`)
  }
  for (const assumption of plan.assumptions)
    lines.push(`Assumption: ${assumption}`)
  lines.push(
    `Catalog refresh: ${plan.registryRefresh.strategy} completed ${new Date(plan.registryRefresh.completedAt).toISOString()}`,
  )
  return lines
}

export function findModelRoutingNode(
  plan: ModelRoutingPlan,
  path: string,
): ModelRoutingNodePlan {
  const node = plan.nodes.find((candidate) => candidate.path === path)
  if (node === undefined) {
    throw new Error(`Model routing plan has no entry for agent '${path}'.`)
  }
  return node
}

function hasSupportedRoutingVersion(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'version') === 1
  )
}

export function assertModelRoutingPlanCompatible(
  definition: SwarmDefinition,
  plan: ModelRoutingPlan | undefined,
): asserts plan is ModelRoutingPlan {
  if (plan === undefined) {
    throw new Error(
      'Prior state predates model routing; start a fresh run with `omp-swarm <path-to-yaml>` to create an auditable plan.',
    )
  }
  if (!hasSupportedRoutingVersion(plan)) {
    throw new Error(
      'The persisted model routing plan version is unsupported; start a fresh run with `omp-swarm <path-to-yaml>`.',
    )
  }
  const rootPolicy = definition.modelRouting
  if (
    rootPolicy === undefined ||
    JSON.stringify(plan.rootPolicy) !== JSON.stringify(rootPolicy)
  ) {
    throw new Error(
      'The persisted model routing policy does not match the current DAG; start a fresh run with `omp-swarm <path-to-yaml>`.',
    )
  }
  const errors = collectPlanCompatibilityErrors(definition, plan, rootPolicy)
  if (errors.length > 0) {
    throw new Error(
      `The persisted model routing plan is incompatible with the current DAG: ${errors.join('; ')}. Start a fresh run with \`omp-swarm <path-to-yaml>\`.`,
    )
  }
}

function collectPlanCompatibilityErrors(
  definition: SwarmDefinition,
  plan: ModelRoutingPlan,
  rootPolicy: SwarmModelRoutingPolicy,
): string[] {
  const expected = collectAgentIntents(definition, 'root', rootPolicy)
  const actual = new Map(plan.nodes.map((node) => [node.path, node]))
  const errors =
    actual.size === plan.nodes.length ? [] : ['duplicate agent paths']
  for (const [path, intent] of expected) {
    const node = actual.get(path)
    if (node === undefined) {
      errors.push(`missing agent '${path}'`)
      continue
    }
    const parsed = parseBuiltInAlias(node.selectedAlias)
    if (
      parsed.error !== undefined ||
      !intent.policy.allowedAliases.includes(parsed.baseAlias)
    ) {
      errors.push(`selected alias for '${path}' is no longer allowed`)
    }
    if (node.profile !== intent.profile) {
      errors.push(`workload profile for '${path}' changed`)
    }
    actual.delete(path)
  }
  for (const path of actual.keys()) errors.push(`unexpected agent '${path}'`)
  return errors
}

export function sliceModelRoutingPlan(
  plan: ModelRoutingPlan,
  path: string,
): ModelRoutingPlan {
  const prefix = `${path}/`
  const nodes = plan.nodes.filter((node) => node.path.startsWith(prefix))
  const subtreeEstimatedCostUsd = Object.fromEntries(
    Object.entries(plan.subtreeEstimatedCostUsd).filter(
      ([candidate]) => candidate === path || candidate.startsWith(prefix),
    ),
  )
  return {
    ...plan,
    nodes,
    subtreeEstimatedCostUsd,
    totalEstimatedCostUsd: subtreeEstimatedCostUsd[path] ?? 0,
  }
}

function validateDefinitionRouting(
  definition: SwarmDefinition,
  path: string,
  parentPolicy: SwarmModelRoutingPolicy | undefined,
  rootPolicy: SwarmModelRoutingPolicy | undefined,
  errors: string[],
): void {
  const declaredPolicy = definition.modelRouting
  const source = definition.sourcePath ?? '<inline swarm>'
  validateDeclaredPolicy(
    source,
    path,
    parentPolicy,
    rootPolicy,
    declaredPolicy,
    errors,
  )
  if (declaredPolicy !== undefined) {
    validateAllowedAliases(source, path, declaredPolicy, errors)
  }
  const effectivePolicy = declaredPolicy ?? parentPolicy
  if (effectivePolicy !== undefined) {
    validateEffectiveSelectors(definition, source, path, errors)
    validateRoutingPathSegments(definition, source, path, errors)
  }
  for (const [name, graph] of definition.graphs) {
    if (graph.definition === undefined) continue
    validateDefinitionRouting(
      graph.definition,
      `${path}/${name}`,
      effectivePolicy,
      rootPolicy,
      errors,
    )
  }
}

function validateRoutingPathSegments(
  definition: SwarmDefinition,
  source: string,
  path: string,
  errors: string[],
): void {
  for (const name of definition.nodes.keys()) {
    if (name.includes('/')) {
      errors.push(
        `${source}: ${path}: node name '${name}' cannot contain '/' when model routing is enabled`,
      )
    }
  }
}

function validateDeclaredPolicy(
  source: string,
  path: string,
  parentPolicy: SwarmModelRoutingPolicy | undefined,
  rootPolicy: SwarmModelRoutingPolicy | undefined,
  declaredPolicy: SwarmModelRoutingPolicy | undefined,
  errors: string[],
): void {
  if (
    path !== 'root' &&
    declaredPolicy !== undefined &&
    rootPolicy === undefined
  ) {
    errors.push(
      `${source}: ${path}: child model_routing cannot enable routing when the root does not enable it`,
    )
  }
  if (
    path !== 'root' &&
    declaredPolicy !== undefined &&
    parentPolicy !== undefined
  ) {
    validatePolicyNarrowing(source, path, parentPolicy, declaredPolicy, errors)
  }
}

function validateAllowedAliases(
  source: string,
  path: string,
  policy: SwarmModelRoutingPolicy,
  errors: string[],
): void {
  for (const alias of policy.allowedAliases) {
    const parsed = parseBuiltInAlias(alias, false)
    if (parsed.error !== undefined) {
      errors.push(
        `${source}: ${path}: swarm.model_routing.allowed_aliases entry '${alias}' ${parsed.error}`,
      )
    }
  }
}

function validateEffectiveSelectors(
  definition: SwarmDefinition,
  source: string,
  path: string,
  errors: string[],
): void {
  validateRoutedSelector(
    definition.model,
    `${source}: ${path}: swarm.model`,
    errors,
  )
  for (const [name, agent] of definition.agents) {
    validateRoutedSelector(
      agent.model,
      `${source}: ${path}/${name}: agent model`,
      errors,
    )
  }
}

function validatePolicyNarrowing(
  source: string,
  path: string,
  parent: SwarmModelRoutingPolicy,
  child: SwarmModelRoutingPolicy,
  errors: string[],
): void {
  const prefix = `${source}: ${path}: child model_routing`
  if (
    child.allowedAliases.some((alias) => !parent.allowedAliases.includes(alias))
  ) {
    errors.push(
      `${prefix}.allowed_aliases must be a subset of the parent policy`,
    )
  }
  if (
    QUALITY_RANK[child.minimumQuality] < QUALITY_RANK[parent.minimumQuality]
  ) {
    errors.push(
      `${prefix}.minimum_quality cannot be lower than the parent policy`,
    )
  }
  if (child.maxEstimatedCostUsd > parent.maxEstimatedCostUsd) {
    errors.push(
      `${prefix}.max_estimated_cost_usd cannot exceed the parent policy cap`,
    )
  }
  if (!parent.allowZeroMarginalCost && child.allowZeroMarginalCost) {
    errors.push(
      `${prefix}.allow_zero_marginal_cost cannot widen from false to true`,
    )
  }
  const buckets: [string, number, number][] = [
    [
      'input_tokens',
      parent.defaultUsage.inputTokens,
      child.defaultUsage.inputTokens,
    ],
    [
      'output_tokens',
      parent.defaultUsage.outputTokens,
      child.defaultUsage.outputTokens,
    ],
    [
      'cache_read_tokens',
      parent.defaultUsage.cacheReadTokens,
      child.defaultUsage.cacheReadTokens,
    ],
    [
      'cache_write_tokens',
      parent.defaultUsage.cacheWriteTokens,
      child.defaultUsage.cacheWriteTokens,
    ],
  ]
  for (const [name, parentValue, childValue] of buckets) {
    if (childValue < parentValue) {
      errors.push(
        `${prefix}.default_usage.${name} cannot shrink below the parent`,
      )
    }
  }
}

function validateRoutedSelector(
  selector: string | undefined,
  label: string,
  errors: string[],
): void {
  if (selector === undefined) return
  const parsed = parseBuiltInAlias(selector)
  if (parsed.error !== undefined)
    errors.push(`${label} '${selector}' ${parsed.error}`)
}

function parseBuiltInAlias(
  selector: string,
  allowThinking = true,
): { baseAlias: string; suffix?: string; error?: string } {
  const colon = selector.lastIndexOf(':')
  const baseAlias = colon === -1 ? selector : selector.slice(0, colon)
  const suffix = colon === -1 ? undefined : selector.slice(colon + 1)
  if (!baseAlias.startsWith('pi/')) {
    return { baseAlias, error: 'must be a built-in pi/<role> alias' }
  }
  const role = baseAlias.slice(3)
  if (!BUILT_IN_ROLE_IDS.includes(role)) {
    return { baseAlias, error: 'must name a built-in OMP role alias' }
  }
  const suffixError = validateThinkingSuffix(suffix, allowThinking)
  if (suffixError !== undefined) {
    return {
      baseAlias,
      ...(suffix === undefined ? {} : { suffix }),
      error: suffixError,
    }
  }
  return suffix === undefined ? { baseAlias } : { baseAlias, suffix }
}

function validateThinkingSuffix(
  suffix: string | undefined,
  allowThinking: boolean,
): string | undefined {
  if (suffix === undefined) return undefined
  if (!allowThinking) return 'must not include a thinking suffix'
  const valid =
    parseThinkingLevel(suffix) !== undefined ||
    parseEffort(suffix) !== undefined ||
    suffix === 'max' ||
    suffix === AUTO_THINKING
  return valid ? undefined : `has unsupported thinking suffix '${suffix}'`
}

interface PlanDefinitionOptions {
  definition: SwarmDefinition
  path: string
  effectivePolicy: SwarmModelRoutingPolicy
  modelRegistry: ModelRegistry
  settings: Settings
  availableModels: Model[]
  providerAttempts: number
  context: RoutingContext
  nodes: ModelRoutingNodePlan[]
  subtreeEstimatedCostUsd: Record<string, number>
  errors: string[]
  seenPaths: Set<string>
}

function planDefinition(options: PlanDefinitionOptions): number {
  const localPolicy = options.definition.modelRouting ?? options.effectivePolicy
  const invalidatableNodes = collectInvalidatableNodes(options.definition)
  const subtreeCost =
    planLocalAgents(options, localPolicy, invalidatableNodes) +
    planChildGraphs(options, localPolicy, invalidatableNodes)
  options.subtreeEstimatedCostUsd[options.path] = subtreeCost
  if (subtreeCost > localPolicy.maxEstimatedCostUsd) {
    options.errors.push(
      `${options.definition.sourcePath ?? '<inline swarm>'}: ${options.path}: subtree estimate $${formatCost(subtreeCost)} exceeds max_estimated_cost_usd $${formatCost(localPolicy.maxEstimatedCostUsd)}`,
    )
  }
  return subtreeCost
}

function planLocalAgents(
  options: PlanDefinitionOptions,
  policy: SwarmModelRoutingPolicy,
  invalidatableNodes: ReadonlySet<string>,
): number {
  let cost = 0
  for (const [name, agent] of options.definition.agents) {
    const agentPath = `${options.path}/${name}`
    if (options.seenPaths.has(agentPath)) {
      options.errors.push(
        `${options.definition.sourcePath ?? '<inline swarm>'}: duplicate qualified agent path '${agentPath}'`,
      )
      continue
    }
    options.seenPaths.add(agentPath)
    const invalidationAttempts = invalidatableNodes.has(name)
      ? (options.definition.restartPolicy?.maxNodeAttempts ?? 1)
      : 1
    const plan = planAgent({
      agent,
      agentPath,
      definition: options.definition,
      policy,
      modelRegistry: options.modelRegistry,
      settings: options.settings,
      availableModels: options.availableModels,
      exposure: {
        iterations: options.context.iterations,
        repeatRounds: options.context.repeatRounds,
        nodeAttempts: options.context.nodeAttempts * invalidationAttempts,
        providerAttempts: options.providerAttempts,
      },
      errors: options.errors,
    })
    if (plan === undefined) continue
    options.nodes.push(plan)
    cost += plan.estimatedCostUsd
  }
  return cost
}

function planChildGraphs(
  options: PlanDefinitionOptions,
  policy: SwarmModelRoutingPolicy,
  invalidatableNodes: ReadonlySet<string>,
): number {
  let cost = 0
  for (const [name, graph] of options.definition.graphs) {
    if (graph.definition === undefined) continue
    const graphInvalidationAttempts = invalidatableNodes.has(name)
      ? (options.definition.restartPolicy?.maxNodeAttempts ?? 1)
      : 1
    cost += planDefinition({
      ...options,
      definition: graph.definition,
      path: `${options.path}/${name}`,
      effectivePolicy: graph.definition.modelRouting ?? policy,
      context: {
        iterations: options.context.iterations * graph.definition.targetCount,
        repeatRounds:
          options.context.repeatRounds * (graph.repeat?.maxRounds ?? 1),
        nodeAttempts: options.context.nodeAttempts * graphInvalidationAttempts,
      },
    })
  }
  return cost
}

interface PlanAgentOptions {
  agent: SwarmAgent
  agentPath: string
  definition: SwarmDefinition
  policy: SwarmModelRoutingPolicy
  modelRegistry: ModelRegistry
  settings: Settings
  availableModels: Model[]
  exposure: ModelRoutingNodePlan['exposure']
  errors: string[]
}

interface AgentRoutingIntent {
  profile: SwarmWorkloadProfile
  usage: ModelUsageEstimate
  requirements: (typeof PROFILE_REQUIREMENTS)[SwarmWorkloadProfile]
  qualityFloor: ModelRoutingQuality
  source: ModelRoutingNodePlan['source']
  candidateAliases: string[]
}

function planAgent(
  options: PlanAgentOptions,
): ModelRoutingNodePlan | undefined {
  const intent = buildAgentRoutingIntent(
    options.agent,
    options.definition,
    options.policy,
  )
  const matchPreferences = getModelMatchPreferences(options.settings)
  const rejected: string[] = []
  const selections: PricedSelection[] = []
  for (const alias of intent.candidateAliases) {
    const result = evaluateCandidate(alias, intent, options, matchPreferences)
    if ('rejection' in result) rejected.push(`${alias}: ${result.rejection}`)
    else selections.push(result.selection)
  }
  selections.sort(comparePricedSelections)
  const selected = selections[0]
  if (selected === undefined) {
    options.errors.push(
      `${options.definition.sourcePath ?? '<inline swarm>'}: ${options.agentPath}: profile '${intent.profile}' has no eligible model; attempted ${intent.candidateAliases.join(', ')} (${rejected.join('; ')})`,
    )
    return undefined
  }
  return buildNodePlan(options, intent, selected)
}

function buildAgentRoutingIntent(
  agent: SwarmAgent,
  definition: SwarmDefinition,
  policy: SwarmModelRoutingPolicy,
): AgentRoutingIntent {
  const profile = agent.workload?.profile ?? 'general'
  const requirements = PROFILE_REQUIREMENTS[profile]
  const qualityFloor =
    QUALITY_RANK[requirements.quality] >= QUALITY_RANK[policy.minimumQuality]
      ? requirements.quality
      : policy.minimumQuality
  const specialtyAlias = SPECIALTY_ALIAS[profile]
  let explicitSelector = agent.model
  explicitSelector ??= specialtyAlias
  explicitSelector ??= definition.model
  const source = selectAgentModelSource(
    agent.model,
    specialtyAlias,
    definition.model,
  )
  return {
    profile,
    usage: agent.workload?.estimatedUsage ?? policy.defaultUsage,
    requirements,
    qualityFloor,
    source,
    candidateAliases:
      explicitSelector === undefined
        ? [...GENERIC_ALIASES]
        : [explicitSelector],
  }
}

function selectAgentModelSource(
  agentModel: string | undefined,
  specialtyAlias: string | undefined,
  swarmModel: string | undefined,
): ModelRoutingNodePlan['source'] {
  if (agentModel !== undefined) return 'agent-model'
  if (specialtyAlias === undefined && swarmModel !== undefined) {
    return 'swarm-model'
  }
  return 'automatic'
}

function evaluateCandidate(
  alias: string,
  intent: AgentRoutingIntent,
  options: PlanAgentOptions,
  matchPreferences: ModelMatchPreferences,
): { selection: PricedSelection } | { rejection: string } {
  const parsed = parseBuiltInAlias(alias)
  if (
    parsed.error !== undefined ||
    !options.policy.allowedAliases.includes(parsed.baseAlias)
  ) {
    return { rejection: 'not allowed by policy' }
  }
  const resolved = resolveModelRoleValue(alias, options.availableModels, {
    settings: options.settings,
    matchPreferences,
  })
  if (resolved.model === undefined) {
    return { rejection: 'no authenticated available model resolved' }
  }
  const capabilityError = validateCapabilities(resolved.model, intent.profile)
  if (capabilityError !== undefined) return { rejection: capabilityError }
  const aliasQuality = ALIAS_QUALITY[parsed.baseAlias]
  if (
    aliasQuality === undefined ||
    QUALITY_RANK[aliasQuality] < QUALITY_RANK[intent.qualityFloor]
  ) {
    return {
      rejection: `quality ${aliasQuality ?? 'unknown'} is below ${intent.qualityFloor}`,
    }
  }
  const priced = priceSelection(
    alias,
    resolved.model,
    resolved.thinkingLevel,
    intent.usage,
    options.policy,
    options.exposure,
  )
  return priced.error === undefined
    ? { selection: priced.selection }
    : { rejection: priced.error }
}

function comparePricedSelections(
  left: PricedSelection,
  right: PricedSelection,
): number {
  const costDifference = left.estimatedCostUsd - right.estimatedCostUsd
  if (costDifference !== 0) return costDifference
  const leftAlias = parseBuiltInAlias(left.alias).baseAlias
  const rightAlias = parseBuiltInAlias(right.alias).baseAlias
  const aliasDifference =
    (GENERIC_ALIAS_RANK[leftAlias] ?? Number.MAX_SAFE_INTEGER) -
    (GENERIC_ALIAS_RANK[rightAlias] ?? Number.MAX_SAFE_INTEGER)
  if (aliasDifference !== 0) return aliasDifference
  return formatModelStringWithRouting(left.model).localeCompare(
    formatModelStringWithRouting(right.model),
  )
}

function buildNodePlan(
  options: PlanAgentOptions,
  intent: AgentRoutingIntent,
  selected: PricedSelection,
): ModelRoutingNodePlan {
  return {
    path: options.agentPath,
    source: intent.source,
    profile: intent.profile,
    selectedAlias: selected.alias,
    plannedModel: formatModelStringWithRouting(selected.model),
    ...(selected.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: selected.thinkingLevel }),
    requiredCapabilities: [...intent.requirements.capabilities],
    qualityFloor: intent.qualityFloor,
    reason: `${selected.alias} satisfies ${intent.profile} capabilities and ${intent.qualityFloor} quality with the lowest eligible exposure-adjusted estimate`,
    usage: { ...intent.usage },
    catalogRates: selected.rates,
    catalogFreshness: catalogFreshness(
      options.modelRegistry,
      selected.model.provider,
    ),
    baseEstimatedCostUsd: selected.baseEstimatedCostUsd,
    exposure: options.exposure,
    estimatedCostUsd: selected.estimatedCostUsd,
    assumptions: selected.assumptions,
  }
}

function validateCapabilities(
  model: Model,
  profile: SwarmWorkloadProfile,
): string | undefined {
  if (model.supportsTools === false) return 'resolved model lacks native tools'
  if (
    (profile === 'planning' || profile === 'review' || profile === 'design') &&
    !model.reasoning
  ) {
    return 'resolved model lacks reasoning capability'
  }
  if (profile === 'vision' && !model.input.includes('image')) {
    return 'resolved model lacks image input capability'
  }
  return undefined
}

function priceSelection(
  alias: string,
  model: Model,
  thinkingLevel: unknown,
  usage: ModelUsageEstimate,
  policy: SwarmModelRoutingPolicy,
  exposure: ModelRoutingNodePlan['exposure'],
): { selection: PricedSelection; error?: never } | { error: string } {
  const buckets: [keyof ModelUsageEstimate, keyof Model['cost'], string][] = [
    ['inputTokens', 'input', 'input'],
    ['outputTokens', 'output', 'output'],
    ['cacheReadTokens', 'cacheRead', 'cache read'],
    ['cacheWriteTokens', 'cacheWrite', 'cache write'],
  ]
  const rates: ModelRoutingNodePlan['catalogRates'] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  const assumptions: string[] = []
  let weightedCost = 0
  for (const [usageKey, costKey, label] of buckets) {
    const priced = priceTokenBucket(
      usage[usageKey],
      model.cost[costKey],
      label,
      policy.allowZeroMarginalCost,
    )
    if ('error' in priced) return priced
    rates[costKey] = priced.rate
    weightedCost += priced.weightedCost
    if (priced.assumption !== undefined) assumptions.push(priced.assumption)
  }
  const baseEstimatedCostUsd = weightedCost / 1_000_000
  const estimatedCostUsd =
    baseEstimatedCostUsd *
    exposure.iterations *
    exposure.repeatRounds *
    exposure.nodeAttempts *
    exposure.providerAttempts
  return {
    selection: {
      alias,
      model,
      ...(typeof thinkingLevel === 'string' ? { thinkingLevel } : {}),
      rates,
      baseEstimatedCostUsd,
      estimatedCostUsd,
      assumptions,
    },
  }
}

function priceTokenBucket(
  tokens: number,
  catalogRate: unknown,
  label: string,
  allowZeroMarginalCost: boolean,
):
  | { rate: number; weightedCost: number; assumption?: string }
  | { error: string } {
  if (tokens === 0) {
    const rate =
      typeof catalogRate === 'number' && Number.isFinite(catalogRate)
        ? catalogRate
        : 0
    return { rate, weightedCost: 0 }
  }
  if (
    typeof catalogRate !== 'number' ||
    !Number.isFinite(catalogRate) ||
    catalogRate < 0
  ) {
    return {
      error: `${label} price is missing or invalid for positive token usage`,
    }
  }
  if (catalogRate !== 0) {
    return { rate: catalogRate, weightedCost: tokens * catalogRate }
  }
  if (!allowZeroMarginalCost) {
    return {
      error: `${label} price is zero and is treated as unknown unless allow_zero_marginal_cost is true`,
    }
  }
  return {
    rate: 0,
    weightedCost: 0,
    assumption: `${label} uses an exact catalog zero as zero marginal cost`,
  }
}

function catalogFreshness(
  registry: ModelRegistry,
  provider: string,
): ModelRoutingNodePlan['catalogFreshness'] {
  const state = registry.getProviderDiscoveryState(provider)
  if (state === undefined) return { status: 'unknown' }
  const status = state.stale || state.status === 'cached' ? 'stale' : 'fresh'
  return {
    status,
    providerStatus: state.status,
    ...(state.fetchedAt === undefined ? {} : { fetchedAt: state.fetchedAt }),
  }
}

function collectInvalidatableNodes(definition: SwarmDefinition): Set<string> {
  const dependencies = buildDependencyGraph(definition)
  const invalidatable = new Set<string>()
  for (const node of definition.nodes.values()) {
    if (node.type === 'bash' || node.control === undefined) continue
    for (const target of node.control.allowedRestartTargets) {
      invalidatable.add(target)
      for (const dependent of collectTransitiveDependents(
        dependencies,
        target,
      )) {
        invalidatable.add(dependent)
      }
    }
  }
  return invalidatable
}

function collectAgentIntents(
  definition: SwarmDefinition,
  path: string,
  inheritedPolicy: SwarmModelRoutingPolicy,
): Map<
  string,
  { profile: SwarmWorkloadProfile; policy: SwarmModelRoutingPolicy }
> {
  const result = new Map<
    string,
    { profile: SwarmWorkloadProfile; policy: SwarmModelRoutingPolicy }
  >()
  const policy = definition.modelRouting ?? inheritedPolicy
  for (const [name, agent] of definition.agents) {
    result.set(`${path}/${name}`, {
      profile: agent.workload?.profile ?? 'general',
      policy,
    })
  }
  for (const [name, graph] of definition.graphs) {
    if (graph.definition === undefined) continue
    for (const [agentPath, intent] of collectAgentIntents(
      graph.definition,
      `${path}/${name}`,
      policy,
    )) {
      result.set(agentPath, intent)
    }
  }
  return result
}

function formatCost(value: number): string {
  return value.toFixed(6)
}
