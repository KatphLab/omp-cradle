import type {
  CustomTool,
  CustomToolContext,
  ExtensionAPI,
} from '@oh-my-pi/pi-coding-agent'
import {
  runSubprocess,
  type ExecutorOptions,
} from '@oh-my-pi/pi-coding-agent/task/executor'
import type { AgentDefinition } from '@oh-my-pi/pi-coding-agent/task/types'

const synthesisInstructions =
  'Synthesize these independent results: deduplicate findings, preserve disagreements, ' +
  'and attribute each finding to its reviewer and model alias. ' +
  'reviewer-smol = pi/smol; reviewer-default = pi/default; reviewer-slow = pi/slow. ' +
  'Report failed or aborted reviewers as incomplete coverage, not as no findings.'

const reviewerDefinitions: readonly {
  agent: AgentDefinition
  model: string
}[] = [
  {
    model: 'pi/smol',
    agent: {
      name: 'reviewer-smol',
      description: 'Read-only small-model reviewer',
      systemPrompt:
        'Review the supplied target independently. Do not edit files or coordinate with other reviewers.',
      tools: ['read', 'grep', 'glob'],
      model: ['pi/smol'],
      source: 'bundled',
    },
  },
  {
    model: 'pi/default',
    agent: {
      name: 'reviewer-default',
      description: 'Read-only default-model reviewer',
      systemPrompt:
        'Review the supplied target independently. Do not edit files or coordinate with other reviewers.',
      tools: ['read', 'grep', 'glob'],
      model: ['pi/default'],
      source: 'bundled',
    },
  },
  {
    model: 'pi/slow',
    agent: {
      name: 'reviewer-slow',
      description: 'Read-only slow-model reviewer',
      systemPrompt:
        'Review the supplied target independently. Do not edit files or coordinate with other reviewers.',
      tools: ['read', 'grep', 'glob'],
      model: ['pi/slow'],
      source: 'bundled',
    },
  },
]

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

async function executeMultiReview(
  params: MultiReviewParameters,
  signal: AbortSignal | undefined,
  cwd: string,
  settings: CustomToolContext['settings'],
  modelRegistry: CustomToolContext['modelRegistry'],
) {
  signal?.throwIfAborted()
  const assignment = [
    `Review target:\n${params.target}`,
    `Acceptance criteria:\n${params.acceptanceCriteria}`,
    'Review independently. Do not edit files or coordinate with other reviewers.',
    'Return findings ordered by severity with exact locations and evidence; explicitly say if there are none.',
  ].join('\n\n')
  const results = await Promise.all(
    reviewerDefinitions.map(({ agent, model }, index) => {
      const options: ExecutorOptions = {
        cwd,
        agent,
        task: assignment,
        assignment,
        index,
        id: `multi-review-${agent.name}`,
        modelOverride: model,
        ...(settings === undefined ? {} : { settings }),
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
  const report = results
    .map(
      (result) =>
        `${result.agent} (${result.agentSource}):\n${result.output || result.stderr || '(no findings)'}`,
    )
    .join('\n\n')
  return {
    content: [
      { type: 'text' as const, text: report },
      { type: 'text' as const, text: synthesisInstructions },
    ],
  }
}

export function createMultiReviewTool(): CustomTool {
  return {
    name: 'multi_review',
    label: 'Multi Review',
    description:
      'Run three independent read-only reviewers using smol, default, and slow models.',
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
