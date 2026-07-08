#!/usr/bin/env bun
/**
 * Direct pipeline runner — executes a swarm pipeline outside of the TUI.
 *
 * Usage: bun cli.ts <path-to-yaml>
 */

import { discoverAuthStorage } from '@oh-my-pi/pi-coding-agent'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {
  buildDependencyGraph,
  buildExecutionWaves,
  detectCycles,
} from './swarm/dag'
import { PipelineController } from './swarm/pipeline'
import { renderSwarmProgress } from './swarm/render'
import { parseSwarmYaml, validateSwarmDefinition } from './swarm/schema'
import { StateTracker } from './swarm/state'

function writeLine(message = ''): void {
  process.stdout.write(`${message}\n`)
}

class TerminalProgressRenderer {
  #renderedLines = 0

  clear(): void {
    if (this.#renderedLines === 0) return

    this.#moveToBlockStart()
    this.#clearLines(this.#renderedLines)
    this.#renderedLines = 0
  }

  render(lines: readonly string[]): void {
    if (!process.stdout.isTTY) {
      writeLine(lines.join('\n'))
      writeLine()
      return
    }

    if (this.#renderedLines > 0) {
      this.#moveToBlockStart()
      this.#clearLines(this.#renderedLines)
    }

    process.stdout.write(lines.join('\n'))
    process.stdout.write('\n')
    this.#renderedLines = lines.length
  }

  #moveToBlockStart(): void {
    process.stdout.write(`\u001B[${this.#renderedLines}A`)
  }

  #clearLines(count: number): void {
    for (let index = 0; index < count; index++) {
      process.stdout.write('\u001B[2K\r')
      if (index < count - 1) process.stdout.write('\u001B[1B')
    }
    process.stdout.write(`\u001B[${count - 1}A`)
  }
}

const yamlPath = process.argv[2]
if (!yamlPath) {
  console.error('Usage: omp-swarm <path-to-yaml>')
  process.exit(1)
}

const resolvedPath = path.resolve(yamlPath)
writeLine(`Reading: ${resolvedPath}`)

const content = await fs.readFile(resolvedPath, 'utf8')
const swarmDefinition = parseSwarmYaml(content)

writeLine(`Swarm: ${swarmDefinition.name}`)
writeLine(`Mode: ${swarmDefinition.mode}`)
writeLine(`Target count: ${swarmDefinition.targetCount}`)
writeLine(`Agents: ${[...swarmDefinition.agents.keys()].join(', ')}`)

const errors = validateSwarmDefinition(swarmDefinition)
if (errors.length > 0) {
  console.error('Validation errors:', errors)
  process.exit(1)
}

const dependencies = buildDependencyGraph(swarmDefinition)
const cycles = detectCycles(dependencies)
if (cycles) {
  console.error('Cycle detected:', cycles)
  process.exit(1)
}
const waves = buildExecutionWaves(dependencies)
const waveSummary = waves
  .map((wave, index) => `W${index + 1}:[${wave.join(',')}]`)
  .join(' -> ')
writeLine(`Waves: ${waveSummary}`)

const workspace = path.isAbsolute(swarmDefinition.workspace)
  ? swarmDefinition.workspace
  : path.resolve(path.dirname(resolvedPath), swarmDefinition.workspace)

await fs.mkdir(workspace, { recursive: true })
writeLine(`Workspace: ${workspace}`)

const stateTracker = new StateTracker(workspace, swarmDefinition.name)
await stateTracker.init(
  [...swarmDefinition.agents.keys()],
  swarmDefinition.targetCount,
  swarmDefinition.mode,
)

const authStorage = await discoverAuthStorage()
const modelRegistry = new ModelRegistry(authStorage)
const settings = await Settings.loadReadOnly()

let lastProgressDump = 0
const PROGRESS_INTERVAL_MS = 5000
const progressRenderer = new TerminalProgressRenderer()

writeLine('\n--- Pipeline starting ---\n')

const controller = new PipelineController(swarmDefinition, waves, stateTracker)
const result = await controller.run({
  workspace,
  onProgress: () => {
    const now = Date.now()
    if (now - lastProgressDump > PROGRESS_INTERVAL_MS) {
      lastProgressDump = now
      progressRenderer.render(renderSwarmProgress(stateTracker.state))
    }
  },
  modelRegistry,
  settings,
})

progressRenderer.clear()
writeLine('\n--- Pipeline finished ---\n')
writeLine(`Status: ${result.status}`)
writeLine(
  `Iterations completed: ${result.iterations}/${swarmDefinition.targetCount}`,
)
if (result.errors.length > 0) {
  writeLine(`Errors (${result.errors.length}):`)
  for (const error of result.errors) {
    writeLine(`  - ${error}`)
  }
}
writeLine(`\nState saved to: ${stateTracker.swarmDir}`)

const lines = renderSwarmProgress(stateTracker.state)
writeLine(lines.join('\n'))
