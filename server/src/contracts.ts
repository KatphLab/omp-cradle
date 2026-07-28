import type { AgentSession } from '@oh-my-pi/pi-coding-agent'
import { z } from 'zod'

import { ApiError } from './errors.js'

export type ThinkingLevelInput = Parameters<AgentSession['setThinkingLevel']>[0]

const pathSchema = z.string().trim().min(1).max(4096)
const textSchema = z.string().trim().min(1).max(1_000_000)
const modelSchema = z.string().trim().min(1).max(500)
const labelSchema = z.string().trim().min(1).max(200)
const thinkingLevelSchema = z.custom<ThinkingLevelInput>(
  (value) =>
    typeof value === 'string' &&
    [
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'auto',
    ].includes(value),
  'Invalid thinking level',
)

const createOptions = {
  label: labelSchema.optional(),
  model: modelSchema.optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
}

export const createSessionSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('new'),
      cwd: pathSchema,
      ...createOptions,
    })
    .strict(),
  z
    .object({
      mode: z.literal('resume'),
      sessionFile: pathSchema,
      ...createOptions,
    })
    .strict(),
])

export type CreateSessionRequest = z.infer<typeof createSessionSchema>

export const sessionParametersSchema = z.object({ id: z.uuid() }).strict()

export const historyQuerySchema = z.object({ cwd: pathSchema }).strict()

export const messagesQuerySchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict()

export const promptSchema = z
  .object({
    prompt: textSchema,
    streamingBehavior: z.enum(['steer', 'followUp']).optional(),
  })
  .strict()

export const messageSchema = z.object({ message: textSchema }).strict()

export const switchSessionSchema = z
  .object({ sessionFile: pathSchema })
  .strict()

export const branchSchema = z
  .object({ entryId: z.string().trim().min(1).max(200) })
  .strict()

export const compactSchema = z
  .object({ customInstructions: textSchema.optional() })
  .strict()

export const modelUpdateSchema = z.object({ model: modelSchema }).strict()

export const thinkingUpdateSchema = z
  .object({ thinkingLevel: thinkingLevelSchema })
  .strict()

export const nameUpdateSchema = z.object({ name: labelSchema }).strict()

export const emptyBodySchema = z.object({}).strict()

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new ApiError(
      400,
      'invalid_request',
      'Request validation failed',
      result.error,
    )
  }
  return result.data
}
