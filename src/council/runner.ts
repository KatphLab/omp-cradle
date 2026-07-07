/**
 * Council orchestration: runs four voices in parallel using a fast (smol) model,
 * then synthesizes their analyses into a structured verdict.
 */
import type { Context } from '@oh-my-pi/pi-ai'
import { complete } from '@oh-my-pi/pi-ai/stream'
import type { Model } from '@oh-my-pi/pi-catalog/types'
import { SYNTHESIS_PROMPT, VOICES } from './prompts'

interface VoiceResult {
  readonly voice: string
  readonly text: string
  readonly error?: string
}

export interface CouncilResult {
  readonly verdict: string
  readonly voiceResults: VoiceResult[]
  readonly error?: string
}

/** Build a completion context for one voice. */
function buildVoiceContext(
  systemPrompt: string,
  question: string,
  extraContext: string | undefined,
): Context {
  const parts = [question]
  if (extraContext !== undefined) parts.push(`\n\nContext:\n${extraContext}`)
  return {
    systemPrompt: [systemPrompt],
    messages: [
      { role: 'user', content: parts.join(''), timestamp: Date.now() },
    ],
  }
}

/** Extract text from an assistant response, joining multiple text blocks. */
function extractText(msg: { content: unknown[] }): string {
  const blocks: string[] = []
  for (const block of msg.content) {
    if (block && typeof block === 'object' && 'text' in block) {
      const text: unknown = block.text
      if (typeof text === 'string') blocks.push(text)
    }
  }
  return blocks.join('\n')
}

/** Run a single voice and return its analysis. */
async function runVoice(
  model: Model,
  voice: string,
  systemPrompt: string,
  question: string,
  extraContext: string | undefined,
  signal: AbortSignal | undefined,
): Promise<VoiceResult> {
  try {
    const ctx = buildVoiceContext(systemPrompt, question, extraContext)
    const opts: { signal?: AbortSignal } = {}
    if (signal !== undefined) opts.signal = signal
    const response = await complete(model, ctx, opts)
    const text = extractText(response)
    return { voice, text: text || '(no output)' }
  } catch (error: unknown) {
    return {
      voice,
      text: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Synthesize voice analyses into a structured verdict. */
async function synthesize(
  model: Model,
  question: string,
  extraContext: string | undefined,
  voiceResults: VoiceResult[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const voicesBlock = voiceResults
    .map((v) => {
      const detail = v.error === undefined ? v.text : `Error: ${v.error}`
      return `### ${v.voice}\n${detail}`
    })
    .join('\n\n')

  const contextBlock =
    extraContext === undefined ? '' : `Context:\n${extraContext}\n\n`
  const userMessage = `${contextBlock}Question: ${question}\n\n## Voice Analyses\n\n${voicesBlock}`

  const opts: { signal?: AbortSignal } = {}
  if (signal !== undefined) opts.signal = signal

  const response = await complete(
    model,
    {
      systemPrompt: [SYNTHESIS_PROMPT],
      messages: [{ role: 'user', content: userMessage, timestamp: Date.now() }],
    },
    opts,
  )

  return extractText(response) || '(no verdict produced)'
}

/**
 * Run the full council: voices in parallel, then synthesis.
 * All calls use the resolved smol model.
 */
export async function runCouncil(params: {
  question: string
  context: string | undefined
  model: Model
  signal: AbortSignal | undefined
}): Promise<CouncilResult> {
  const { question, context, model, signal } = params

  // Run all voices in parallel
  const voiceResults = await Promise.all(
    VOICES.map((v) =>
      runVoice(model, v.name, v.systemPrompt, question, context, signal),
    ),
  )

  // If all voices failed, return early
  const errors = voiceResults.filter((v) => v.error !== undefined)
  if (errors.length === voiceResults.length) {
    const summaries = errors
      .map((error) => `${error.voice}: ${error.error ?? 'unknown'}`)
      .join('; ')
    return {
      verdict: '',
      voiceResults,
      error: `All voices failed: ${summaries}`,
    }
  }

  // Synthesize
  try {
    const verdict = await synthesize(
      model,
      question,
      context,
      voiceResults,
      signal,
    )
    return { verdict, voiceResults }
  } catch (error: unknown) {
    return {
      verdict: '',
      voiceResults,
      error: `Synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
