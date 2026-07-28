#!/usr/bin/env bun
import { discoverAuthStorage } from '@oh-my-pi/pi-coding-agent'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { loadSwarmDefinitionFile } from './swarm/loader'
import {
  assertModelRoutingPlanCompatible,
  buildModelRoutingPlan,
  type ModelRoutingPlan,
  normalizeModelRoutingCatalogError,
  renderModelRoutingPlan,
  selectPersistedModelRoutingPlan,
} from './swarm/model-routing'
import { PipelineController } from './swarm/pipeline'
import {
  buildValidatedExecutionWaves,
  preflightSwarmDefinition,
} from './swarm/preflight'
import { renderSwarmProgress } from './swarm/render'
import {
  formatRestartDecision,
  parseRestartOverrides,
} from './swarm/restart-options'
import type { SwarmDefinition } from './swarm/schema'
import {
  createInitializedStateTracker,
  createRestartStateTracker,
  loadPersistedModelRoutingPlan,
} from './swarm/state'

const RUN_DIRECTORY_NAMES = [
  'signals',
  'tracking',
  'reports',
  'output',
] as const

function writeLine(message = ''): void {
  process.stdout.write(`${message}\n`)
}

async function prepareRunDirectories(workspace: string): Promise<void> {
  await Promise.all(
    RUN_DIRECTORY_NAMES.map((name) =>
      fs.mkdir(path.join(workspace, name), { recursive: true }),
    ),
  )
}

function usageLines(): string[] {
  return [
    'Usage: omp-swarm <path-to-yaml>',
    '       omp-swarm restart <path-to-yaml> [--reuse <nodes>] [--rerun <nodes>] [--from <node>]',
    '       omp-swarm plan-models <path-to-yaml>',
    '       omp-swarm validate <path-to-yaml>',
    '       omp-swarm --help',
    '',
    'Commands:',
    '  restart <path-to-yaml>   Resume from prior state; starts fresh when no state is found',
    '  plan-models <path-to-yaml> Refresh the authenticated catalog and print a model plan without initializing state or running nodes',
    '  validate <path-to-yaml>  Validate a swarm YAML file without running it',
    '',
    'Run workspace:',
    '  Creates signals/, tracking/, reports/, and output/ before execution',
    '',
    'Options:',
    '  -h, --help               Show this help',
    '      --reuse <nodes>      Comma-separated completed nodes to reuse when hard invariants pass',
    '      --rerun <nodes>      Comma-separated nodes to rerun with their dependants',
    '      --from <node>         Rerun one node and every transitive dependant',
  ]
}

function writeUsage(): void {
  writeLine(usageLines().join('\n'))
}

function writeUsageError(): void {
  console.error(usageLines().join('\n'))
}

class TerminalProgressRenderer {
  #renderedRows = 0

  clear(): void {
    if (this.#renderedRows === 0) return
    this.#moveToBlockStart()
    this.#clearFromCursor()
    this.#renderedRows = 0
  }

  render(lines: readonly string[]): void {
    if (!process.stdout.isTTY) return

    if (this.#renderedRows > 0) {
      this.#moveToBlockStart()
      this.#clearFromCursor()
    }

    process.stdout.write(lines.join('\n'))
    process.stdout.write('\n')
    this.#renderedRows = this.#measureRenderedRows(lines)
  }

  #moveToBlockStart(): void {
    process.stdout.write(`\u001B[${this.#renderedRows}A`)
  }

  #clearFromCursor(): void {
    process.stdout.write('\u001B[J')
  }

  #measureRenderedRows(lines: readonly string[]): number {
    const columns = process.stdout.columns
    if (columns <= 0) return lines.length
    return lines.reduce(
      (total, line) =>
        total +
        Math.max(1, Math.floor(Math.max(line.length - 1, 0) / columns) + 1),
      0,
    )
  }
}

const cliArguments = process.argv.slice(2)
const [commandOrPath, maybePath] = cliArguments
if (!commandOrPath) {
  writeUsageError()
  process.exit(1)
}

