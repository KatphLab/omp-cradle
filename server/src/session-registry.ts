import { SessionManager, type AgentSession } from '@oh-my-pi/pi-coding-agent'
import { randomUUID } from 'node:crypto'

import type { CreateSessionRequest, ThinkingLevelInput } from './contracts.js'
import { ApiError, normalizeError, operationError } from './errors.js'
import type { SessionFactory } from './session-factory.js'
import type {
  EventSubscriber,
  ManagedSession,
  ServerEvent,
  ServerLogger,
  SessionLock,
  SessionSnapshot,
} from './types.js'

export interface SubscriptionResult {
  readonly snapshot: SessionSnapshot
  readonly warnings: readonly string[]
  readonly unsubscribe: () => void
}

class LifecycleLock implements SessionLock {
  #tail: Promise<unknown> = Promise.resolve()

  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    const predecessor = this.#tail
    const next = Promise.withResolvers<boolean>()
    this.#tail = next.promise
    await predecessor
    try {
      return await operation()
    } finally {
      next.resolve(true)
    }
  }
}

export class SessionRegistry {
  readonly #entries = new Map<string, ManagedSession>()
  readonly #factory: SessionFactory
  readonly #logger: ServerLogger

  constructor(factory: SessionFactory, logger: ServerLogger) {
    this.#factory = factory
    this.#logger = logger
  }

  get size(): number {
    return this.#entries.size
  }

  async create(request: CreateSessionRequest): Promise<{
    snapshot: SessionSnapshot
    warning: string | undefined
  }> {
    const id = randomUUID()
    let created
    try {
      created = await this.#factory.create(id, request)
    } catch (error: unknown) {
      if (error instanceof ApiError) throw error
      throw operationError(
        'session_create_failed',
        'Managed session could not be created',
        error,
      )
    }

    const subscribers = new Set<EventSubscriber>()
    const unsubscribe = created.session.subscribe((event) => {
      this.#fanOut(subscribers, { type: 'omp', data: event })
    })
    const entry: ManagedSession = {
      id,
      label: request.label,
      createdAt: new Date().toISOString(),
      session: created.session,
      unsubscribe,
      subscribers,
      lock: new LifecycleLock(),
      warnings: created.warning === undefined ? [] : [created.warning],
      lifecycle: 'ready',
    }
    this.#entries.set(id, entry)
    return { snapshot: this.#snapshot(entry), warning: created.warning }
  }

  list(): SessionSnapshot[] {
    return [...this.#entries.values()].map((entry) => this.#snapshot(entry))
  }

  get(id: string): SessionSnapshot {
    return this.#snapshot(this.#require(id))
  }

  subscribe(id: string, subscriber: EventSubscriber): SubscriptionResult {
    const entry = this.#require(id)
    entry.subscribers.add(subscriber)
    return {
      snapshot: this.#snapshot(entry),
      warnings: entry.warnings,
      unsubscribe: () => {
        entry.subscribers.delete(subscriber)
      },
    }
  }

  async prompt(
    id: string,
    text: string,
    streamingBehavior?: 'steer' | 'followUp',
  ): Promise<boolean> {
    const entry = this.#requireReady(id)
    try {
      return await entry.session.prompt(text, {
        ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
      })
    } catch (error: unknown) {
      this.#fanOut(entry.subscribers, {
        type: 'error',
        data: {
          code: 'prompt_failed',
          message: 'The prompt could not be completed',
        },
      })
      throw operationError(
        'prompt_failed',
        'The prompt could not be completed',
        error,
      )
    }
  }

  async steer(id: string, text: string): Promise<void> {
    const entry = this.#requireReady(id)
    try {
      await entry.session.steer(text)
    } catch (error: unknown) {
      throw operationError(
        'steer_failed',
        'The steering message could not be delivered',
        error,
      )
    }
  }

  async followUp(id: string, text: string): Promise<void> {
    const entry = this.#requireReady(id)
    try {
      await entry.session.followUp(text)
    } catch (error: unknown) {
      throw operationError(
        'follow_up_failed',
        'The follow-up could not be queued',
        error,
      )
    }
  }

  async abort(id: string): Promise<void> {
    const entry = this.#requireReady(id)
    try {
      await entry.session.abort({ reason: 'HTTP API request' })
    } catch (error: unknown) {
      throw operationError(
        'abort_failed',
        'The active turn could not be aborted',
        error,
      )
    }
  }

