import type {
  CustomTool,
  CustomToolContext,
  ExtensionAPI,
} from '@oh-my-pi/pi-coding-agent'
import { resolveModelOverride } from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import {
  runSubprocess,
  type ExecutorOptions,
} from '@oh-my-pi/pi-coding-agent/task/executor'
import type {
  AgentDefinition,
  SingleResult,
} from '@oh-my-pi/pi-coding-agent/task/types'
import { randomUUID } from 'node:crypto'

const synthesisInstructions =
  'Synthesize these independent results: deduplicate findings, preserve disagreements, ' +
  'and attribute each finding to its reviewer and model alias. ' +
  'Report failed or aborted reviewers as incomplete coverage, not as no findings.'

const reviewerDefinitions: readonly {
  agent: AgentDefinition
  model: string
}[] = [
  {
    alias: 'reviewer-smol',
    description: 'Read-only small-model reviewer',
  },
  {
    alias: 'reviewer-default',
    description: 'Read-only default-model reviewer',
  },
  {
    alias: 'reviewer-slow',
    description: 'Read-only slow-model reviewer',
  },
].map(({ alias, description }) => {
  const model = `pi/${alias.slice('reviewer-'.length)}`
  return {
    model,
    agent: {
      name: alias,
      description,
      systemPrompt:
        'Review the supplied target independently. Do not edit files or coordinate with other reviewers.',
      tools: ['read', 'grep', 'glob'],
      model: [model],
      source: 'bundled',
    },
  }
})

interface MultiReviewParameters {
  target: string
  acceptanceCriteria: string
  context?: string
}

function isReviewRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMultiReviewParameters(value: unknown): MultiReviewParameters {
  if (!isReviewRecord(value))
    throw new Error('Review parameters must be an object')
  const record = value
  if (typeof record['target'] !== 'string' || record['target'].length === 0)
    throw new Error('Review target is required')
  if (
    typeof record['acceptanceCriteria'] !== 'string' ||
    record['acceptanceCriteria'].length === 0
  )
    throw new Error('Review acceptance criteria is required')
  if (record['context'] !== undefined && typeof record['context'] !== 'string')
    throw new Error('Review context must be a string')
  return {
    target: record['target'],
    acceptanceCriteria: record['acceptanceCriteria'],
    ...(record['context'] === undefined ? {} : { context: record['context'] }),
  }
}
interface ReviewerModel {
  provider: string
  id: string
}

interface ResolvedReviewer {
  agent: AgentDefinition
  alias: string
  resolved: { model?: ReviewerModel; thinkingLevel?: string }
}

function reviewerStatus(
  result: SingleResult,
): 'completed' | 'failed' | 'aborted' {
  if (result.aborted) return 'aborted'
  if (result.exitCode !== 0) return 'failed'
  return 'completed'
}

function reviewerModelSelector(
  result: ReviewerModel,
  thinkingLevel: string | undefined,
): string {
  const suffix = thinkingLevel === undefined ? '' : `:${thinkingLevel}`
  return `${result.provider}/${result.id}${suffix}`
}

function buildReviewersReport(
  results: SingleResult[],
  reviewers: ResolvedReviewer[],
): {
  alias: string
  reviewer: string
  model: string | undefined
  status: 'completed' | 'failed' | 'aborted'
  exitCode: number
  output: string
  stderr: string
  error: string | undefined
  abortReason: string | undefined
}[] {
  return results.map((result, index) => {
    const reviewer = reviewers.at(index)
    if (reviewer === undefined)
      throw new Error('Reviewer result count changed during execution')
    return {
      alias: reviewer.alias,
      reviewer: result.agent,
      model: result.resolvedModel,
      status: reviewerStatus(result),
      exitCode: result.exitCode,
      output: result.output,
      stderr: result.stderr,
      error: result.error,
      abortReason: result.abortReason,
    }
  })
}
function reviewAssignment(params: MultiReviewParameters): string {
  return [
    `Review target:\n${params.target}`,
    `Acceptance criteria:\n${params.acceptanceCriteria}`,
    'Review independently. Do not edit files or coordinate with other reviewers.',
    'Return findings ordered by severity with exact locations and evidence; explicitly say if there are none.',
  ].join('\n\n')
}

