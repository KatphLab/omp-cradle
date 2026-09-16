import type {
  CustomTool,
  ExtensionAPI,
  ExtensionContext,
} from '@oh-my-pi/pi-coding-agent'
import {
  readSignalToolContext,
  writeWorkspaceSignal,
} from './swarm/signal-tool-context'

interface ContinueDecisionInput {
  action: 'continue'
  scope?: string
  reason?: string
}
interface RestartDecisionInput {
  action: 'restart'
  scope?: string
  target: string
  reason: string
}
interface FailDecisionInput {
  action: 'fail'
  scope?: string
  reason: string
}
type ControlDecisionInput =
  ContinueDecisionInput | RestartDecisionInput | FailDecisionInput
interface RepeatDecisionInput {
  action: 'complete' | 'continue'
  scope?: string
}

interface DecisionContext<T> {
  params: T
  signal: AbortSignal | undefined
  cwd: string
  sessionFile: string | undefined
  submitted: Set<string>
}

function decisionContext<T>(
  params: T,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  submitted: Set<string>,
): DecisionContext<T> {
  return {
    params,
    signal,
    cwd: ctx.cwd,
    sessionFile: ctx.sessionManager.getSessionFile(),
    submitted,
  }
}
export function registerSwarmSignalTools(pi: ExtensionAPI): void {
  registerControlDecisionTool(pi, new Set())
  registerRepeatDecisionTool(pi, new Set())
}

function registerControlDecisionTool(
  pi: ExtensionAPI,
  submitted: Set<string>,
): void {
  const nonEmptyString = pi.zod.string().regex(/\S/)
  const scope = nonEmptyString.optional()
  const reason = nonEmptyString
  pi.registerTool({
    name: 'submit_control_decision',
    label: 'Submit Swarm Control Decision',
    description:
      'Submit a validated continue, restart, or fail decision for the current swarm node. Omit scope when only one control channel is available.',
    parameters: pi.zod.union([
      pi.zod
        .object({
          action: pi.zod.literal('continue'),
          scope,
          reason: reason.optional(),
        })
        .strict(),
      pi.zod
        .object({
          action: pi.zod.literal('restart'),
          scope,
          target: nonEmptyString,
          reason,
        })
        .strict(),
      pi.zod.object({ action: pi.zod.literal('fail'), scope, reason }).strict(),
    ]),
    async execute(
      _id: string,
      params: ControlDecisionInput,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      ctx: ExtensionContext,
    ) {
      await submitControlDecision(
        decisionContext(params, signal, ctx, submitted),
      )
      return toolResult(`Recorded '${params.action}'`)
    },
  })
}

function registerRepeatDecisionTool(
  pi: ExtensionAPI,
  submitted: Set<string>,
): void {
  pi.registerTool({
    name: 'submit_repeat_decision',
    label: 'Submit Swarm Repeat Decision',
    description:
      'Submit a validated complete or continue decision for the current repeated swarm graph. Omit scope when only one repeat channel is available.',
    parameters: pi.zod
      .object({
        action: pi.zod.enum(['complete', 'continue']),
        scope: pi.zod.string().regex(/\S/).optional(),
      })
      .strict(),
    async execute(
      _id: string,
      params: RepeatDecisionInput,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      ctx: ExtensionContext,
    ) {
      await submitRepeatDecision(
        decisionContext(params, signal, ctx, submitted),
      )
      return toolResult(`Recorded '${params.action}'`)
    },
  })
}

async function submitControlDecision(
  context: DecisionContext<ControlDecisionInput>,
): Promise<void> {
  const { params, signal, cwd, sessionFile, submitted } = context
  if (params.scope !== undefined) params.scope = params.scope.trim()
  if (params.action === 'restart') params.target = params.target.trim()
  if (params.reason !== undefined) params.reason = params.reason.trim()
  assertNotAborted(signal)
  const signalContext = await readSignalToolContext(sessionFile)
  const channel = resolveChannel(
    signalContext.controls,
    params.scope,
    'control',
  )
  if (submitted.has(channel.scope))
    throw new Error(
      `Control decision for scope '${channel.scope}' was already submitted`,
    )
  if (
    params.action === 'restart' &&
    !channel.allowedRestartTargets.includes(params.target)
  )
    throw new Error(
      `Restart target '${params.target}' is not allowed for scope '${channel.scope}'; allowed targets: ${channel.allowedRestartTargets.join(', ')}`,
    )
  await writeWorkspaceSignal(cwd, channel.signal, renderControlDecision(params))
  submitted.add(channel.scope)
}

async function submitRepeatDecision(
  context: DecisionContext<RepeatDecisionInput>,
): Promise<void> {
  const { params, signal, cwd, sessionFile, submitted } = context
  if (params.scope !== undefined) params.scope = params.scope.trim()
  assertNotAborted(signal)
  const signalContext = await readSignalToolContext(sessionFile)
  const channel = resolveChannel(signalContext.repeats, params.scope, 'repeat')
  if (submitted.has(channel.scope))
    throw new Error(
      `Repeat decision for scope '${channel.scope}' was already submitted`,
    )
  const value =
    params.action === 'complete' ? channel.successValue : channel.continueValue
  await writeWorkspaceSignal(cwd, channel.signal, `${value}\n`)
  submitted.add(channel.scope)
}

