/**
 * Swarm Extension — Multi-agent pipeline orchestration from YAML definitions.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@oh-my-pi/pi-coding-agent'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {
  buildDependencyGraph,
  buildExecutionWaves,
  detectCycles,
} from './swarm/dag'
import { formatDuration } from './swarm/format'
import type { PipelineResult } from './swarm/pipeline'
import { PipelineController } from './swarm/pipeline'
import { renderSwarmProgress } from './swarm/render'
import {
  parseSwarmYaml,
  type SwarmDefinition,
  validateSwarmDefinition,
} from './swarm/schema'
import { StateTracker } from './swarm/state'

export default function swarmExtension(pi: ExtensionAPI): void {
  pi.setLabel('Swarm Orchestrator')

  pi.registerCommand('swarm', {
    description: 'Run a multi-agent swarm pipeline from YAML',
    getArgumentCompletions: (prefix) => {
      const subcommands = ['run', 'status', 'help']
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
      '  /swarm status [name]       Show pipeline status',
      '  /swarm help                Show this help',
    ].join('\n'),
    'info',
  )
}

async function handleRun(
  yamlPath: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const resolvedPath = path.isAbsolute(yamlPath)
    ? yamlPath
    : path.resolve(ctx.cwd, yamlPath)
  const swarmDefinition = await loadSwarmDefinition(resolvedPath, ctx)
  if (swarmDefinition === undefined) return

  const waves = buildValidatedWaves(swarmDefinition, ctx)
  if (waves === undefined) return

  const workspace = path.isAbsolute(swarmDefinition.workspace)
    ? swarmDefinition.workspace
    : path.resolve(path.dirname(resolvedPath), swarmDefinition.workspace)
  await fs.mkdir(workspace, { recursive: true })

  const stateTracker = new StateTracker(workspace, swarmDefinition.name)
  await stateTracker.init(
    [...swarmDefinition.agents.keys()],
    swarmDefinition.targetCount,
    swarmDefinition.mode,
  )

  logStart(pi, swarmDefinition, waves, workspace)
  ctx.ui.notify(
    `Starting swarm '${swarmDefinition.name}': ${swarmDefinition.agents.size} agents, ${waves.length} waves, ${swarmDefinition.targetCount} iteration(s)`,
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
  )
  const result = await controller.run({
    workspace,
    onProgress: () => {
      updateWidget()
    },
    modelRegistry: ctx.modelRegistry,
    settings: pi.pi.settings,
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
  let content: string
  try {
    content = await fs.readFile(resolvedPath, 'utf8')
  } catch {
    ctx.ui.notify(`Cannot read file: ${resolvedPath}`, 'error')
    return undefined
  }

  try {
    return parseSwarmYaml(content)
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
  const validationErrors = validateSwarmDefinition(swarmDefinition)
  if (validationErrors.length > 0) {
    const messages = validationErrors.map((error) => `  - ${error}`).join('\n')
    ctx.ui.notify(`Validation errors:\n${messages}`, 'error')
    return undefined
  }

  const dependencies = buildDependencyGraph(swarmDefinition)
  const cycleNodes = detectCycles(dependencies)
  if (cycleNodes) {
    ctx.ui.notify(
      `Cycle detected in agent dependencies: [${cycleNodes.join(', ')}]`,
      'error',
    )
    return undefined
  }
  return buildExecutionWaves(dependencies)
}

function logStart(
  pi: ExtensionAPI,
  swarmDefinition: SwarmDefinition,
  waves: string[][],
  workspace: string,
): void {
  const agentList = [...swarmDefinition.agents.keys()].join(', ')
  const waveDescription = waves
    .map((wave, index) => `wave ${index + 1}: [${wave.join(', ')}]`)
    .join('; ')
  pi.logger.debug('Swarm starting', {
    name: swarmDefinition.name,
    mode: swarmDefinition.mode,
    agents: agentList,
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
  const lines = [
    `## Swarm Pipeline: ${swarmDefinition.name}`,
    '',
    `- **Status**: ${result.status}`,
    `- **Mode**: ${swarmDefinition.mode}`,
    `- **Iterations**: ${result.iterations}/${swarmDefinition.targetCount}`,
    `- **Workspace**: ${workspace}`,
    `- **State dir**: ${stateTracker.swarmDir}`,
    '',
    '### Agent Results',
    '',
  ]

  for (const [name, agent] of Object.entries(stateTracker.state.agents)) {
    const duration =
      agent.startedAt && agent.completedAt
        ? formatDuration(agent.completedAt - agent.startedAt)
        : 'n/a'
    const errorSuffix = agent.error ? ` — ${agent.error}` : ''
    lines.push(`- **${name}**: ${agent.status} (${duration})${errorSuffix}`)
  }

  if (result.errors.length > 0) {
    lines.push(
      '',
      '### Errors',
      '',
      ...result.errors.map((error) => `- ${error}`),
    )
  }

  return lines.join('\n')
}
