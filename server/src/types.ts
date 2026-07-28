import type { AgentSession, AgentSessionEvent } from '@oh-my-pi/pi-coding-agent'

export type SessionStatus =
  'starting' | 'idle' | 'running' | 'compacting' | 'stopping' | 'error'

export type SessionLifecycle = 'starting' | 'ready' | 'stopping' | 'error'

export interface ServerLogger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

export interface ServerEvent {
  readonly type: 'snapshot' | 'omp' | 'warning' | 'error' | 'closed'
  readonly data: unknown
}

export interface EventSubscriber {
  send(event: ServerEvent): void
  close(): void
}

export interface SessionLock {
  run<T>(operation: () => T | Promise<T>): Promise<T>
}

export interface ManagedSession {
  readonly id: string
  readonly label: string | undefined
  readonly createdAt: string
  readonly session: AgentSession
  readonly unsubscribe: () => void
  readonly subscribers: Set<EventSubscriber>
  readonly lock: SessionLock
  readonly warnings: readonly string[]
  lifecycle: SessionLifecycle
}

export interface SessionSnapshot {
  readonly id: string
  readonly label: string | undefined
  readonly createdAt: string
  readonly sessionId: string
  readonly cwd: string
  readonly sessionFile: string | undefined
  readonly name: string | undefined
  readonly status: SessionStatus
  readonly model:
    | {
        readonly provider: string
        readonly id: string
      }
    | undefined
  readonly thinkingLevel: string | undefined
  readonly messageCount: number
}

export interface SessionFactoryResult {
  readonly session: AgentSession
  readonly warning: string | undefined
}

export type OmpEvent = AgentSessionEvent
