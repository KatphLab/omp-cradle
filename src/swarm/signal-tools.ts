import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
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

export function registerSwarmSignalTools(pi: ExtensionAPI): void {
  registerControlDecisionTool(pi, new Set())
  registerRepeatDecisionTool(pi, new Set())
}

function registerControlDecisionTool(
  pi: ExtensionAPI,
  submitted: Set<string>,
): void {
  const nonEmptyString = pi.zod
    .string()
    .regex(/\S/)
    .transform((value) => value.trim())
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
      pi.zod
        .object({
          action: pi.zod.literal('fail'),
          scope,
          reason,
        })
        .strict(),
    ]),
    async execute(
      _id: string,
      params: ControlDecisionInput,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      ctx: ExtensionContext,
    ) {
      assertNotAborted(signal)
      const context = await readSignalToolContext(
        ctx.sessionManager.getSessionFile() ?? undefined,
      )
      const channel = resolveChannel(context.controls, params.scope, 'control')
      if (submitted.has(channel.scope)) {
        throw new Error(
          `Control decision for scope '${channel.scope}' was already submitted`,
        )
      }
      if (
        params.action === 'restart' &&
        !channel.allowedRestartTargets.includes(params.target)
      ) {
        throw new Error(
          `Restart target '${params.target}' is not allowed for scope '${channel.scope}'; allowed targets: ${channel.allowedRestartTargets.join(', ')}`,
        )
      }
      await writeWorkspaceSignal(
        ctx.cwd,
        channel.signal,
        renderControlDecision(params),
      )
      submitted.add(channel.scope)
      return toolResult(
        `Recorded '${params.action}' for control scope '${channel.scope}'`,
      )
    },
  })
}

function registerRepeatDecisionTool(
  pi: ExtensionAPI,
  submitted: Set<string>,
): void {
  const scope = pi.zod
    .string()
    .regex(/\S/)
    .transform((value) => value.trim())
    .optional()
  pi.registerTool({
    name: 'submit_repeat_decision',
    label: 'Submit Swarm Repeat Decision',
    description:
      'Submit a validated complete or continue decision for the current repeated swarm graph. Omit scope when only one repeat channel is available.',
    parameters: pi.zod
      .object({
        action: pi.zod.enum(['complete', 'continue']),
        scope,
      })
      .strict(),
    async execute(
      _id: string,
      params: RepeatDecisionInput,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      ctx: ExtensionContext,
    ) {
      assertNotAborted(signal)
      const context = await readSignalToolContext(
        ctx.sessionManager.getSessionFile() ?? undefined,
      )
      const channel = resolveChannel(context.repeats, params.scope, 'repeat')
      if (submitted.has(channel.scope)) {
        throw new Error(
          `Repeat decision for scope '${channel.scope}' was already submitted`,
        )
      }
      const value =
        params.action === 'complete'
          ? channel.successValue
          : channel.continueValue
      await writeWorkspaceSignal(ctx.cwd, channel.signal, `${value}\n`)
      submitted.add(channel.scope)
      return toolResult(
        `Recorded '${params.action}' for repeat scope '${channel.scope}'`,
      )
    },
  })
}

function resolveChannel<T extends { scope: string }>(
  channels: T[],
  requestedScope: string | undefined,
  kind: 'control' | 'repeat',
): T {
  if (channels.length === 0) {
    throw new Error(`No ${kind} decision is configured for this swarm agent`)
  }
  if (requestedScope === undefined && channels.length === 1) {
    const channel = channels[0]
    if (channel !== undefined) return channel
  }
  if (requestedScope === undefined) {
    throw new Error(
      `Multiple ${kind} scopes are available; choose one of: ${channels.map(({ scope }) => scope).join(', ')}`,
    )
  }
  const channel = channels.find(({ scope }) => scope === requestedScope)
  if (channel === undefined) {
    throw new Error(
      `Unknown ${kind} scope '${requestedScope}'; available scopes: ${channels.map(({ scope }) => scope).join(', ')}`,
    )
  }
  return channel
}

function renderControlDecision(params: ControlDecisionInput): string {
  const lines = [`action: ${params.action}`]
  if (params.action === 'restart') lines.push(`target: ${params.target}`)
  if (params.reason !== undefined) {
    lines.push(`reason: ${JSON.stringify(params.reason)}`)
  }
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
