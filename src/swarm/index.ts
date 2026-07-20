import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@oh-my-pi/pi-coding-agent'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { formatDuration } from './swarm/format'
import { loadSwarmDefinitionFile } from './swarm/loader'
import {
  assertModelRoutingPlanCompatible,
  buildModelRoutingPlan,
  type ModelRoutingPlan,
  normalizeModelRoutingCatalogError,
} from './swarm/model-routing'
import type { PipelineResult } from './swarm/pipeline'
import { PipelineController } from './swarm/pipeline'
import {
  buildValidatedExecutionWaves,
  preflightSwarmDefinition,
} from './swarm/preflight'
import { renderSwarmProgress } from './swarm/render'
import type { SwarmDefinition } from './swarm/schema'
import type { AgentState, BashNodeState, GraphState } from './swarm/state'
import {
  createInitializedStateTracker,
  createRestartStateTracker,
  loadPersistedModelRoutingPlan,
  StateTracker,
} from './swarm/state'

export default function swarmExtension(pi: ExtensionAPI): void {
  pi.setLabel('Swarm Orchestrator')

  pi.registerCommand('swarm', {
    description: 'Run a multi-agent swarm pipeline from YAML',
    getArgumentCompletions: (prefix) => {
      const subcommands = ['run', 'restart', 'status', 'help']
      if (!prefix)
        return subcommands.map((subcommand) => ({
          label: subcommand,
          value: subcommand,
        }))
      return subcommands
        .filter((subcommand) => subcommand.startsWith(prefix))
        .map((subcommand) => ({ label: subcommand, value: subcommand }))
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/)
      const subcommand = parts[0] ?? 'help'

      switch (subcommand) {
        case 'run': {
          const yamlPath = parts[1]
          if (!yamlPath) {
            ctx.ui.notify('Usage: /swarm run <path/to/pipeline.yaml>', 'error')
            return
          }
          await handleRun(yamlPath, ctx, pi)
          return
        }
        case 'restart': {
          const yamlPath = parts[1]
          if (!yamlPath) {
            ctx.ui.notify(
              'Usage: /swarm restart <path/to/pipeline.yaml>',
              'error',
            )
            return
          }
          await handleRestart(yamlPath, ctx, pi)
          return
        }
        case 'status': {
          await handleStatus(parts[1], ctx)
          return
        }
        default: {
          showHelp(ctx)
        }
      }
    },
  })
}

function showHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    [
      'Swarm — multi-agent pipeline orchestrator',
      '',
      '  /swarm run <file.yaml>     Run a pipeline',
      '  /swarm restart <file.yaml> Restart from prior state, or start fresh when no state exists',
      '  /swarm status [name]       Show pipeline status',
      '  /swarm help                Show this help',
    ].join('\n'),
    'info',
  )
}

interface SwarmRunContext {
  swarmDefinition: SwarmDefinition
  waves: string[][]
  workspace: string
}

type ExtensionPreparation =
  | {
      ok: true
      routingPlan?: ModelRoutingPlan
      settings?: Settings
    }
  | { ok: false }

async function prepareExtensionWorkspace(
  definition: SwarmDefinition,
  workspace: string,
  ctx: ExtensionCommandContext,
  restart: boolean,
): Promise<ExtensionPreparation> {
  try {
    const routing = await prepareExtensionRoutingPlan(
      definition,
      workspace,
      ctx,
      restart,
    )
    await fs.mkdir(workspace, { recursive: true })
    return {
      ok: true,
      ...routing,
    }
  } catch (error_) {
    const error = error_ instanceof Error ? error_ : new Error(String(error_))
    ctx.ui.notify(error.message, 'error')
    return { ok: false }
  }
}

async function loadPreparedSwarmContext(
  yamlPath: string,
  ctx: ExtensionCommandContext,
  restart: boolean,
): Promise<
  | (SwarmRunContext & {
      routingPlan?: ModelRoutingPlan
      settings?: Settings
    })
  | undefined
