import type { CustomTool } from '@oh-my-pi/pi-coding-agent'
import assert from 'node:assert/strict'
import path from 'node:path'
import { writeWorkspaceSignal } from './swarm/signal-tool-context'

export function createReviewReportTool(
  workspace: string,
  swarmName: string,
  agentName: string,
): CustomTool {
  assert.ok(agentName === 'correctness' || agentName === 'simplicity')
  const reportPath = path.join(
    '.omp-swarm',
    swarmName,
    'run',
    `${agentName}.yaml`,
  )
  return {
    name: 'write_review_report',
    label: 'Write Review Report',
    description: `Validate and write only ${reportPath}; verifies identity against freeze and current HEAD, then reads the saved report back. No other destination is allowed.`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(_id, params) {
      assert.ok(typeof params === 'object' && params !== null)
      assert.ok('path' in params && params.path === reportPath)
      assert.ok('content' in params && typeof params.content === 'string')
      const report = Bun.YAML.parse(params.content)
      const freeze = Bun.YAML.parse(
        await Bun.file(
          path.join(workspace, '.omp-swarm', swarmName, 'run', 'freeze.yaml'),
        ).text(),
      )
      assert.ok(isReport(report) && isReport(freeze))
      assert.equal(freeze['schema'], 1)
      assert.equal(freeze['producer'], 'freeze')
      assert.equal(freeze['status'], 'READY')
      assert.equal(report['schema'], 1)
      assert.equal(report['producer'], agentName)
      assert.ok(report['status'] === 'READY' || report['status'] === 'BLOCKED')
      assert.deepEqual(report['identity'], freeze['identity'])
      const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
        cwd: workspace,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [head, , exit] = await Promise.all([
        git.stdout.text(),
        git.stderr.text(),
        git.exited,
      ])
      assert.equal(exit, 0)
      assert.ok(isReport(freeze['identity']))
      assert.equal(freeze['identity']['head'], head.trim())
      await writeWorkspaceSignal(workspace, reportPath, params.content)
      assert.equal(
        await Bun.file(path.join(workspace, reportPath)).text(),
        params.content,
      )
      return {
        content: [
          {
            type: 'text',
            text: `Validated identity and disk read-back for ${reportPath}`,
          },
        ],
      }
    },
  } as CustomTool
}

function isReport(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
