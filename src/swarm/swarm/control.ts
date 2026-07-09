import * as fs from 'node:fs/promises'
import path from 'node:path'
import { isSafeRelativePath, type SwarmNodeControl } from './schema'

type ControlAction = 'continue' | 'restart' | 'fail'

export interface ControlDecision {
  action: ControlAction
  target?: string
  reason?: string
}

interface ControlParseContext {
  nodeName: string
  control: SwarmNodeControl
}

export async function readNodeControlDecision(
  workspace: string,
  nodeName: string,
  control: SwarmNodeControl,
): Promise<ControlDecision> {
  try {
    const context = { nodeName, control }
    const content = await readControlSignal(workspace, context)
    return parseControlDecision(Bun.YAML.parse(content), context)
  } catch (error_) {
    throw normalizeError(error_)
  }
}

async function readControlSignal(
  workspace: string,
  context: ControlParseContext,
): Promise<string> {
  if (!isSafeRelativePath(context.control.signal)) throw notFoundError(context)

  const signalPath = path.resolve(workspace, context.control.signal)
  try {
    return await fs.readFile(signalPath, 'utf8')
  } catch {
    throw notFoundError(context)
  }
}

function parseControlDecision(
  parsed: unknown,
  context: ControlParseContext,
): ControlDecision {
  if (!isRecord(parsed)) {
    throw new Error(
      `Control signal '${context.control.signal}' for node '${context.nodeName}' must contain an object`,
    )
  }

  const action = parsed['action']
  if (!isControlAction(action)) throw invalidActionError(context)

  if (action === 'restart') return parseRestartDecision(parsed, context)
  return parseNonRestartDecision(action, parsed, context)
}

function parseRestartDecision(
  parsed: Record<string, unknown>,
  context: ControlParseContext,
): ControlDecision {
  const target = parsed['target']
  if (typeof target !== 'string' || target.trim().length === 0) {
    throw new Error(
      `Control signal '${context.control.signal}' for node '${context.nodeName}' restart action requires target`,
    )
  }

  const normalizedTarget = target.trim()
  if (!context.control.allowedRestartTargets.includes(normalizedTarget)) {
    throw new Error(
      `Control signal '${context.control.signal}' for node '${context.nodeName}' target '${normalizedTarget}' is not allowed`,
    )
  }

  const reason = requireReason('restart', parsed['reason'], context)
  return { action: 'restart', target: normalizedTarget, reason }
}

function parseNonRestartDecision(
  action: 'continue' | 'fail',
  parsed: Record<string, unknown>,
  context: ControlParseContext,
): ControlDecision {
  if (parsed['target'] !== undefined)
    throw disallowedTargetError(action, context)
  if (action === 'fail') {
    return { action, reason: requireReason(action, parsed['reason'], context) }
  }

  const reason = parsed['reason']
  if (typeof reason === 'string' && reason.trim().length > 0) {
    return { action, reason: reason.trim() }
  }
  return { action }
}

function requireReason(
  action: 'restart' | 'fail',
  value: unknown,
  context: ControlParseContext,
): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  throw new Error(
    `Control signal '${context.control.signal}' for node '${context.nodeName}' action '${action}' requires reason`,
  )
}

function notFoundError(context: ControlParseContext): Error {
  return new Error(
    `Control signal '${context.control.signal}' for node '${context.nodeName}' was not found`,
  )
}

function invalidActionError(context: ControlParseContext): Error {
  return new Error(
    `Control signal '${context.control.signal}' for node '${context.nodeName}' action must be one of: continue, restart, fail`,
  )
}

function disallowedTargetError(
  action: 'continue' | 'fail',
  context: ControlParseContext,
): Error {
  return new Error(
    `Control signal '${context.control.signal}' for node '${context.nodeName}' action '${action}' must not include target`,
  )
}

function isControlAction(value: unknown): value is ControlAction {
  return value === 'continue' || value === 'restart' || value === 'fail'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}
