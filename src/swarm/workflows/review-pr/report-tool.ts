import type { CustomTool } from '@oh-my-pi/pi-coding-agent'
import assert from 'node:assert/strict'
import path from 'node:path'
import { writeWorkspaceSignal } from '../../swarm/signal-tool-context'
import { assertReviewSource } from './prepare'

export function createReviewReportTool(
  workspace: string,
  swarmName: string,
  agentName: string,
): CustomTool {
  assert.ok(['correctness', 'simplicity', 'adjudicate'].includes(agentName))
  return {
    name: 'write_review_report',
    label: 'Write Review Report',
    description:
      'Save Markdown with validated frozen identity and disk read-back. Adjudication also publishes findings.md after checking both upstream reviews. Do not supply a YAML envelope.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        status: { type: 'string', enum: ['READY', 'BLOCKED'] },
        report: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['run_id', 'status', 'report'],
      additionalProperties: false,
    },
    execute: async (_id, params) =>
      publishReviewReport(workspace, swarmName, agentName, params),
  } as CustomTool
}

async function publishReviewReport(
  workspace: string,
  swarmName: string,
  agentName: string,
  params: unknown,
) {
  const root = `.omp-swarm/${swarmName}/run`
  assert.ok(isReport(params))
  assert.ok(params['status'] === 'READY' || params['status'] === 'BLOCKED')
  assert.ok(
    typeof params['report'] === 'string' && params['report'].trim(),
    'Review must contain findings and coverage, or an actionable blocker',
  )
  if (params['status'] === 'BLOCKED') {
    assert.ok(
      typeof params['reason'] === 'string' && params['reason'].trim(),
      'Blocked review requires a reason',
    )
  }
  const freeze = await readReport(workspace, root, 'freeze')
  assert.equal(freeze['schema'], 1)
  assert.equal(freeze['producer'], 'preflight')
  assert.equal(freeze['status'], 'READY')
  assert.equal(freeze['root'], workspace)
  const identity = freeze['identity']
  assert.ok(isReport(identity) && typeof identity['head'] === 'string')
  assert.equal(params['run_id'], identity['run_id'], 'Stale review invocation')
  await assertReviewSource(workspace, swarmName, identity['head'])
  if (agentName === 'adjudicate' && params['status'] === 'READY') {
    await validateReviews(workspace, root, identity)
  }
  const report = {
    schema: 1,
    producer: agentName,
    identity,
    status: params['status'],
    report: params['report'],
    reason: params['reason'],
  }
  await saveReport(
    workspace,
    `${root}/${agentName}.yaml`,
    Bun.YAML.stringify(report),
  )
  if (agentName === 'adjudicate') {
    const status = params['status'] === 'READY' ? 'COMPLETE' : 'BLOCKED'
    await saveReport(
      workspace,
      `${root}/findings.md`,
      `---\n${Bun.YAML.stringify({ schema: 1, producer: agentName, status, identity })}---\n\n${params['report']}\n\nNo fixes or post-fix verification were performed. This report is not merge acceptance.\n`,
    )
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: `Saved and validated ${root}/${agentName}.yaml; declared outputs read back successfully`,
      },
    ],
  }
}

async function readReport(
  workspace: string,
  root: string,
  producer: string,
): Promise<Record<string, unknown>> {
  const report: unknown = Bun.YAML.parse(
    await Bun.file(path.join(workspace, root, `${producer}.yaml`)).text(),
  )
  assert.ok(isReport(report), `Missing or malformed ${producer} report`)
  return report
}

async function saveReport(
  workspace: string,
  destination: string,
  content: string,
): Promise<void> {
  await writeWorkspaceSignal(workspace, destination, content)
  assert.equal(
    await Bun.file(path.join(workspace, destination)).text(),
    content,
  )
}

async function validateReviews(
  workspace: string,
  root: string,
  identity: Record<string, unknown>,
): Promise<void> {
  for (const producer of ['correctness', 'simplicity']) {
    const upstream = await readReport(workspace, root, producer)
    assert.equal(upstream['schema'], 1)
    assert.equal(upstream['producer'], producer)
    assert.equal(upstream['status'], 'READY', `${producer} review is not READY`)
    assert.deepEqual(
      upstream['identity'],
      identity,
      `${producer} review is stale`,
    )
    assert.ok(
      typeof upstream['report'] === 'string' && upstream['report'].trim(),
      `${producer} review is empty`,
    )
  }
}

function isReport(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