> {
  const swarmContext = await loadSwarmRunContext(yamlPath, ctx)
  if (swarmContext === undefined) return undefined
  const preparation = await prepareExtensionWorkspace(
    swarmContext.swarmDefinition,
    swarmContext.workspace,
    ctx,
    restart,
  )
  if (!preparation.ok) return undefined
  return { ...swarmContext, ...preparation }
}

async function handleRun(
  yamlPath: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const swarmContext = await loadPreparedSwarmContext(yamlPath, ctx, false)
  if (swarmContext === undefined) return
  const { swarmDefinition, waves, workspace, routingPlan, settings } =
    swarmContext
  const stateTracker = await createInitializedStateTracker(
    workspace,
    swarmDefinition,
    routingPlan,
  )

  await runSwarmWithState(
    swarmDefinition,
    waves,
    workspace,
    stateTracker,
    ctx,
    pi,
    routingPlan === undefined
      ? {}
      : {
          modelRoutingPlan: routingPlan,
          ...(settings === undefined ? {} : { settings }),
        },
  )
}

async function handleRestart(
  yamlPath: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const swarmContext = await loadPreparedSwarmContext(yamlPath, ctx, true)
  if (swarmContext === undefined) return
  const { swarmDefinition, waves, workspace, routingPlan, settings } =
    swarmContext

  let restartPlan
  try {
    restartPlan = await createRestartStateTracker(
      workspace,
      swarmDefinition,
      routingPlan,
    )
  } catch (error_) {
    const error = error_ instanceof Error ? error_ : new Error(String(error_))
    ctx.ui.notify(error.message, 'error')
    return
  }
  ctx.ui.notify(restartPlan.message, 'info')
  if (restartPlan.alreadyCompleted) {
    ctx.ui.notify(
      renderSwarmProgress(restartPlan.stateTracker.state).join('\n'),
      'info',
    )
    return
  }

  await runSwarmWithState(
    swarmDefinition,
    waves,
    workspace,
    restartPlan.stateTracker,
    ctx,
    pi,
    {
      ...(routingPlan === undefined ? {} : { modelRoutingPlan: routingPlan }),
      ...(settings === undefined ? {} : { settings }),
      resume: {
        startIteration: restartPlan.startIteration,
        settledNodes: restartPlan.settledNodes,
      },
    },
  )
}

async function loadSwarmRunContext(
  yamlPath: string,
  ctx: ExtensionCommandContext,
): Promise<SwarmRunContext | undefined> {
  const resolvedPath = path.isAbsolute(yamlPath)
    ? yamlPath
    : path.resolve(ctx.cwd, yamlPath)
  const swarmDefinition = await loadSwarmDefinition(resolvedPath, ctx)
  if (swarmDefinition === undefined) return undefined

  const waves = buildValidatedWaves(swarmDefinition, ctx)
  if (waves === undefined) return undefined

  const workspace = path.isAbsolute(swarmDefinition.workspace)
    ? swarmDefinition.workspace
    : path.resolve(path.dirname(resolvedPath), swarmDefinition.workspace)
  return { swarmDefinition, waves, workspace }
}

interface PreparedExtensionRouting {
  routingPlan: ModelRoutingPlan
  settings?: Settings
}

async function prepareExtensionRoutingPlan(
  definition: SwarmDefinition,
  workspace: string,
  ctx: ExtensionCommandContext,
  restart: boolean,
): Promise<PreparedExtensionRouting | undefined> {
  if (definition.modelRouting === undefined) return undefined
  const persisted = restart
    ? await loadPersistedModelRoutingPlan(workspace, definition)
    : undefined
  if (persisted?.loadedExistingState) {
    assertModelRoutingPlanCompatible(definition, persisted.modelRoutingPlan)
  }
  if (persisted?.alreadyCompleted) {
    if (persisted.modelRoutingPlan === undefined) {
      throw new Error('Completed routed state has no model routing plan.')
    }
    return { routingPlan: persisted.modelRoutingPlan }
  }
  return await prepareExecutableExtensionRouting(
    definition,
    workspace,
    ctx,
    persisted?.modelRoutingPlan,
  )
}

