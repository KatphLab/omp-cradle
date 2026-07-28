import {
  createAgentSession,
  discoverAuthStorage,
  discoverSessionExtensionPaths,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  Settings,
  type AuthStorage,
} from '@oh-my-pi/pi-coding-agent'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CreateSessionRequest } from './contracts.js'
import { ApiError } from './errors.js'
import type { SessionFactoryResult } from './types.js'

const SERVER_EXTENSION_PATH = fileURLToPath(
  new URL('index.ts', import.meta.url),
)

export class SessionFactory {
  readonly modelRegistry: ModelRegistry
  readonly #agentDirectory: string
  readonly #authStorage: AuthStorage
  readonly #serverExtensionPath: string

  private constructor(
    agentDirectory: string,
    authStorage: AuthStorage,
    modelRegistry: ModelRegistry,
    serverExtensionPath: string,
  ) {
    this.#agentDirectory = agentDirectory
    this.#authStorage = authStorage
    this.modelRegistry = modelRegistry
    this.#serverExtensionPath = serverExtensionPath
  }

  static async initialize(): Promise<SessionFactory> {
    const agentDirectory = getAgentDir()
    const [authStorage, serverExtensionPath] = await Promise.all([
      discoverAuthStorage(agentDirectory),
      realpath(SERVER_EXTENSION_PATH),
    ])
    const modelRegistry = new ModelRegistry(authStorage)
    await modelRegistry.refresh()
    return new SessionFactory(
      agentDirectory,
      authStorage,
      modelRegistry,
      serverExtensionPath,
    )
  }

  async create(
    id: string,
    request: CreateSessionRequest,
  ): Promise<SessionFactoryResult> {
    const sessionManager =
      request.mode === 'new'
        ? SessionManager.create(await resolveWorkingDirectory(request.cwd))
        : await openSessionFile(request.sessionFile)
    const cwd = sessionManager.getCwd()
    const settings = await Settings.loadIsolated({
      cwd,
      agentDir: this.#agentDirectory,
    })
    const extensionPaths = await this.#discoverExtensionPaths(cwd, settings)
    const result = await createAgentSession({
      cwd,
      authStorage: this.#authStorage,
      modelRegistry: this.modelRegistry,
      settings,
      sessionManager,
      preloadedExtensionPaths: extensionPaths,
      hasUI: false,
      agentId: `server:${id}`,
      agentDisplayName: request.label ?? `server-${id.slice(0, 8)}`,
      ...(request.model === undefined ? {} : { modelPattern: request.model }),
      ...(request.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: request.thinkingLevel }),
    })

    return {
      session: result.session,
      warning: result.modelFallbackMessage,
    }
  }

  availableModels(): { provider: string; id: string }[] {
    return this.modelRegistry
      .getAvailable()
      .map((model) => ({ provider: model.provider, id: model.id }))
      .toSorted((left, right) =>
        `${left.provider}/${left.id}`.localeCompare(
          `${right.provider}/${right.id}`,
        ),
      )
  }

  async #discoverExtensionPaths(
    cwd: string,
    settings: Settings,
  ): Promise<string[]> {
    const discovered = await discoverSessionExtensionPaths({}, cwd, settings)
    const canonicalPaths = await Promise.all(
      discovered.map(async (extensionPath) => ({
        source: extensionPath,
        canonical: await realpath(extensionPath),
      })),
    )
    return canonicalPaths
      .filter(({ canonical }) => canonical !== this.#serverExtensionPath)
      .map(({ source }) => source)
  }
}

export async function resolveWorkingDirectory(value: string): Promise<string> {
  const resolved = path.resolve(value)
  let metadata
  try {
    metadata = await stat(resolved)
  } catch (error: unknown) {
    throw new ApiError(
      400,
      'invalid_working_directory',
      'Working directory does not exist or is not accessible',
      error instanceof Error ? error : undefined,
    )
  }
  if (!metadata.isDirectory()) {
    throw new ApiError(
      400,
      'invalid_working_directory',
      'Working directory must be a directory',
    )
  }
  return realpath(resolved)
}

async function openSessionFile(value: string): Promise<SessionManager> {
  const resolved = path.resolve(value)
  let metadata
  try {
    metadata = await stat(resolved)
  } catch (error: unknown) {
    throw new ApiError(
      400,
      'invalid_session_file',
      'Session file does not exist or is not accessible',
      error instanceof Error ? error : undefined,
    )
  }
  if (!metadata.isFile()) {
    throw new ApiError(
      400,
      'invalid_session_file',
      'Session file must be a regular file',
    )
  }
  const canonicalPath = await realpath(resolved)
  const persisted = await SessionManager.peekSessionInit(canonicalPath)
  if (persisted === null) {
    throw new ApiError(
      400,
      'invalid_session_file',
      'Session file does not contain a valid persisted session',
    )
  }
  await resolveWorkingDirectory(persisted.cwd)
  return SessionManager.open(canonicalPath)
}
