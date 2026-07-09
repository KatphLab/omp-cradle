import type { BashResult } from '@oh-my-pi/pi-coding-agent/exec/bash-executor'
import { executeBash } from '@oh-my-pi/pi-coding-agent/exec/bash-executor'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import type { SwarmBashNode } from './schema'
import type { StateTracker } from './state'

export interface BashNodeExecutorOptions {
  workspace: string
  swarmName: string
  iteration: number
  attempt: number
  signal?: AbortSignal
  stateTracker: StateTracker
}

export interface BashNodeResult {
  index: number
  id: string
  node: string
  command: string
  exitCode: number
  outputPath: string
  output: string
  truncated: boolean
  durationMs: number
  error?: string
}

export async function executeSwarmBashNode(
  node: SwarmBashNode,
  index: number,
  options: BashNodeExecutorOptions,
): Promise<BashNodeResult> {
  const startedAt = Date.now()
  const cwd = node.cwd
    ? path.resolve(options.workspace, node.cwd)
    : options.workspace
  const resolvedOutputPath = path.resolve(options.workspace, node.outputPath)
  const id = `swarm-${options.swarmName}-${node.name}-${options.iteration}-attempt${options.attempt}`

  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true })
  await options.stateTracker.updateBashNode(node.name, {
    status: 'running',
    iteration: options.iteration,
    attempt: options.attempt,
    startedAt,
    outputPath: node.outputPath,
  })
  await options.stateTracker.appendNodeLog(
    node.name,
    `Starting bash command iteration ${options.iteration + 1} attempt ${options.attempt}`,
  )

  try {
    const result = await executeBash(node.command, {
      cwd,
      artifactPath: resolvedOutputPath,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    await writeFileIfMissing(resolvedOutputPath, result.output)
    const exitCode = normalizeExitCode(result)
    const completedAt = Date.now()
    const bashResult: BashNodeResult = {
      index,
      id,
      node: node.name,
      command: node.command,
      exitCode,
      outputPath: node.outputPath,
      output: result.output,
      truncated: result.truncated,
      durationMs: completedAt - startedAt,
    }
    await options.stateTracker.updateBashNode(node.name, {
      status: 'completed',
      completedAt,
      exitCode,
      outputPath: node.outputPath,
    })
    await options.stateTracker.appendNodeLog(
      node.name,
      `Iteration ${options.iteration + 1} completed with exit code ${exitCode}`,
    )
    return bashResult
  } catch (error_) {
    const error = normalizeThrownError(error_)
    await writeFileIfMissing(resolvedOutputPath, error.message)
    await options.stateTracker.updateBashNode(node.name, {
      status: 'failed',
      completedAt: Date.now(),
      exitCode: options.signal?.aborted ? 130 : 1,
      outputPath: node.outputPath,
      error: options.signal?.aborted ? 'command cancelled' : error.message,
    })
    await options.stateTracker.appendNodeLog(
      node.name,
      `Iteration ${options.iteration + 1} failed: ${options.signal?.aborted ? 'command cancelled' : error.message}`,
    )
    throw error
  }
}

function normalizeExitCode(result: BashResult): number {
  if (typeof result.exitCode === 'number') return result.exitCode
  if (result.cancelled) return 130
  return 1
}

async function writeFileIfMissing(
  filePath: string,
  output: string,
): Promise<void> {
  try {
    await fs.access(filePath)
  } catch {
    await fs.writeFile(filePath, output)
  }
}

function normalizeThrownError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}