if (commandOrPath === '--help' || commandOrPath === '-h') {
  writeUsage()
  process.exit(0)
}

const isValidateCommand = commandOrPath === 'validate'
const isPlanModelsCommand = commandOrPath === 'plan-models'
const isRestartCommand = commandOrPath === 'restart'
const yamlPath =
  isValidateCommand || isRestartCommand || isPlanModelsCommand
    ? maybePath
    : commandOrPath
if (!yamlPath) {
  writeUsageError()
  process.exit(1)
}

const resolvedPath = path.resolve(yamlPath)
writeLine(`Reading: ${resolvedPath}`)
try {
  const restartOverrides = isRestartCommand
    ? parseRestartOverrides(cliArguments.slice(2))
    : {}
  if (
    !isRestartCommand &&
    cliArguments.length > (isValidateCommand || isPlanModelsCommand ? 2 : 1)
  ) {
    throw new Error('Restart options are only valid with the restart command')
  }
  const swarmDefinition = await loadSwarmDefinitionFile(resolvedPath)

  writeLine(`Swarm: ${swarmDefinition.name}`)
  writeLine(`Mode: ${swarmDefinition.mode}`)
  writeLine(`Target count: ${swarmDefinition.targetCount}`)
  writeLine(
    `Nodes: ${[...swarmDefinition.nodes.keys()].join(', ') || '(none)'}`,
  )
  writeLine(
    `Agents: ${[...swarmDefinition.agents.keys()].join(', ') || '(none)'}`,
  )
  writeLine(
    `Bash: ${[...swarmDefinition.bashNodes.keys()].join(', ') || '(none)'}`,
  )
  writeLine(
    `Graphs: ${[...swarmDefinition.graphs.keys()].join(', ') || '(none)'}`,
  )

  const errors = preflightSwarmDefinition(swarmDefinition)
  if (errors.length > 0) {
    console.error('Validation errors:', errors)
    process.exit(1)
  }

  const waves = buildValidatedExecutionWaves(swarmDefinition)
  const waveSummary = waves
    .map((wave, index) => `W${index + 1}:[${wave.join(',')}]`)
    .join(' -> ')
  writeLine(`Waves: ${waveSummary}`)

  if (isValidateCommand) {
    writeLine('Validation: ok')
    process.exit(0)
  }

  const workspace = path.isAbsolute(swarmDefinition.workspace)
    ? swarmDefinition.workspace
    : path.resolve(path.dirname(resolvedPath), swarmDefinition.workspace)

  if (isPlanModelsCommand && swarmDefinition.modelRouting === undefined) {
    throw new Error(
      'Model planning requires swarm.model_routing.enabled: true at the root.',
    )
  }

  let routingPlan: ModelRoutingPlan | undefined
  let routedModelRegistry: ModelRegistry | undefined
  let routedSettings: Settings | undefined
  if (swarmDefinition.modelRouting !== undefined) {
    const persisted = isRestartCommand
      ? await loadPersistedModelRoutingPlan(workspace, swarmDefinition)
      : undefined
    routingPlan = selectPersistedModelRoutingPlan(
      swarmDefinition,
      persisted?.modelRoutingPlan,
      persisted?.loadedExistingState ?? false,
    )
    if (persisted?.alreadyCompleted) {
      assertModelRoutingPlanCompatible(swarmDefinition, routingPlan)
    }
    if (!persisted?.alreadyCompleted) {
      let refreshedAt: number
      try {
        const authStorage = await discoverAuthStorage()
        const settings = await Settings.init({ cwd: workspace, readOnly: true })
        const modelRegistry = new ModelRegistry(authStorage)
        await modelRegistry.refresh('online-if-uncached')
        refreshedAt = Date.now()
        routedSettings = settings
        routedModelRegistry = modelRegistry
      } catch (error_) {
        throw normalizeModelRoutingCatalogError(error_)
      }
      routingPlan ??= await buildModelRoutingPlan({
        definition: swarmDefinition,
        modelRegistry: routedModelRegistry,
        settings: routedSettings,
        refreshedAt,
      })
    }
  }

  if (isPlanModelsCommand) {
    if (routingPlan === undefined) {
      throw new Error('No model routing plan was produced.')
    }
    writeLine(renderModelRoutingPlan(routingPlan).join('\n'))
    process.exit(0)
  }

  await prepareRunDirectories(workspace)
  writeLine(`Workspace: ${workspace}`)

  const restartPlan = isRestartCommand
    ? await createRestartStateTracker(
        workspace,
        swarmDefinition,
        routingPlan,
        restartOverrides,
      )
    : undefined
  if (restartPlan !== undefined) {
    writeLine(restartPlan.message)
    for (const { node, decision } of restartPlan.decisions) {
      writeLine(`  ${node.padEnd(16)} ${formatRestartDecision(decision)}`)
    }
    if (restartPlan.manifestPath !== undefined) {
      writeLine(`Restart manifest: ${restartPlan.manifestPath}`)
    }
    if (restartPlan.alreadyCompleted) {
      writeLine(renderSwarmProgress(restartPlan.stateTracker.state).join('\n'))
      writeLine(`State saved to: ${restartPlan.stateTracker.swarmDir}`)
      process.exit(0)
    }
  }
  const stateTracker =
    restartPlan?.stateTracker ??
    (await createInitializedStateTracker(
      workspace,
      swarmDefinition,
      routingPlan,
    ))

  const containsAgents = definitionContainsAgents(swarmDefinition)
  const authStorage =
    routedModelRegistry === undefined && containsAgents
      ? await discoverAuthStorage()
      : undefined
  const modelRegistry =
    routedModelRegistry ??
    (authStorage === undefined ? undefined : new ModelRegistry(authStorage))
  if (routedModelRegistry === undefined && modelRegistry !== undefined)
    await modelRegistry.refresh('online-if-uncached')
  const settings =
    routedSettings ??
    (containsAgents
      ? await Settings.init({ cwd: workspace, readOnly: true })
      : undefined)

  let lastProgressDump = 0
  const PROGRESS_INTERVAL_MS = 5000
  const progressRenderer = new TerminalProgressRenderer()

  writeLine('\n--- Pipeline starting ---\n')

  const controller = new PipelineController(
    swarmDefinition,
    waves,
    stateTracker,
    routingPlan,
  )
  const result = await controller.run({
    workspace,
    onProgress: () => {
      const now = Date.now()
      if (now - lastProgressDump > PROGRESS_INTERVAL_MS) {
        lastProgressDump = now
        progressRenderer.render(renderSwarmProgress(stateTracker.state))
      }
    },
    ...(restartPlan === undefined
      ? {}
      : {
          resume: {
            startIteration: restartPlan.startIteration,
            settledNodes: restartPlan.settledNodes,
          },
        }),
    ...(modelRegistry === undefined ? {} : { modelRegistry }),
    ...(settings === undefined ? {} : { settings }),
  })

  progressRenderer.clear()
  writeLine('\n--- Pipeline finished ---\n')
  writeLine(`Status: ${result.status}`)
  writeLine(
    `Iterations completed: ${result.iterations}/${swarmDefinition.targetCount}`,
  )
  if (result.errors.length > 0) {
    writeLine(`Errors (${result.errors.length}):`)
    for (const error of result.errors) writeLine(`  - ${error}`)
  }
  writeLine(`\nState saved to: ${stateTracker.swarmDir}`)

  const lines = renderSwarmProgress(stateTracker.state)
  writeLine(lines.join('\n'))
  process.exit(result.status === 'completed' ? 0 : 1)
} catch (error_) {
  const error = error_ instanceof Error ? error_ : new Error(String(error_))
  console.error(error.message)
  process.exit(1)
}

function definitionContainsAgents(definition: SwarmDefinition): boolean {
  if (definition.agents.size > 0) return true
  for (const graph of definition.graphs.values()) {
    if (
      graph.definition !== undefined &&
      definitionContainsAgents(graph.definition)
    ) {
      return true
    }
  }
  return false
}
