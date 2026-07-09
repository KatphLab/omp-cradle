import {
  buildDependencyGraph,
  buildExecutionWaves,
  collectTransitiveDependencies,
  detectCycles,
} from './dag'
import { type SwarmDefinition, validateSwarmDefinition } from './schema'

export function preflightSwarmDefinition(
  swarmDefinition: SwarmDefinition,
): string[] {
  const errors: string[] = []
  collectPreflightErrors(swarmDefinition, errors)
  return errors
}

export function buildValidatedExecutionWaves(
  swarmDefinition: SwarmDefinition,
): string[][] {
  const dependencies = buildDependencyGraph(swarmDefinition)
  const cycleNodes = detectCycles(dependencies)
  if (cycleNodes !== undefined) {
    throw new Error(
      `Cycle detected in node dependencies: [${cycleNodes.join(', ')}]`,
    )
  }
  return buildExecutionWaves(dependencies)
}

function collectPreflightErrors(
  swarmDefinition: SwarmDefinition,
  errors: string[],
): void {
  const prefix =
    swarmDefinition.sourcePath === undefined
      ? ''
      : `${swarmDefinition.sourcePath}: `
  errors.push(
    ...[
      ...validateSwarmDefinition(swarmDefinition),
      ...validateControlRestartTargets(swarmDefinition),
    ].map((error) => `${prefix}${error}`),
  )

  try {
    buildValidatedExecutionWaves(swarmDefinition)
  } catch (error_) {
    const error = error_ instanceof Error ? error_.message : String(error_)
    errors.push(`${prefix}${error}`)
  }

  for (const graph of swarmDefinition.graphs.values()) {
    if (graph.definition !== undefined) {
      collectPreflightErrors(graph.definition, errors)
    }
  }
}

function validateControlRestartTargets(
  swarmDefinition: SwarmDefinition,
): string[] {
  const errors: string[] = []
  const dependencies = buildDependencyGraph(swarmDefinition)

  for (const [name, agent] of swarmDefinition.agents) {
    if (agent.control !== undefined) {
      validateNodeControlRestartTargets(
        'Agent',
        name,
        agent.control.allowedRestartTargets,
        dependencies,
        errors,
      )
    }
  }

  for (const [name, graph] of swarmDefinition.graphs) {
    if (graph.control !== undefined) {
      validateNodeControlRestartTargets(
        'Graph',
        name,
        graph.control.allowedRestartTargets,
        dependencies,
        errors,
      )
    }
  }

  return errors
}

function validateNodeControlRestartTargets(
  label: 'Agent' | 'Graph',
  name: string,
  targets: string[],
  dependencies: Map<string, Set<string>>,
  errors: string[],
): void {
  const upstream = collectTransitiveDependencies(dependencies, name)
  for (const target of targets) {
    if (!dependencies.has(target)) continue
    if (target === name || upstream.has(target)) continue
    errors.push(
      `${label} '${name}' control.allowed_restart_targets '${target}' must be the node itself or an upstream dependency`,
    )
  }
}
