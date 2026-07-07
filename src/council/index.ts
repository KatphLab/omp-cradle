/**
 * Council Extension — multi-voice decision council using smol subagents.
 *
 * Registers:
 * - `/council <question>` — slash command
 * - `council` tool — LLM-callable tool
 *
 * Each council launches 4 voices (Architect, Skeptic, Pragmatist, Critic) in
 * parallel using the fast (smol) model, then synthesizes their analyses into
 * a structured verdict. All findings are reported to the main agent.
 */
import type { Model } from '@oh-my-pi/pi-catalog/types'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@oh-my-pi/pi-coding-agent'
import { runCouncil, type CouncilResult } from './runner'

export default function councilExtension(pi: ExtensionAPI): void {
  pi.setLabel('Council')

  pi.registerCommand('council', {
    description: 'Convene a council of smol subagents to analyze a question',
    handler: async (args, ctx) => {
      const trimmed = args.trim()
      if (!trimmed) {
        ctx.ui.notify('Usage: /council <question>', 'error')
        return
      }
      await handleCouncil(trimmed, ctx, pi)
    },
  })

  pi.registerTool({
    name: 'council',
    label: 'Council',
    description:
      'Run a fast multi-voice council on a question using smol subagents. ' +
      'Each voice (Architect, Skeptic, Pragmatist, Critic) analyzes independently ' +
      'in parallel, then a synthesis step produces a structured verdict. ' +
      'Returns markdown with all voices and the final verdict.',
    parameters: pi.zod.object({
      question: pi.zod.string(),
      context: pi.zod.string().optional(),
    }),
    async execute(
      _id: string,
      params: { question: string; context?: string },
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      ctx: ExtensionContext,
    ): Promise<{
      content: { type: 'text'; text: string }[]
      details?: CouncilResult
    }> {
      const result = await runCouncilWithModel(
        params.question,
        params.context,
        signal,
        ctx,
      )
      return formatToolResult(result)
    },
  })
}

// ─── Command handler ─────────────────────────────────────────────────────────

async function handleCouncil(
  question: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  ctx.ui.setWorkingMessage('Convening council voices…')

  const result = await runCouncilWithModel(question, undefined, undefined, ctx)

  if (result.error !== undefined) {
    ctx.ui.setWorkingMessage('')
    ctx.ui.notify(`Council error: ${result.error}`, 'error')
    return
  }

  ctx.ui.setWorkingMessage('Council complete.')

  // Build a structured report and send it to the main agent.
  const report = buildCouncilReport(question, result)
  pi.sendUserMessage(report, { deliverAs: 'followUp' })
}

// ─── Shared logic ────────────────────────────────────────────────────────────

function resolveModel(
  ctx: { models: ExtensionContext['models'] } | undefined,
): Model | undefined {
  if (ctx === undefined) return undefined
  const smol = ctx.models.resolve('pi/smol')
  if (smol !== undefined) return smol
  return ctx.models.current()
}

async function runCouncilWithModel(
  question: string,
  context: string | undefined,
  signal: AbortSignal | undefined,
  ctx: { models: ExtensionContext['models'] } | undefined,
): Promise<CouncilResult> {
  const model = resolveModel(ctx)
  if (model === undefined) {
    return {
      verdict: '',
      voiceResults: [],
      error:
        'No model available. Ensure pi/smol or a session model is configured.',
    }
  }
  return await runCouncil({ question, context, model, signal })
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function buildCouncilReport(question: string, result: CouncilResult): string {
  const parts: string[] = [`## Council Analysis: ${question}`, '']

  for (const voice of result.voiceResults) {
    parts.push(`### ${voice.voice}`)
    if (voice.error === undefined) {
      parts.push(voice.text)
    } else {
      parts.push(`Error: ${voice.error}`)
    }
    parts.push('')
  }

  if (result.verdict !== '') {
    parts.push('---', '', result.verdict, '')
  }

  return parts.join('\n')
}

function formatToolResult(result: CouncilResult): {
  content: { type: 'text'; text: string }[]
  details?: CouncilResult
} {
  if (result.error !== undefined) {
    return {
      content: [{ type: 'text', text: `Council error: ${result.error}` }],
      details: result,
    }
  }

  const parts: string[] = []

  for (const voice of result.voiceResults) {
    if (voice.error === undefined) {
      parts.push(`**${voice.voice}**: ${voice.text}`)
    } else {
      parts.push(`**${voice.voice}**: Error: ${voice.error}`)
    }
    parts.push('')
  }

  if (result.verdict !== '') {
    parts.push('---', '', result.verdict, '')
  }

  return {
    content: [{ type: 'text', text: parts.join('\n') }],
    details: result,
  }
}
