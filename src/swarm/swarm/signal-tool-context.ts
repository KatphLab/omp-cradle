import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { isSafeRelativePath } from './schema'

export const CONTROL_DECISION_TOOL_NAME = 'submit_control_decision'
export const REPEAT_DECISION_TOOL_NAME = 'submit_repeat_decision'

export interface ControlSignalToolChannel {
  scope: string
  signal: string
  allowedRestartTargets: string[]
}

export interface RepeatSignalToolChannel {
  scope: string
  signal: string
  successValue: string
  continueValue: string
}

export interface SwarmSignalToolContext {
  version: 1
  controls: ControlSignalToolChannel[]
  repeats: RepeatSignalToolChannel[]
}

function signalToolContextPath(swarmDirectory: string, runId: string): string {
  return path.join(swarmDirectory, 'context', `${runId}.signal-tools.json`)
}

export async function writeSignalToolContext(
  swarmDirectory: string,
  runId: string,
  context: SwarmSignalToolContext,
): Promise<void> {
  const contextPath = signalToolContextPath(swarmDirectory, runId)
  await fs.mkdir(path.dirname(contextPath), { recursive: true })
  await fs.writeFile(contextPath, `${JSON.stringify(context)}\n`)
}

export async function readSignalToolContext(
  sessionFile: string | undefined,
): Promise<SwarmSignalToolContext> {
  if (!sessionFile?.endsWith('.jsonl')) {
    throw new Error(
      'Swarm signal tools require a persisted swarm agent session',
    )
  }
  const contextPath = `${sessionFile.slice(0, -'.jsonl'.length)}.signal-tools.json`
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(contextPath, 'utf8'))
  } catch {
    throw new Error('Swarm signal tools are unavailable for this agent')
  }
  if (!isSignalToolContext(parsed)) {
    throw new Error('Swarm signal tool context is malformed')
  }
  return parsed
}

function isSignalToolContext(value: unknown): value is SwarmSignalToolContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'controls' in value &&
    Array.isArray(value.controls) &&
    value.controls.every(isControlSignalToolChannel) &&
    'repeats' in value &&
    Array.isArray(value.repeats) &&
    value.repeats.every(isRepeatSignalToolChannel)
  )
}

function isControlSignalToolChannel(
  value: unknown,
): value is ControlSignalToolChannel {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scope' in value &&
    typeof value.scope === 'string' &&
    'signal' in value &&
    typeof value.signal === 'string' &&
    'allowedRestartTargets' in value &&
    Array.isArray(value.allowedRestartTargets) &&
    value.allowedRestartTargets.every((target) => typeof target === 'string')
  )
}

function isRepeatSignalToolChannel(
  value: unknown,
): value is RepeatSignalToolChannel {
  return (
    typeof value === 'object' &&
    value !== null &&
    'scope' in value &&
    typeof value.scope === 'string' &&
    'signal' in value &&
    typeof value.signal === 'string' &&
    'successValue' in value &&
    typeof value.successValue === 'string' &&
    'continueValue' in value &&
    typeof value.continueValue === 'string'
  )
}

function errorCode(error_: unknown): string | undefined {
  if (
    error_ instanceof Error &&
    'code' in error_ &&
    typeof error_.code === 'string'
  )
    return error_.code
  return undefined
}

function descriptorPath(directory: fs.FileHandle, child: string): string {
  return path.join('/proc/self/fd', String(directory.fd), child)
}

const directoryOpenFlags =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW

async function createMissingDirectory(childPath: string): Promise<void> {
  try {
    await fs.mkdir(childPath)
  } catch (error_) {
    if (errorCode(error_) !== 'EEXIST') {
      throw error_ instanceof Error ? error_ : new Error(String(error_))
    }
  }
}

