import { createHash, type Hash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'

export async function captureFileReference(
  workspace: string,
  filePath: string | undefined,
): Promise<Record<string, string>> {
  if (filePath === undefined) return {}
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspace, filePath)
  try {
    const content = await fs.readFile(resolved)
    const relative = path.relative(workspace, resolved)
    return {
      [`file:${relative}`]: createHash('sha256').update(content).digest('hex'),
    }
  } catch (error_) {
    const error = error_ instanceof Error ? error_ : new Error(String(error_))
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function captureWorkspaceCheckpoint(
  workspace: string,
  ignoredPaths: readonly string[],
): Promise<string | undefined> {
  const snapshot = await loadGitSnapshot(workspace)
  if (snapshot === undefined) return undefined
  const hash = createHash('sha256')
    .update(snapshot.head)
    .update('\0')
    .update(snapshot.diff)
  await appendUntrackedFiles(
    hash,
    snapshot.root,
    snapshot.status,
    new Set(ignoredPaths.map((item) => path.resolve(workspace, item))),
  )
  return hash.digest('hex')
}

async function loadGitSnapshot(workspace: string): Promise<
  | {
      root: string
      head: string
      diff: string
      status: string
    }
  | undefined
> {
  const rootResult = await runGit(workspace, ['rev-parse', '--show-toplevel'])
  if (rootResult.exitCode !== 0) return undefined
  const root = rootResult.stdout.trim()
  const [head, diff, status] = await Promise.all([
    runGit(root, ['rev-parse', 'HEAD']),
    runGit(root, ['diff', '--binary', 'HEAD', '--', '.']),
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ])
  if (head.exitCode !== 0 || diff.exitCode !== 0 || status.exitCode !== 0) {
    return undefined
  }
  return {
    root,
    head: head.stdout,
    diff: diff.stdout,
    status: status.stdout,
  }
}

async function appendUntrackedFiles(
  hash: Hash,
  root: string,
  status: string,
  ignored: ReadonlySet<string>,
): Promise<void> {
  for (const entry of status.split('\0')) {
    if (!entry.startsWith('?? ')) continue
    const absolute = path.resolve(root, entry.slice(3))
    if (shouldIgnoreWorkspacePath(absolute, ignored)) continue
    const content = await readUntrackedFile(absolute)
    if (content === undefined) continue
    hash.update('\0').update(path.relative(root, absolute)).update('\0')
    hash.update(content)
  }
}

function shouldIgnoreWorkspacePath(
  absolute: string,
  ignored: ReadonlySet<string>,
): boolean {
  return absolute.includes(`${path.sep}.swarm_`) || ignored.has(absolute)
}

async function readUntrackedFile(
  absolute: string,
): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(absolute)
  } catch (error_) {
    const error = error_ instanceof Error ? error_ : new Error(String(error_))
    if ((error as NodeJS.ErrnoException).code === 'EISDIR') return undefined
    throw error
  }
}

export async function validateEvidenceReferences(
  workspace: string,
  references: Record<string, string>,
  ignoredPaths: readonly string[],
): Promise<'valid' | 'output-missing' | 'workspace-changed'> {
  for (const [reference, expected] of Object.entries(references)) {
    if (reference === 'workspace') {
      const current = await captureWorkspaceCheckpoint(workspace, ignoredPaths)
      if (current === undefined || current !== expected)
        return 'workspace-changed'
      continue
    }
    if (!reference.startsWith('file:')) continue
    const actual = await captureFileReference(workspace, reference.slice(5))
    if (actual[reference] !== expected) return 'output-missing'
  }
  return 'valid'
}

async function runGit(
  workspace: string,
  arguments_: readonly string[],
): Promise<{ exitCode: number; stdout: string }> {
  const process = Bun.spawn(['git', '-C', workspace, ...arguments_], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [exitCode, stdout] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
  ])
  return { exitCode, stdout }
}
