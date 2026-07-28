import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { isSafeRelativePath } from './schema'

export const CONTROL_DECISION_TOOL_NAME = 'submit_control_decision'
export const REPEAT_DECISION_TOOL_NAME = 'submit_repeat_decision'

export interface ControlSignalToolChannel {
  scope: string
  signal: string
  allowedRestartTargets: string[]
}

export interface RepeatSignalToolChannel {
  scope: string
  signal: string
  successValue: string
  continueValue: string
}

export interface SwarmSignalToolContext {
  version: 1
  controls: ControlSignalToolChannel[]
  repeats: RepeatSignalToolChannel[]
}

function signalToolContextPath(swarmDirectory: string, runId: string): string {
  return path.join(swarmDirectory, 'context', `${runId}.signal-tools.json`)
}

export async function writeSignalToolContext(
  swarmDirectory: string,
  runId: string,
  context: SwarmSignalToolContext,
): Promise<void> {
  const contextPath = signalToolContextPath(swarmDirectory, runId)
  await fs.mkdir(path.dirname(contextPath), { recursive: true })
  await fs.writeFile(contextPath, `${JSON.stringify(context)}\n`)
}

export async function readSignalToolContext(
  sessionFile: string | undefined,
): Promise<SwarmSignalToolContext> {
  if (!sessionFile?.endsWith('.jsonl')) {
    throw new Error(
      'Swarm signal tools require a persisted swarm agent session',
    )
  }
  const contextPath = `${sessionFile.slice(0, -'.jsonl'.length)}.signal-tools.json`
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(contextPath, 'utf8'))
  } catch {
    throw new Error('Swarm signal tools are unavailable for this agent')
  }
  if (!isSignalToolContext(parsed)) {
    throw new Error('Swarm signal tool context is malformed')
  }
  return parsed
}

function isSignalToolContext(value: unknown): value is SwarmSignalToolContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'controls' in value &&
    Array.isArray(value.controls) &&
    value.controls.every(isControlSignalToolChannel) &&
    'repeats' in value &&
    Array.isArray(value.repeats) &&
    value.repeats.every(isRepeatSignalToolChannel)
  )
}

function isControlSignalToolChannel(
  value: unknown,
): value is ControlSignalToolChannel {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scope' in value &&
    typeof value.scope === 'string' &&
    'signal' in value &&
    typeof value.signal === 'string' &&
    'allowedRestartTargets' in value &&
    Array.isArray(value.allowedRestartTargets) &&
    value.allowedRestartTargets.every((target) => typeof target === 'string')
  )
}

function isRepeatSignalToolChannel(
  value: unknown,
): value is RepeatSignalToolChannel {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scope' in value &&
    typeof value.scope === 'string' &&
    'signal' in value &&
    typeof value.signal === 'string' &&
    'successValue' in value &&
    typeof value.successValue === 'string' &&
    'continueValue' in value &&
    typeof value.continueValue === 'string'
  )
}

export async function removeWorkspaceSignal(
  workspace: string,
  signal: string,
): Promise<void> {
  if (!isSafeRelativePath(signal)) {
    throw new Error('Swarm signal destination is not a safe workspace path')
  }
  await fs.rm(path.resolve(workspace, signal), { force: true })
}

export async function writeWorkspaceSignal(
  workspace: string,
  signal: string,
  content: string,
): Promise<void> {
  if (!isSafeRelativePath(signal)) {
    throw new Error('Swarm signal destination is not a safe workspace path')
  }
  const destination = path.resolve(workspace, signal)
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  )
  await fs.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' })
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}
