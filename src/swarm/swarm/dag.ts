/**
 * Directed Acyclic Graph operations for swarm agent dependencies.
 *
 * Builds a dependency graph from waits_for / reports_to relationships,
 * detects cycles, and produces execution waves via topological sort.
 */
import type { SwarmDefinition } from './schema'

export function buildDependencyGraph(
  swarmDefinition: SwarmDefinition,
): Map<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>()

  for (const name of swarmDefinition.agents.keys()) {
    dependencies.set(name, new Set())
  }

  addWaitDependencies(dependencies, swarmDefinition)
  addReportDependencies(dependencies, swarmDefinition)
  addImplicitSequentialDependencies(dependencies, swarmDefinition)

  return dependencies
}

function addDependency(
  dependencies: Map<string, Set<string>>,
  name: string,
  dependency: string,
): void {
  dependencies.get(name)?.add(dependency)
}

function addWaitDependencies(
  dependencies: Map<string, Set<string>>,
  swarmDefinition: SwarmDefinition,
): void {
  for (const [name, agent] of swarmDefinition.agents) {
    for (const dependency of agent.waitsFor) {
      if (dependencies.has(dependency)) {
        addDependency(dependencies, name, dependency)
      }
    }
  }
}

function addReportDependencies(
  dependencies: Map<string, Set<string>>,
  swarmDefinition: SwarmDefinition,
): void {
  for (const [name, agent] of swarmDefinition.agents) {
    for (const target of agent.reportsTo) {
      if (dependencies.has(target)) {
        addDependency(dependencies, target, name)
      }
    }
  }
}

function addImplicitSequentialDependencies(
  dependencies: Map<string, Set<string>>,
  swarmDefinition: SwarmDefinition,
): void {
  if (!usesImplicitSequencing(swarmDefinition, dependencies)) return

  for (let index = 1; index < swarmDefinition.agentOrder.length; index++) {
    const name = swarmDefinition.agentOrder[index]
    const dependency = swarmDefinition.agentOrder[index - 1]
    if (name !== undefined && dependency !== undefined) {
      addDependency(dependencies, name, dependency)
    }
  }
}

function usesImplicitSequencing(
  swarmDefinition: SwarmDefinition,
  dependencies: Map<string, Set<string>>,
): boolean {
  return (
    (swarmDefinition.mode === 'pipeline' ||
      swarmDefinition.mode === 'sequential') &&
    !hasExplicitDependencies(dependencies)
  )
}

function hasExplicitDependencies(
  dependencies: Map<string, Set<string>>,
): boolean {
  return [...dependencies.values()].some(
    (dependencySet) => dependencySet.size > 0,
  )
}

export function detectCycles(
  dependencies: Map<string, Set<string>>,
): string[] | undefined {
  const { inDegree, forward } = buildTopologicalIndexes(dependencies)
  const sorted = collectTopologicalOrder(inDegree, forward)

  if (sorted.length === dependencies.size) return undefined

  const sortedNodes = new Set(sorted)
  return [...dependencies.keys()].filter((key) => !sortedNodes.has(key))
}

function buildTopologicalIndexes(dependencies: Map<string, Set<string>>): {
  inDegree: Map<string, number>
  forward: Map<string, string[]>
} {
  const inDegree = new Map<string, number>()
  const forward = new Map<string, string[]>()

  for (const [node, nodeDependencies] of dependencies) {
    inDegree.set(node, nodeDependencies.size)
    for (const dependency of nodeDependencies) {
      const dependents = forward.get(dependency) ?? []
      dependents.push(node)
      forward.set(dependency, dependents)
    }
  }

  return { inDegree, forward }
}

function collectTopologicalOrder(
  inDegree: Map<string, number>,
  forward: Map<string, string[]>,
): string[] {
  const queue = [...inDegree]
    .filter(([, degree]) => degree === 0)
    .map(([node]) => node)
  const sorted: string[] = []

  while (queue.length > 0) {
    const node = queue.shift()
    if (node === undefined) continue
    sorted.push(node)

    for (const dependent of forward.get(node) ?? []) {
      const currentDegree = inDegree.get(dependent)
      if (currentDegree === undefined) continue
      const newDegree = currentDegree - 1
      inDegree.set(dependent, newDegree)
      if (newDegree === 0) queue.push(dependent)
    }
  }

  return sorted
}

export function buildExecutionWaves(
  dependencies: Map<string, Set<string>>,
): string[][] {
  const waves: string[][] = []
  const completed = new Set<string>()
  const remaining = new Set(dependencies.keys())

  while (remaining.size > 0) {
    const wave = getReadyNodes(remaining, dependencies, completed)
    if (wave.length === 0) {
      throw new Error(
        `Deadlock: agents [${[...remaining].join(', ')}] cannot make progress. This indicates a bug in cycle detection.`,
      )
    }

    wave.sort((left, right) => left.localeCompare(right))
    for (const node of wave) {
      remaining.delete(node)
      completed.add(node)
    }
    waves.push(wave)
  }

  return waves
}

function getReadyNodes(
  remaining: Set<string>,
  dependencies: Map<string, Set<string>>,
  completed: Set<string>,
): string[] {
  return [...remaining].filter((node) => {
    const nodeDependencies = dependencies.get(node)
    return (
      nodeDependencies !== undefined &&
      [...nodeDependencies].every((dependency) => completed.has(dependency))
    )
  })
}
