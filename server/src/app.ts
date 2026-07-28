import express, { type Express } from 'express'

import type { ServerConfig } from './config.js'
import { createErrorHandler } from './errors.js'
import { createRoutes } from './routes.js'
import type { SessionFactory } from './session-factory.js'
import type { SessionRegistry } from './session-registry.js'
import type { ServerLogger } from './types.js'

export interface AppDependencies {
  readonly config: ServerConfig
  readonly factory: SessionFactory
  readonly logger: ServerLogger
  readonly registry: SessionRegistry
}

export function createApp(dependencies: AppDependencies): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: dependencies.config.jsonBodyLimit }))
  app.use((request, response, next) => {
    const startedAt = performance.now()
    response.on('finish', () => {
      dependencies.logger.info('HTTP request completed', {
        method: request.method,
        path: request.path,
        status: response.statusCode,
        durationMilliseconds: Math.round(performance.now() - startedAt),
      })
    })
    next()
  })
  app.use(
    createRoutes({
      factory: dependencies.factory,
      registry: dependencies.registry,
      sseHeartbeatMilliseconds: dependencies.config.sseHeartbeatMilliseconds,
    }),
  )
  app.use((request, response) => {
    response.status(404).json({
      error: {
        code: 'route_not_found',
        message: `No route matches ${request.method} ${request.path}`,
      },
    })
  })
  app.use(createErrorHandler(dependencies.logger))
  return app
}