async function prepareExecutableExtensionRouting(
  definition: SwarmDefinition,
  workspace: string,
  ctx: ExtensionCommandContext,
  persistedPlan: ModelRoutingPlan | undefined,
): Promise<PreparedExtensionRouting> {
  const settings = await Settings.loadReadOnly({ cwd: workspace })
  try {
    await ctx.modelRegistry.refresh('online-if-uncached')
  } catch (error_) {
    throw normalizeModelRoutingCatalogError(error_)
  }
  const routingPlan =
    persistedPlan ??
    (await buildModelRoutingPlan({
      definition,
      modelRegistry: ctx.modelRegistry,
      settings,
      refreshedAt: Date.now(),
    }))
  return { routingPlan, settings }
}

async function runSwarmWithState(
  swarmDefinition: SwarmDefinition,
  waves: string[][],
  workspace: string,
  stateTracker: StateTracker,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  execution?: {
    modelRoutingPlan?: ModelRoutingPlan
    resume?: { startIteration: number; settledNodes: readonly string[] }
    settings?: Settings
  },
): Promise<void> {
  logStart(pi, swarmDefinition, waves, workspace)
  ctx.ui.notify(
    `Starting swarm '${swarmDefinition.name}': ${swarmDefinition.nodes.size} nodes, ${swarmDefinition.agents.size} agents, ${swarmDefinition.bashNodes.size} bash, ${swarmDefinition.graphs.size} graphs, ${waves.length} waves, ${swarmDefinition.targetCount} iteration(s)`,
    'info',
  )

  const widgetKey = `swarm-${swarmDefinition.name}`
  const updateWidget = () => {
    ctx.ui.setWidget(widgetKey, renderSwarmProgress(stateTracker.state))
  }
  updateWidget()

  const controller = new PipelineController(
    swarmDefinition,
    waves,
    stateTracker,
    execution?.modelRoutingPlan,
  )
  const result = await controller.run({
    workspace,
    onProgress: () => {
      updateWidget()
    },
    ...(execution?.resume === undefined ? {} : { resume: execution.resume }),
    modelRegistry: ctx.modelRegistry,
    settings: execution?.settings ?? pi.pi.settings,
  })

  ctx.ui.setWidget(widgetKey, undefined)
  notifySummary(ctx, result, swarmDefinition, stateTracker)
  if (result.errors.length > 0) {
    pi.logger.warn('Swarm completed with errors', { errors: result.errors })
  }
  sendSummary(pi, swarmDefinition, result, stateTracker, workspace)
}

