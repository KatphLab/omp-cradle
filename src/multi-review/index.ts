import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { TaskTool } from '@oh-my-pi/pi-coding-agent/task'
import { createSubagentSettings } from '@oh-my-pi/pi-coding-agent/task/executor'

const reviewers = ['reviewer-smol', 'reviewer-default', 'reviewer-slow']
const synthesisInstructions =
  'Synthesize these independent results: deduplicate findings, preserve disagreements, ' +
  'and attribute each finding to its reviewer and model alias. ' +
  'reviewer-smol = pi/smol; reviewer-default = pi/default; reviewer-slow = pi/slow. ' +
  'Report failed or aborted reviewers as incomplete coverage, not as no findings.'

export function registerMultiReview(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'multi_review',
    label: 'Multi Review',
    description:
      'Run three independent read-only reviewers using smol, default, and slow models. ' +
      'Waits for all reviewers and returns their attributed findings. ' +
      'Deduplicate the results, preserve disagreements, and attribute each finding to its reviewer and model alias.',
    parameters: pi.zod.object({
      target: pi.zod.string().min(1),
      acceptanceCriteria: pi.zod.string().min(1),
      context: pi.zod.string().optional(),
    }),
    async execute(
      id,
      params: { target: string; acceptanceCriteria: string; context?: string },
      signal,
      onUpdate,
      ctx,
    ) {
      try {
        signal?.throwIfAborted()
        const settings = createSubagentSettings(pi.pi.settings, {
          'task.batch': true,
          'async.enabled': false,
        })
        const task = await TaskTool.create({
          cwd: ctx.cwd,
          hasUI: false,
          getSessionFile: () => ctx.sessionManager.getSessionFile() ?? '',
          getSessionSpawns: () => reviewers.join(','),
          settings,
          modelRegistry: ctx.modelRegistry,
          restrictToolNames: true,
          suppressSpawnAdvisory: true,
        })
        const assignment = [
          `Review target:\n${params.target}`,
          `Acceptance criteria:\n${params.acceptanceCriteria}`,
          'Review independently. Do not edit files or coordinate with other reviewers.',
          'Return findings ordered by severity with exact locations and evidence; explicitly say if there are none.',
        ].join('\n\n')
        const result = await task.execute(
          id,
          {
            context: [`Working directory: ${ctx.cwd}`, params.context]
              .filter(Boolean)
              .join('\n\n'),
            tasks: reviewers.map((agent) => ({
              name: agent,
              agent,
              task: assignment,
            })),
          },
          signal,
          onUpdate,
        )
        return {
          ...result,
          content: [
            ...result.content,
            { type: 'text' as const, text: synthesisInstructions },
          ],
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        pi.logger.error('multi_review failed', { error: message })
        throw new Error(
          signal?.aborted
            ? 'Multi-model review was cancelled.'
            : 'Multi-model review failed. Check reviewer availability and model configuration.',
          { cause: error },
        )
      }
    },
  })
}