  newSession(id: string): Promise<SessionSnapshot> {
    return this.#runTransition(
      id,
      'new_session_failed',
      'A new conversation could not be started',
      async (session) => {
        if (!(await session.newSession())) {
          throw new ApiError(
            409,
            'session_transition_cancelled',
            'The new conversation was not started',
          )
        }
      },
    )
  }

  switchSession(id: string, sessionFile: string): Promise<SessionSnapshot> {
    return this.#runTransition(
      id,
      'session_switch_failed',
      'The persisted session could not be opened',
      async (session) => {
        if (!(await session.switchSession(sessionFile))) {
          throw new ApiError(
            409,
            'session_transition_cancelled',
            'The persisted session was not opened',
          )
        }
      },
    )
  }

  fork(id: string): Promise<SessionSnapshot> {
    return this.#runTransition(
      id,
      'session_fork_failed',
      'The session could not be forked',
      async (session) => {
        if (!(await session.fork())) {
          throw new ApiError(
            409,
            'session_transition_cancelled',
            'The session was not forked',
          )
        }
      },
    )
  }

  async branch(
    id: string,
    entryId: string,
  ): Promise<{
    result: { selectedText: string; cancelled: boolean }
    snapshot: SessionSnapshot
  }> {
    const entry = this.#require(id)
    return entry.lock.run(async () => {
      this.#assertReady(entry)
      try {
        const result = await entry.session.branch(entryId)
        return { result, snapshot: this.#snapshot(entry) }
      } catch (error: unknown) {
        if (error instanceof ApiError) throw error
        throw operationError(
          'session_branch_failed',
          'The session could not be branched',
          error,
        )
      }
    })
  }

  async compact(
    id: string,
    customInstructions?: string,
  ): Promise<{ result: unknown; snapshot: SessionSnapshot }> {
    const entry = this.#require(id)
    return entry.lock.run(async () => {
      this.#assertReady(entry)
      try {
        const result = await entry.session.compact(customInstructions)
        return { result, snapshot: this.#snapshot(entry) }
      } catch (error: unknown) {
        throw operationError(
          'session_compact_failed',
          'The session could not be compacted',
          error,
        )
      }
    })
  }

  messages(
    id: string,
    offset: number,
    limit: number,
  ): {
    messages: { entryId: string; message: unknown }[]
    offset: number
    limit: number
    total: number
  } {
    const messages = this.#require(id)
      .session.sessionManager.getEntries()
      .flatMap((entry) =>
        entry.type === 'message'
          ? [{ entryId: entry.id, message: entry.message }]
          : [],
      )
    return {
      messages: messages.slice(offset, offset + limit),
      offset,
      limit,
      total: messages.length,
    }
  }

  stats(id: string): unknown {
    return this.#require(id).session.getSessionStats()
  }

  async setModel(id: string, identifier: string): Promise<SessionSnapshot> {
    const entry = this.#require(id)
    return entry.lock.run(async () => {
      this.#assertReady(entry)
      const models = this.#factory.modelRegistry.getAvailable()
      const exact = models.filter(
        (model) => `${model.provider}/${model.id}` === identifier,
      )
      const matches =
        exact.length > 0
          ? exact
          : models.filter((model) => model.id === identifier)
      if (matches.length !== 1 || matches[0] === undefined) {
        throw new ApiError(
          400,
          'model_not_found',
          'The requested authenticated model was not found or was ambiguous',
        )
      }
      try {
        await entry.session.setModel(matches[0], 'default', {
          selector: `${matches[0].provider}/${matches[0].id}`,
        })
        return this.#snapshot(entry)
      } catch (error: unknown) {
        throw operationError(
          'model_update_failed',
          'The session model could not be changed',
          error,
        )
      }
    })
  }

  async setThinkingLevel(
    id: string,
    level: ThinkingLevelInput,
  ): Promise<SessionSnapshot> {
    const entry = this.#require(id)
    return entry.lock.run(() => {
      this.#assertReady(entry)
      entry.session.setThinkingLevel(level)
      return this.#snapshot(entry)
    })
  }

  async setName(id: string, name: string): Promise<SessionSnapshot> {
    const entry = this.#require(id)
    return entry.lock.run(async () => {
      this.#assertReady(entry)
      try {
        await entry.session.setSessionName(name, 'user')
        return this.#snapshot(entry)
      } catch (error: unknown) {
        throw operationError(
          'session_name_update_failed',
          'The session name could not be changed',
          error,
        )
      }
    })
  }

  async delete(id: string): Promise<void> {
    const entry = this.#require(id)
    this.#entries.delete(id)
    await entry.lock.run(async () => {
      entry.lifecycle = 'stopping'
      this.#fanOut(entry.subscribers, {
        type: 'closed',
        data: { reason: 'session_deleted' },
      })
      entry.unsubscribe()
      const failures: Error[] = []
      try {
        await entry.session.abort({ reason: 'Managed session deleted' })
      } catch (error: unknown) {
        failures.push(normalizeError(error))
      }
      try {
        await entry.session.dispose()
      } catch (error: unknown) {
        failures.push(normalizeError(error))
      }
      for (const subscriber of entry.subscribers) subscriber.close()
      entry.subscribers.clear()
      if (failures.length > 0) {
        throw operationError(
          'session_delete_failed',
          'The managed session was removed but cleanup failed',
          new AggregateError(failures, 'Managed session cleanup failed'),
        )
      }
    })
  }

  async shutdown(): Promise<void> {
    const ids = [...this.#entries.keys()]
    const results = await Promise.allSettled(ids.map((id) => this.delete(id)))
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.#logger.error('Managed session shutdown failed', {
          id: ids[index],
          error: normalizeError(result.reason).message,
        })
      }
    }
  }

  persistedHistory(cwd: string): Promise<unknown[]> {
    return SessionManager.list(cwd)
  }

  async #runTransition(
    id: string,
    code: string,
    message: string,
    operation: (session: AgentSession) => Promise<void>,
  ): Promise<SessionSnapshot> {
    const entry = this.#require(id)
    return entry.lock.run(async () => {
      this.#assertReady(entry)
      try {
        await operation(entry.session)
        return this.#snapshot(entry)
      } catch (error: unknown) {
        if (error instanceof ApiError) throw error
        throw operationError(code, message, error)
      }
    })
  }

  #require(id: string): ManagedSession {
    const entry = this.#entries.get(id)
    if (entry === undefined) {
      throw new ApiError(
        404,
        'session_not_found',
        'Managed session was not found',
      )
    }
    return entry
  }

  #requireReady(id: string): ManagedSession {
    const entry = this.#require(id)
    this.#assertReady(entry)
    return entry
  }

  #assertReady(entry: ManagedSession): void {
    if (entry.lifecycle !== 'ready') {
      throw new ApiError(
        409,
        'session_not_ready',
        'Managed session is not ready for this operation',
      )
    }
  }

  #snapshot(entry: ManagedSession): SessionSnapshot {
    const model = entry.session.model
    return {
      id: entry.id,
      label: entry.label,
      createdAt: entry.createdAt,
      sessionId: entry.session.sessionId,
      cwd: entry.session.sessionManager.getCwd(),
      sessionFile: entry.session.sessionManager.getSessionFile(),
      name: entry.session.sessionManager.getSessionName(),
      status: this.#status(entry),
      model:
        model === undefined
          ? undefined
          : { provider: model.provider, id: model.id },
      thinkingLevel: entry.session.thinkingLevel,
      messageCount: entry.session.messages.length,
    }
  }

  #status(entry: ManagedSession): SessionSnapshot['status'] {
    if (entry.lifecycle === 'starting') return 'starting'
    if (entry.lifecycle === 'stopping') return 'stopping'
    if (entry.lifecycle === 'error') return 'error'
    if (entry.session.isCompacting) return 'compacting'
    return entry.session.isStreaming ? 'running' : 'idle'
  }

  #fanOut(subscribers: Set<EventSubscriber>, event: ServerEvent): void {
    for (const subscriber of subscribers) {
      try {
        subscriber.send(event)
      } catch (error: unknown) {
        subscribers.delete(subscriber)
        subscriber.close()
        this.#logger.warn('SSE subscriber was disconnected', {
          error: normalizeError(error).message,
        })
      }
    }
  }
}
