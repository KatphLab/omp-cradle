import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url))

export default function systemPromptExtension(pi: ExtensionAPI): void {
  pi.setLabel('System Prompt Prefix/Suffix and Git Context')

  pi.on('before_agent_start', async (event, ctx) => {
    const [prefix, suffix, gitSection] = await Promise.all([
      readOptionalMarkdown('system_prefix.md'),
      readOptionalMarkdown('system_suffix.md'),
      buildGitSection(ctx.cwd),
    ])

    if (
      prefix === undefined &&
      suffix === undefined &&
      gitSection === undefined
    ) {
      return
    }

    const systemPrompt = event.systemPrompt
      .map((section) => stripWorkstationSection(section))
      .filter((section) => section.trim().length > 0)
    if (prefix !== undefined) {
      systemPrompt.unshift(prefix)
    }
    if (gitSection !== undefined) {
      systemPrompt.push(gitSection)
    }
    if (suffix !== undefined) {
      systemPrompt.push(suffix)
    }

    return { systemPrompt }
  })
}

interface GitStatus {
  branch: string
  upstream: string | undefined
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
}

async function buildGitSection(cwd: string): Promise<string | undefined> {
  const root = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (root === undefined) {
    return undefined
  }

  const [head, statusOutput] = await Promise.all([
    runGit(cwd, ['log', '-1', '--format=%h %s']),
    runGit(cwd, ['status', '--porcelain=v2', '--branch']),
  ])
  if (statusOutput === undefined) {
    return undefined
  }

  const status = parseGitStatus(statusOutput)
  const upstream =
    status.upstream === undefined
      ? 'none'
      : `${status.upstream} (ahead ${status.ahead}, behind ${status.behind})`

  return [
    '<git>',
    `root: ${escapeXml(root)}`,
    `branch: ${escapeXml(status.branch)}`,
    `head: ${escapeXml(head ?? 'unborn')}`,
    `upstream: ${escapeXml(upstream)}`,
    `status: staged ${status.staged}, unstaged ${status.unstaged}, untracked ${status.untracked}, conflicts ${status.conflicts}`,
    '</git>',
  ].join('\n')
}

function parseGitStatus(output: string): GitStatus {
  const aheadBehind = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(output) ?? [
    '',
    '0',
    '0',
  ]
  const changes = [...output.matchAll(/^[12] (..)/gm)].map(
    (match) => match[1] ?? '..',
  )

  return {
    branch: /^# branch\.head (.+)$/m.exec(output)?.[1] ?? 'detached',
    upstream: /^# branch\.upstream (.+)$/m.exec(output)?.[1],
    ahead: Number(aheadBehind[1]),
    behind: Number(aheadBehind[2]),
    staged: changes.filter((change) => !change.startsWith('.')).length,
    unstaged: changes.filter((change) => change[1] !== '.').length,
    untracked: (output.match(/^\? /gm) ?? []).length,
    conflicts: (output.match(/^u /gm) ?? []).length,
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const process = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [output, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ])
    if (exitCode !== 0) {
      return undefined
    }

    return output.trim()
  } catch {
    return undefined
  }
}

function stripWorkstationSection(systemPrompt: string): string {
  return systemPrompt.replaceAll(/<workstation>[\s\S]*?<\/workstation>\s*/g, '')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

async function readOptionalMarkdown(
  filename: 'system_prefix.md' | 'system_suffix.md',
): Promise<string | undefined> {
  const filePath = path.join(EXTENSION_DIR, filename)
  try {
    const text = await readFile(filePath, 'utf8')
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return undefined
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