function resolveChannel<T extends { scope: string }>(
  channels: T[],
  requestedScope: string | undefined,
  kind: 'control' | 'repeat',
): T {
  if (channels.length === 0)
    throw new Error(`No ${kind} decision is configured for this swarm agent`)
  const singleChannel = channels[0]
  if (
    singleChannel !== undefined &&
    requestedScope === undefined &&
    channels.length === 1
  )
    return singleChannel
  if (requestedScope === undefined)
    throw new Error(
      `Multiple ${kind} scopes are available; choose one of: ${channels.map(({ scope }) => scope).join(', ')}`,
    )
  const channel = channels.find(({ scope }) => scope === requestedScope)
  if (channel === undefined)
    throw new Error(
      `Unknown ${kind} scope '${requestedScope}'; available scopes: ${channels.map(({ scope }) => scope).join(', ')}`,
    )
  return channel
}

function renderControlDecision(params: ControlDecisionInput): string {
  const lines = [`action: ${params.action}`]
  if (params.action === 'restart') lines.push(`target: ${params.target}`)
  if (params.reason !== undefined)
    lines.push(`reason: ${JSON.stringify(params.reason)}`)
  return `${lines.join('\n')}\n`
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Swarm signal submission was cancelled')
}

function toolResult(text: string): {
  content: { type: 'text'; text: string }[]
} {
  return { content: [{ type: 'text', text }] }
}

function isSignalRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseControlDecision(value: unknown): ControlDecisionInput {
  if (!isSignalRecord(value) || typeof value['action'] !== 'string')
    throw new Error('Invalid control decision')
  const scope = value['scope']
  if (scope !== undefined && typeof scope !== 'string')
    throw new Error('Control scope must be a string')
  switch (value['action']) {
    case 'continue': {
      return {
        action: 'continue',
        ...(scope === undefined ? {} : { scope }),
        ...(typeof value['reason'] === 'string'
          ? { reason: value['reason'] }
          : {}),
      }
    }
    case 'fail': {
      return parseFailDecision(value, scope)
    }
    case 'restart': {
      return parseRestartDecision(value, scope)
    }
    default: {
      throw new Error('Invalid control decision')
    }
  }
}

function parseFailDecision(
  value: Record<string, unknown>,
  scope: string | undefined,
): FailDecisionInput {
  const reason = value['reason']
  if (typeof reason !== 'string' || reason.trim() === '')
    throw new Error('Invalid control decision')
  return { action: 'fail', reason, ...(scope === undefined ? {} : { scope }) }
}

function parseRestartDecision(
  value: Record<string, unknown>,
  scope: string | undefined,
): RestartDecisionInput {
  const target = value['target']
  const reason = value['reason']
  if (
    typeof target !== 'string' ||
    target.trim() === '' ||
    typeof reason !== 'string' ||
    reason.trim() === ''
  )
    throw new Error('Invalid control decision')
  return {
    action: 'restart',
    target,
    reason,
    ...(scope === undefined ? {} : { scope }),
  }
}

function parseRepeatDecision(value: unknown): RepeatDecisionInput {
  if (
    !isSignalRecord(value) ||
    (value['action'] !== 'complete' && value['action'] !== 'continue')
  )
    throw new Error('Invalid repeat decision')
  const scope = value['scope']
  if (scope !== undefined && typeof scope !== 'string')
    throw new Error('Repeat scope must be a string')
  return { action: value['action'], ...(scope === undefined ? {} : { scope }) }
}

export function createSwarmSignalTools(): CustomTool[] {
  return [createControlSignalTool(new Set()), createRepeatSignalTool(new Set())]
}

function createControlSignalTool(submitted: Set<string>): CustomTool {
  return {
    name: 'submit_control_decision',
    label: 'Submit Swarm Control Decision',
    strict: false,
    description:
      'Submit a continue, restart, or fail decision. Omit scope when only one channel exists; do not invent scope. target is only for restart. reason is required for restart and fail.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['continue', 'restart', 'fail'] },
        scope: { type: 'string' },
        target: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(_id, rawParameters, _onUpdate, ctx, signal) {
      const params = parseControlDecision(rawParameters)
      await submitControlDecision({
        params,
        signal,
        cwd: ctx.sessionManager.getCwd(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        submitted,
      })
      return toolResult(`Recorded '${params.action}'`)
    },
  } as CustomTool
}

function createRepeatSignalTool(submitted: Set<string>): CustomTool {
  return {
    name: 'submit_repeat_decision',
    label: 'Submit Swarm Repeat Decision',
    strict: false,
    description: 'Submit the current repeated swarm graph decision.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['complete', 'continue'] },
        scope: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(_id, rawParameters, _onUpdate, ctx, signal) {
      const params = parseRepeatDecision(rawParameters)
      await submitRepeatDecision({
        params,
        signal,
        cwd: ctx.sessionManager.getCwd(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        submitted,
      })
      return toolResult(`Recorded '${params.action}'`)
    },
  } as CustomTool
}
