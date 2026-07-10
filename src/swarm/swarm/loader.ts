import * as fs from 'node:fs/promises'
import path from 'node:path'
import { parseSwarmYaml, type SwarmDefinition } from './schema'

export async function loadSwarmDefinitionFile(
  resolvedPath: string,
): Promise<SwarmDefinition> {
  try {
    return await loadSwarmDefinitionFileInternal(path.resolve(resolvedPath), [])
  } catch (error_) {
    throw normalizeError(error_)
  }
}

async function loadSwarmDefinitionFileInternal(
  resolvedPath: string,
  stack: string[],
): Promise<SwarmDefinition> {
  const absolutePath = path.resolve(resolvedPath)
  if (stack.includes(absolutePath)) {
    const stackWithCurrent = [...stack, absolutePath]
    throw new Error(
      `Graph import cycle detected: ${stackWithCurrent.join(' -> ')}`,
    )
  }

  const content = await fs.readFile(absolutePath, 'utf8')
  const definition = parseSwarmYaml(content)
  definition.sourcePath = absolutePath
  definition.sourceDir = path.dirname(absolutePath)

  await hydrateGraphDefinitions(definition, [...stack, absolutePath])
  return definition
}

async function hydrateGraphDefinitions(
  definition: SwarmDefinition,
  stack: string[],
): Promise<void> {
  if (
    definition.sourcePath === undefined ||
    definition.sourceDir === undefined
  ) {
    throw new Error(`Swarm '${definition.name}' has no source location`)
  }

  for (const graph of definition.graphs.values()) {
    if (graph.path !== undefined) {
      const childPath = path.resolve(definition.sourceDir, graph.path)
      graph.resolvedPath = childPath
      graph.definition = await loadSwarmDefinitionFileInternal(childPath, stack)
      continue
    }

    if (graph.definition !== undefined) {
      graph.definition.sourcePath = definition.sourcePath
      graph.definition.sourceDir = definition.sourceDir
      await hydrateGraphDefinitions(graph.definition, stack)
    }
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}
