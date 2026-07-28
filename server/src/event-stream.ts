import type { Response } from 'express'

import type { SessionRegistry } from './session-registry.js'
import type { EventSubscriber, ServerEvent, SessionSnapshot } from './types.js'

type StreamState = 'booting' | 'open' | 'closed'

class SseSubscriber implements EventSubscriber {
  readonly #response: Response
  readonly #heartbeatMilliseconds: number
  readonly #bootQueue: ServerEvent[] = []
  #state: StreamState = 'booting'
  #backpressured = false
  #pendingFrame: string | undefined
  #heartbeat: NodeJS.Timeout | undefined
  #unsubscribe: (() => void) | undefined

  constructor(response: Response, heartbeatMilliseconds: number) {
    this.#response = response
    this.#heartbeatMilliseconds = heartbeatMilliseconds
    response.status(200)
    response.set({
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    })
    response.flushHeaders()
    response.on('drain', () => {
      this.#drainBackpressure()
    })
    response.on('close', () => {
      this.close()
    })
  }

  bind(unsubscribe: () => void): void {
    this.#unsubscribe = unsubscribe
  }

  activate(snapshot: SessionSnapshot, warnings: readonly string[]): void {
    this.#writeEvent({ type: 'snapshot', data: snapshot })
    for (const warning of warnings) {
      this.#writeEvent({ type: 'warning', data: { message: warning } })
    }
    this.#state = 'open'
    const queued = this.#bootQueue.splice(0)
    for (const event of queued) this.send(event)
    this.#heartbeat = setInterval(() => {
      try {
        this.#writeFrame(': heartbeat\n\n')
      } catch {
        this.close()
      }
    }, this.#heartbeatMilliseconds)
    this.#heartbeat.unref()
  }

  send(event: ServerEvent): void {
    if (this.#state === 'closed') return
    if (this.#state === 'booting') {
      this.#bootQueue.push(event)
      return
    }
    this.#writeEvent(event)
  }

  close(): void {
    if (this.#state === 'closed') return
    this.#state = 'closed'
    clearInterval(this.#heartbeat)
    this.#unsubscribe?.()
    this.#bootQueue.length = 0
    this.#pendingFrame = undefined
    if (!this.#response.writableEnded) this.#response.end()
  }

  #writeEvent(event: ServerEvent): void {
    this.#writeFrame(
      `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
    )
  }

  #writeFrame(frame: string): void {
    if (this.#state === 'closed') return
    if (this.#backpressured) {
      if (this.#pendingFrame !== undefined) {
        this.close()
        return
      }
      this.#pendingFrame = frame
      return
    }
    this.#backpressured = !this.#response.write(frame)
  }

  #drainBackpressure(): void {
    if (this.#state === 'closed') return
    this.#backpressured = false
    const pending = this.#pendingFrame
    this.#pendingFrame = undefined
    if (pending !== undefined) this.#writeFrame(pending)
  }
}

export function openEventStream(
  id: string,
  response: Response,
  registry: SessionRegistry,
  heartbeatMilliseconds: number,
): void {
  registry.get(id)
  const subscriber = new SseSubscriber(response, heartbeatMilliseconds)
  const subscription = registry.subscribe(id, subscriber)
  subscriber.bind(subscription.unsubscribe)
  subscriber.activate(subscription.snapshot, subscription.warnings)
}