async function openChildDirectory(
  parent: fs.FileHandle,
  component: string,
): Promise<fs.FileHandle> {
  const childPath = descriptorPath(parent, component)
  try {
    return await fs.open(childPath, directoryOpenFlags)
  } catch (error_) {
    if (errorCode(error_) !== 'ENOENT') {
      throw error_ instanceof Error ? error_ : new Error(String(error_))
    }
    await createMissingDirectory(childPath)
    return fs.open(childPath, directoryOpenFlags)
  }
}

interface SignalDestination {
  destination: string
  parent: fs.FileHandle
  handles: fs.FileHandle[]
  name: string
}

type SignalGitEnvironment = Record<string, string | undefined>

function signalGitEnvironment(root: string): SignalGitEnvironment {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
  Object.assign(environment, {
    LC_ALL: 'C',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: root,
  })
  return environment
}

function isMissingGitRepository(exitCode: number, error: string): boolean {
  return (
    exitCode === 128 &&
    error.trimStart().startsWith('fatal: not a git repository')
  )
}

function assertGitContextPaths(
  root: string,
  topLevel: string | undefined,
  gitDirectory: string | undefined,
): [string, string] {
  if (topLevel === undefined || gitDirectory === undefined) {
    throw new Error('Cannot inspect Git ownership of swarm signal destination')
  }
  if (
    path.resolve(topLevel) !== topLevel ||
    path.resolve(gitDirectory) !== gitDirectory
  ) {
    throw new Error('Cannot inspect Git ownership of swarm signal destination')
  }
  const relativeRoot = path.relative(topLevel, root)
  if (
    relativeRoot === '..' ||
    relativeRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRoot)
  ) {
    throw new Error('Cannot inspect Git ownership of swarm signal destination')
  }
  return [topLevel, gitDirectory]
}

async function assertCanonicalGitContext(
  topLevel: string,
  gitDirectory: string,
): Promise<void> {
  try {
    if (
      (await fs.realpath(topLevel)) !== topLevel ||
      (await fs.realpath(gitDirectory)) !== gitDirectory
    )
      throw new Error('Git context is not canonical')
  } catch {
    throw new Error('Cannot inspect Git ownership of swarm signal destination')
  }
}