async function loadSwarmDefinition(
  resolvedPath: string,
  ctx: ExtensionCommandContext,
): Promise<SwarmDefinition | undefined> {
  try {
    return await loadSwarmDefinitionFile(resolvedPath)
  } catch (error) {
    ctx.ui.notify(
      `YAML error: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    )
    return undefined
  }
}

function buildValidatedWaves(
  swarmDefinition: SwarmDefinition,
  ctx: ExtensionCommandContext,
): string[][] | undefined {
  const validationErrors = preflightSwarmDefinition(swarmDefinition)
  if (validationErrors.length > 0) {
    const messages = validationErrors.map((error) => `  - ${error}`).join('\n')
    ctx.ui.notify(`Validation errors:\n${messages}`, 'error')
    return undefined
  }

  try {
    return buildValidatedExecutionWaves(swarmDefinition)
  } catch (error_) {
    const error = error_ instanceof Error ? error_.message : String(error_)
    ctx.ui.notify(error, 'error')
    return undefined
  }
}

function logStart(
  pi: ExtensionAPI,
  swarmDefinition: SwarmDefinition,
  waves: string[][],
  workspace: string,
): void {
  const nodeList = [...swarmDefinition.nodes.keys()].join(', ')
  const agentList = [...swarmDefinition.agents.keys()].join(', ')
  const bashList = [...swarmDefinition.bashNodes.keys()].join(', ')
  const graphList = [...swarmDefinition.graphs.keys()].join(', ')
  const waveDescription = waves
    .map((wave, index) => `wave ${index + 1}: [${wave.join(', ')}]`)
    .join('; ')
  pi.logger.debug('Swarm starting', {
    name: swarmDefinition.name,
    mode: swarmDefinition.mode,
    nodes: nodeList,
    agents: agentList,
    bash: bashList,
    graphs: graphList,
    waves: waveDescription,
    workspace,
  })
}

function notifySummary(
  ctx: ExtensionCommandContext,
  result: PipelineResult,
  swarmDefinition: SwarmDefinition,
  stateTracker: StateTracker,
): void {
  const elapsed = stateTracker.state.completedAt
    ? formatDuration(
        stateTracker.state.completedAt - stateTracker.state.startedAt,
      )
    : 'unknown'
  const summaryParts = [
    `Swarm '${swarmDefinition.name}' ${result.status}`,
    `${result.iterations}/${swarmDefinition.targetCount} iterations`,
    `${swarmDefinition.nodes.size} nodes`,
    `${swarmDefinition.agents.size} agents`,
    `${swarmDefinition.bashNodes.size} bash`,
    `${swarmDefinition.graphs.size} graphs`,
    `elapsed: ${elapsed}`,
  ]

  if (result.errors.length > 0) {
    summaryParts.push(`${result.errors.length} error(s)`)
  }
  ctx.ui.notify(
    summaryParts.join(' | '),
    result.status === 'completed' ? 'info' : 'error',
  )
}

function sendSummary(
  pi: ExtensionAPI,
  swarmDefinition: SwarmDefinition,
  result: PipelineResult,
  stateTracker: StateTracker,
  workspace: string,
): void {
  pi.sendMessage(
    {
      customType: 'swarm-result',
      content: [
        {
          type: 'text',
          text: buildSummaryMessage(
            swarmDefinition,
            result,
            stateTracker,
            workspace,
          ),
        },
      ],
      display: true,
      details: {
        swarmName: swarmDefinition.name,
        status: result.status,
        iterations: result.iterations,
        nodeCount: swarmDefinition.nodes.size,
        agentCount: swarmDefinition.agents.size,
        bashNodeCount: swarmDefinition.bashNodes.size,
        graphCount: swarmDefinition.graphs.size,
        errorCount: result.errors.length,
      },
    },
    { triggerTurn: false },
  )
}

async function handleStatus(
  name: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!name) {
    ctx.ui.notify(
      'Usage: /swarm status <name>  (reads .swarm_<name>/state/pipeline.json from cwd)',
      'info',
    )
    return
  }

  const stateTracker = new StateTracker(ctx.cwd, name)
  const state = await stateTracker.load()
  if (!state) {
    ctx.ui.notify(`No state found for swarm '${name}' in ${ctx.cwd}`, 'error')
    return
  }

  ctx.ui.notify(renderSwarmProgress(state).join('\n'), 'info')
}

function buildSummaryMessage(
  swarmDefinition: SwarmDefinition,
  result: PipelineResult,
  stateTracker: StateTracker,
  workspace: string,
): string {
  return [
    ...buildSummaryHeader(swarmDefinition, result, stateTracker, workspace),
    ...buildAgentSummaryLines(stateTracker.state.agents),
    ...buildBashSummaryLines(stateTracker.state.bashNodes),
    ...buildGraphSummaryLines(stateTracker.state.graphs),
    ...buildErrorSummaryLines(result.errors),
  ].join('\n')
}

function buildSummaryHeader(
  swarmDefinition: SwarmDefinition,
  result: PipelineResult,
  stateTracker: StateTracker,
  workspace: string,
): string[] {
  return [
    `## Swarm Pipeline: ${swarmDefinition.name}`,
    '',
    `- **Status**: ${result.status}`,
    `- **Mode**: ${swarmDefinition.mode}`,
    `- **Iterations**: ${result.iterations}/${swarmDefinition.targetCount}`,
    `- **Nodes**: ${swarmDefinition.nodes.size}`,
    `- **Agents**: ${swarmDefinition.agents.size}`,
    `- **Bash**: ${swarmDefinition.bashNodes.size}`,
    `- **Graphs**: ${swarmDefinition.graphs.size}`,
    `- **Restarts**: ${stateTracker.state.restartCount}`,
    `- **Workspace**: ${workspace}`,
    `- **State dir**: ${stateTracker.swarmDir}`,
    '',
  ]
}

function buildAgentSummaryLines(agents: Record<string, AgentState>): string[] {
  return [
    '### Agent Results',
    '',
    ...Object.entries(agents).map(([name, agent]) =>
      renderAgentSummary(name, agent),
    ),
  ]
}

function buildBashSummaryLines(
  bashNodes: Record<string, BashNodeState>,
): string[] {
  const entries = Object.entries(bashNodes)
  if (entries.length === 0) return []
  return [
    '',
    '### Bash Results',
    '',
    ...entries.map(([name, bashNode]) => renderBashSummary(name, bashNode)),
  ]
}

function buildGraphSummaryLines(graphs: Record<string, GraphState>): string[] {
  const entries = Object.entries(graphs)
  if (entries.length === 0) return []
  return [
    '',
    '### Graph Results',
    '',
    ...entries.map(([name, graph]) => renderGraphSummary(name, graph)),
  ]
}

function buildErrorSummaryLines(errors: string[]): string[] {
  if (errors.length === 0) return []
  return ['', '### Errors', '', ...errors.map((error) => `- ${error}`)]
}

function renderAgentSummary(name: string, agent: AgentState): string {
  const duration = formatSummaryDuration(agent.startedAt, agent.completedAt)
  const errorSuffix = agent.error === undefined ? '' : ` — ${agent.error}`
  const attemptSuffix = formatSummaryAttempt(agent.attempt)
  return `- **${name}**: ${agent.status}${attemptSuffix} (${duration})${errorSuffix}`
}

function renderBashSummary(name: string, bashNode: BashNodeState): string {
  const duration = formatSummaryDuration(
    bashNode.startedAt,
    bashNode.completedAt,
  )
  const attemptSuffix = formatSummaryAttempt(bashNode.attempt)
  const outputSuffix =
    bashNode.outputPath === undefined ? '' : ` -> ${bashNode.outputPath}`
  const exitSuffix =
    bashNode.exitCode === undefined ? '' : ` exit ${bashNode.exitCode}`
  const errorSuffix = bashNode.error === undefined ? '' : ` — ${bashNode.error}`
  return `- **${name}**: ${bashNode.status}${attemptSuffix}${outputSuffix}${exitSuffix} (${duration})${errorSuffix}`
}

function renderGraphSummary(name: string, graph: GraphState): string {
  const duration = formatSummaryDuration(graph.startedAt, graph.completedAt)
  const roundSuffix = formatGraphRoundSuffix(graph)
  const errorSuffix = graph.error === undefined ? '' : ` — ${graph.error}`
  const attemptSuffix = formatSummaryAttempt(graph.attempt)
  return `- **${name}**: ${graph.status}${attemptSuffix}${roundSuffix} (${duration})${errorSuffix}`
}

function formatSummaryAttempt(attempt: number): string {
  return attempt > 1 ? ` attempt ${attempt}` : ''
}

function formatSummaryDuration(
  startedAt: number | undefined,
  completedAt: number | undefined,
): string {
  if (startedAt === undefined || completedAt === undefined) return 'n/a'
  return formatDuration(completedAt - startedAt)
}

function formatGraphRoundSuffix(graph: GraphState): string {
  if (graph.currentRound === undefined || graph.maxRounds === undefined)
    return ''
  return ` round ${graph.currentRound}/${graph.maxRounds}`
}