async function executeMultiReview(
  params: MultiReviewParameters,
  signal: AbortSignal | undefined,
  cwd: string,
  settings: CustomToolContext['settings'],
  modelRegistry: CustomToolContext['modelRegistry'],
  modelOverride?: string,
) {
  signal?.throwIfAborted()
  settings ??= await Settings.loadReadOnly({ cwd })
  const reviewers: ResolvedReviewer[] = reviewerDefinitions.map(
    ({ agent, model }) => ({
      agent,
      alias: modelOverride ?? model,
      resolved: resolveModelOverride(
        [modelOverride ?? model],
        modelRegistry,
        settings,
      ),
    }),
  )
  const unavailable = reviewers.filter(
    ({ resolved }) => resolved.model === undefined,
  )
  if (unavailable.length > 0) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Review not started: cannot resolve ${unavailable.map(({ alias }) => alias).join(', ')}. Configure these model roles with available models.`,
        },
      ],
    }
  }
  const invocationId = randomUUID()
  const assignment = reviewAssignment(params)
  const results = await Promise.all(
    reviewers.map(({ agent, alias, resolved }, index) => {
      const resolvedModel = resolved.model
      if (resolvedModel === undefined)
        throw new Error(`Reviewer model unavailable: ${alias}`)
      const options: ExecutorOptions = {
        cwd,
        agent,
        task: assignment,
        assignment,
        index,
        id: `multi-review-${invocationId}-${agent.name}`,
        modelOverride: reviewerModelSelector(
          resolvedModel,
          resolved.thinkingLevel,
        ),
        modelRole: alias,
        settings,
        modelRegistry,
        restrictToolNames: true,
        enableMCP: false,
        enableIrc: false,
        ...(signal === undefined ? {} : { signal }),
        ...(params.context === undefined ? {} : { context: params.context }),
      }
      return runSubprocess(options)
    }),
  )
  const reviewersReport = buildReviewersReport(results, reviewers)
  return {
    isError: reviewersReport.some(({ status }) => status !== 'completed'),
    details: { reviewers: reviewersReport },
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(reviewersReport, undefined, 2),
      },
      { type: 'text' as const, text: synthesisInstructions },
    ],
  }
}

export function createMultiReviewTool(modelOverride?: string): CustomTool {
  return {
    name: 'multi_review',
    label: 'Multi Review',
    description: `Run three independent read-only reviewers using ${modelOverride ?? 'smol, default, and slow'} models.`,
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        acceptanceCriteria: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['target', 'acceptanceCriteria'],
      additionalProperties: false,
    },
    async execute(_id, params, _onUpdate, ctx, signal) {
      try {
        return await executeMultiReview(
          parseMultiReviewParameters(params),
          signal,
          ctx.sessionManager.getCwd(),
          ctx.settings,
          ctx.modelRegistry,
          modelOverride,
        )
      } catch (error: unknown) {
        throw new Error(
          signal?.aborted
            ? 'Multi-model review was cancelled.'
            : 'Multi-model review failed. Check reviewer availability and model configuration.',
          { cause: error },
        )
      }
    },
  } as CustomTool
}

export function registerMultiReview(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'multi_review',
    label: 'Multi Review',
    description:
      'Run three independent read-only reviewers using smol, default, and slow models.',
    parameters: pi.zod.object({
      target: pi.zod.string().min(1),
      acceptanceCriteria: pi.zod.string().min(1),
      context: pi.zod.string().optional(),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return executeMultiReview(
        parseMultiReviewParameters(params),
        signal,
        ctx.cwd,
        pi.pi.settings,
        ctx.modelRegistry,
      )
    },
  })
}
