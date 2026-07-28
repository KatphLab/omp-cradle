import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import type { Server } from 'node:http'

import { createApp } from './app.js'
import { loadServerConfig, type ServerConfig } from './config.js'
import { normalizeError } from './errors.js'
import { SessionFactory } from './session-factory.js'
import { SessionRegistry } from './session-registry.js'
import type { ServerLogger } from './types.js'

class ExtensionServer {
  readonly #httpServer: Server
  readonly #registry: SessionRegistry
  #stopPromise: Promise<void> | undefined

  private constructor(httpServer: Server, registry: SessionRegistry) {
    this.#httpServer = httpServer
    this.#registry = registry
  }

  static async start(
    config: ServerConfig,
    logger: ServerLogger,
  ): Promise<ExtensionServer> {
    const factory = await SessionFactory.initialize()
    const registry = new SessionRegistry(factory, logger)
    const app = createApp({ config, factory, logger, registry })
    const httpServer = app.listen(config.port, config.host)
    await waitForListening(httpServer)
    return new ExtensionServer(httpServer, registry)
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop()
    return this.#stopPromise
  }

  async #stop(): Promise<void> {
    const listenerClosed = closeListener(this.#httpServer)
    await this.#registry.shutdown()
    await listenerClosed
  }
}

let serverPromise: Promise<ExtensionServer> | undefined

export default function serverExtension(pi: ExtensionAPI): void {
  pi.setLabel('OMP Extension Server')

  pi.on('session_start', async () => {
    if (serverPromise !== undefined) {
      await serverPromise.catch(normalizeError)
      return
    }

    const config = loadServerConfig()
    const startup = ExtensionServer.start(config, pi.logger)
    serverPromise = startup
    try {
      await startup
      pi.logger.info('OMP extension server listening', {
        url: `http://${config.host}:${config.port}`,
        authentication: 'disabled',
      })
      if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
        pi.logger.warn(
          'OMP extension server is exposed without authentication',
          {
            host: config.host,
            port: config.port,
          },
        )
      }
    } catch (error: unknown) {
      if (serverPromise === startup) serverPromise = undefined
      const normalized = normalizeError(error)
      pi.logger.error('OMP extension server failed to start', {
        host: config.host,
        port: config.port,
        error: listenerErrorMessage(normalized),
      })
    }
  })

  pi.on('session_shutdown', async () => {
    const active = serverPromise
    serverPromise = undefined
    if (active === undefined) return
    try {
      const server = await active
      await server.stop()
      pi.logger.info('OMP extension server stopped')
    } catch (error: unknown) {
      pi.logger.error('OMP extension server shutdown failed', {
        error: normalizeError(error).message,
      })
    }
  })
}

function waitForListening(server: Server): Promise<boolean> {
  const deferred = Promise.withResolvers<boolean>()
  server.once('listening', () => {
    deferred.resolve(true)
  })
  server.once('error', deferred.reject)
  return deferred.promise
}

function closeListener(server: Server): Promise<boolean> {
  const deferred = Promise.withResolvers<boolean>()
  server.close((error) => {
    if (error === undefined) deferred.resolve(true)
    else deferred.reject(error)
  })
  return deferred.promise
}

function listenerErrorMessage(error: Error): string {
  const code = 'code' in error ? error.code : undefined
  return code === 'EADDRINUSE'
    ? 'The configured address is already in use'
    : error.message
}
