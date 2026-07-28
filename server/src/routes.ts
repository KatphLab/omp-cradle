import { Router, type Request } from 'express'

import {
  branchSchema,
  compactSchema,
  createSessionSchema,
  emptyBodySchema,
  historyQuerySchema,
  messageSchema,
  messagesQuerySchema,
  modelUpdateSchema,
  nameUpdateSchema,
  parseInput,
  promptSchema,
  sessionParametersSchema,
  switchSessionSchema,
  thinkingUpdateSchema,
} from './contracts.js'
import { openEventStream } from './event-stream.js'
import {
  resolveWorkingDirectory,
  type SessionFactory,
} from './session-factory.js'
import type { SessionRegistry } from './session-registry.js'

export interface RouteDependencies {
  readonly factory: SessionFactory
  readonly registry: SessionRegistry
  readonly sseHeartbeatMilliseconds: number
}

export function createRoutes(dependencies: RouteDependencies): Router {
  const router = Router()
  registerServiceRoutes(router, dependencies)
  registerSessionRoutes(router, dependencies)
  registerPromptRoutes(router, dependencies.registry)
  registerStateRoutes(router, dependencies.registry)
  return router
}

function registerServiceRoutes(
  router: Router,
  dependencies: RouteDependencies,
): void {
  router.get('/healthz', (_request, response) => {
    response.json({
      data: { status: 'ok', managedSessions: dependencies.registry.size },
    })
  })

  router.get('/v1/models', (_request, response) => {
    const models = dependencies.factory.availableModels().map((model) => ({
      ...model,
      identifier: `${model.provider}/${model.id}`,
    }))
    response.json({ data: { models } })
  })

  router.get('/v1/history', async (request, response) => {
    const query = parseInput(historyQuerySchema, request.query)
    const cwd = await resolveWorkingDirectory(query.cwd)
    const sessions = await dependencies.registry.persistedHistory(cwd)
    response.json({ data: { cwd, sessions } })
  })
}

function registerSessionRoutes(
  router: Router,
  dependencies: RouteDependencies,
): void {
  const { registry } = dependencies
  router.post('/v1/sessions', async (request, response) => {
    const input = parseInput(createSessionSchema, request.body)
    const result = await registry.create(input)
    response.status(201).json({ data: result })
  })

  router.get('/v1/sessions', (_request, response) => {
    response.json({ data: { sessions: registry.list() } })
  })

  router.get('/v1/sessions/:id', (request, response) => {
    response.json({ data: registry.get(sessionId(request)) })
  })

  router.delete('/v1/sessions/:id', async (request, response) => {
    const id = sessionId(request)
    await registry.delete(id)
    response.json({ data: { id, deleted: true } })
  })

  router.get('/v1/sessions/:id/events', (request, response) => {
    openEventStream(
      sessionId(request),
      response,
      registry,
      dependencies.sseHeartbeatMilliseconds,
    )
  })

  registerTransitionRoutes(router, registry)
}

function registerTransitionRoutes(
  router: Router,
  registry: SessionRegistry,
): void {
  router.post('/v1/sessions/:id/new', async (request, response) => {
    parseInput(emptyBodySchema, request.body ?? {})
    response.json({ data: await registry.newSession(sessionId(request)) })
  })

  router.post('/v1/sessions/:id/switch', async (request, response) => {
    const input = parseInput(switchSessionSchema, request.body)
    const snapshot = await registry.switchSession(
      sessionId(request),
      input.sessionFile,
    )
    response.json({ data: snapshot })
  })

  router.post('/v1/sessions/:id/fork', async (request, response) => {
    parseInput(emptyBodySchema, request.body ?? {})
    response.json({ data: await registry.fork(sessionId(request)) })
  })

  router.post('/v1/sessions/:id/branch', async (request, response) => {
    const input = parseInput(branchSchema, request.body)
    response.json({
      data: await registry.branch(sessionId(request), input.entryId),
    })
  })

  router.post('/v1/sessions/:id/compact', async (request, response) => {
    const input = parseInput(compactSchema, request.body ?? {})
    response.json({
      data: await registry.compact(
        sessionId(request),
        input.customInstructions,
      ),
    })
  })
}

function registerPromptRoutes(router: Router, registry: SessionRegistry): void {
  router.post('/v1/sessions/:id/prompts', async (request, response) => {
    const input = parseInput(promptSchema, request.body)
    const id = sessionId(request)
    const accepted = await registry.prompt(
      id,
      input.prompt,
      input.streamingBehavior,
    )
    response.json({ data: { accepted, session: registry.get(id) } })
  })

  router.post('/v1/sessions/:id/steer', async (request, response) => {
    const input = parseInput(messageSchema, request.body)
    const id = sessionId(request)
    await registry.steer(id, input.message)
    response.json({ data: { accepted: true, session: registry.get(id) } })
  })

  router.post('/v1/sessions/:id/follow-ups', async (request, response) => {
    const input = parseInput(messageSchema, request.body)
    const id = sessionId(request)
    await registry.followUp(id, input.message)
    response.json({ data: { accepted: true, session: registry.get(id) } })
  })

  router.post('/v1/sessions/:id/abort', async (request, response) => {
    parseInput(emptyBodySchema, request.body ?? {})
    const id = sessionId(request)
    await registry.abort(id)
    response.json({ data: { aborted: true, session: registry.get(id) } })
  })
}

function registerStateRoutes(router: Router, registry: SessionRegistry): void {
  router.get('/v1/sessions/:id/messages', (request, response) => {
    const query = parseInput(messagesQuerySchema, request.query)
    response.json({
      data: registry.messages(sessionId(request), query.offset, query.limit),
    })
  })

  router.get('/v1/sessions/:id/stats', (request, response) => {
    response.json({ data: registry.stats(sessionId(request)) })
  })

  router.patch('/v1/sessions/:id/model', async (request, response) => {
    const input = parseInput(modelUpdateSchema, request.body)
    response.json({
      data: await registry.setModel(sessionId(request), input.model),
    })
  })

  router.patch('/v1/sessions/:id/thinking', async (request, response) => {
    const input = parseInput(thinkingUpdateSchema, request.body)
    response.json({
      data: await registry.setThinkingLevel(
        sessionId(request),
        input.thinkingLevel,
      ),
    })
  })

  router.patch('/v1/sessions/:id/name', async (request, response) => {
    const input = parseInput(nameUpdateSchema, request.body)
    response.json({
      data: await registry.setName(sessionId(request), input.name),
    })
  })
}

function sessionId(request: Request): string {
  return parseInput(sessionParametersSchema, request.params).id
}