async function assertGitContext(
  root: string,
  environment: SignalGitEnvironment,
): Promise<boolean> {
  const contextProcess = Bun.spawn(
    [
      'git',
      '-c',
      'core.fsmonitor=false',
      'rev-parse',
      '--show-toplevel',
      '--absolute-git-dir',
    ],
    {
      cwd: root,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [contextOutput, contextError, contextExitCode] = await Promise.all([
    contextProcess.stdout.text(),
    contextProcess.stderr.text(),
    contextProcess.exited,
  ])
  if (isMissingGitRepository(contextExitCode, contextError)) return false
  if (contextExitCode !== 0) {
    throw new Error('Cannot inspect Git ownership of swarm signal destination')
  }
  const [topLevel, gitDirectory] = contextOutput.trimEnd().split('\n')
  const [canonicalTopLevel, canonicalGitDirectory] = assertGitContextPaths(
    root,
    topLevel,
    gitDirectory,
  )
  await assertCanonicalGitContext(canonicalTopLevel, canonicalGitDirectory)
  return true
}

async function assertSignalDestinationUntracked(
  root: string,
  destination: string,
): Promise<void> {
  const environment = signalGitEnvironment(root)
  if (!(await assertGitContext(root, environment))) return
  const ownershipProcess = Bun.spawn(
    [
      'git',
      '-c',
      'core.fsmonitor=false',
      '--literal-pathspecs',
      'ls-files',
      '-z',
      '--',
      path.relative(root, destination),
    ],
    {
      cwd: root,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, , exitCode] = await Promise.all([
    ownershipProcess.stdout.text(),
    ownershipProcess.stderr.text(),
    ownershipProcess.exited,
  ])
  if (exitCode !== 0) {
    throw new Error('Cannot inspect Git ownership of swarm signal destination')
  }
  if (stdout.length > 0) {
    throw new Error(
      'Swarm signal destination must not replace or delete tracked files',
    )
  }
}
async function openCanonicalDirectory(root: string): Promise<fs.FileHandle> {
  const handle = await fs.open(root, directoryOpenFlags)
  try {
    if ((await fs.realpath(descriptorPath(handle, ''))) !== root) {
      throw new Error('Swarm signal workspace must be a canonical directory')
    }
    return handle
  } catch (error_) {
    await closeSignalHandles([handle])
    throw error_ instanceof Error ? error_ : new Error(String(error_))
  }
}

async function openSignalParent(
  rootHandle: fs.FileHandle,
  root: string,
  signal: string,
  handles: fs.FileHandle[],
): Promise<{ destination: string; name: string; parent: fs.FileHandle }> {
  const destination = path.resolve(root, signal)
  const components = path.relative(root, destination).split(path.sep)
  const name = components.pop()
  if (name === undefined || name.length === 0) {
    throw new Error('Swarm signal destination must be a file')
  }
  let parent = rootHandle
  for (const component of components) {
    const child = await openChildDirectory(parent, component)
    handles.push(child)
    parent = child
  }
  return { destination, name, parent }
}

async function assertSignalEntryIsSafe(
  parent: fs.FileHandle,
  name: string,
): Promise<void> {
  try {
    const stat = await fs.lstat(descriptorPath(parent, name))
    if (stat.isSymbolicLink()) {
      throw new Error(
        'Swarm signal destination must not traverse symlinks or non-directories',
      )
    }
  } catch (error_) {
    if (errorCode(error_) !== 'ENOENT') {
      throw error_ instanceof Error ? error_ : new Error(String(error_))
    }
  }
}

async function closeSignalHandles(handles: fs.FileHandle[]): Promise<void> {
  while (handles.length > 0) {
    try {
      await handles.pop()?.close()
    } catch {
      // Best-effort cleanup must not hide the original signal error.
    }
  }
}

async function workspaceSignalDestination(
  workspace: string,
  signal: string,
): Promise<SignalDestination> {
  if (!isSafeRelativePath(signal)) {
    throw new Error('Swarm signal destination is not a safe workspace path')
  }
  const root = path.resolve(workspace)
  const handles: fs.FileHandle[] = []
  try {
    const rootHandle = await openCanonicalDirectory(root)
    handles.push(rootHandle)
    const destination = await openSignalParent(
      rootHandle,
      root,
      signal,
      handles,
    )
    await assertSignalEntryIsSafe(destination.parent, destination.name)
    await assertSignalDestinationUntracked(root, destination.destination)
    return { ...destination, handles }
  } catch (error_) {
    await closeSignalHandles(handles)
    throw error_ instanceof Error ? error_ : new Error(String(error_))
  }
}

export async function removeWorkspaceSignal(
  workspace: string,
  signal: string,
): Promise<void> {
  const signalDestination = await workspaceSignalDestination(workspace, signal)
  try {
    await fs.rm(
      descriptorPath(signalDestination.parent, signalDestination.name),
      { force: true },
    )
  } finally {
    await closeSignalHandles(signalDestination.handles)
  }
}
export async function writeWorkspaceSignal(
  workspace: string,
  signal: string,
  content: string,
): Promise<void> {
  const signalDestination = await workspaceSignalDestination(workspace, signal)
  const temporaryName = `.${signalDestination.name}.${randomUUID()}.tmp`
  const temporaryPath = descriptorPath(signalDestination.parent, temporaryName)
  try {
    const temporary = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    )
    try {
      await temporary.writeFile(content)
    } finally {
      await temporary.close()
    }
    await fs.rename(
      temporaryPath,
      descriptorPath(signalDestination.parent, signalDestination.name),
    )
  } finally {
    try {
      await fs.rm(temporaryPath, { force: true })
    } catch {
      // Best-effort cleanup must not hide the original signal error.
    }
    await closeSignalHandles(signalDestination.handles)
  }
}
