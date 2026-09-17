import type { AssistantMessage } from '@oh-my-pi/pi-ai'
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CustomTool,
} from '@oh-my-pi/pi-coding-agent'
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { AgentSessionEvent } from '@oh-my-pi/pi-coding-agent/session/agent-session-events'
import {
  buildBudgetNotice,
  createSubagentSettings,
  resolveSoftRequestBudget,
} from '@oh-my-pi/pi-coding-agent/task/executor'
import type {
  AgentProgress,
  SingleResult,
} from '@oh-my-pi/pi-coding-agent/task/types'
import { buildNamedToolChoice } from '@oh-my-pi/pi-coding-agent/utils/tool-choice'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createMultiReviewTool } from '../../multi-review'
import { createSwarmSignalTools } from '../signal-tools'
import { createReviewReportTool } from '../workflows/review-pr/report-tool'
import type { SwarmAgent } from './schema'
import {
  CONTROL_DECISION_TOOL_NAME,
  REPEAT_DECISION_TOOL_NAME,
  writeSignalToolContext,
  type SwarmSignalToolContext,
} from './signal-tool-context'
import type { StateTracker } from './state'

const noop = (): void => undefined

function ignoreError(): void {
  return undefined
}

export interface SwarmExecutorOptions {
  workspace: string
  swarmName: string
  iteration: number
  attempt: number
  modelOverride?: string
  signal?: AbortSignal
  onProgress?: (agentName: string, progress: AgentProgress) => void
  modelRegistry?: ModelRegistry
  settings?: Settings
  stateTracker: StateTracker
  signalToolContext?: SwarmSignalToolContext
}

export async function executeSwarmAgent(
  agent: SwarmAgent,
  index: number,
  options: SwarmExecutorOptions,
): Promise<SingleResult> {
  const runId = buildRunId(agent, options)
  await markAgentStarted(agent, options)

  try {
    const result = await runSession(agent, index, runId, options)
    await recordAgentResult(agent, result, options)
    return result
  } catch (error_) {
    const error = error_ instanceof Error ? error_ : new Error(String(error_))
    await recordAgentError(agent, error, options)
    throw error
  }
}

async function markAgentStarted(
  agent: SwarmAgent,
  options: SwarmExecutorOptions,
): Promise<void> {
  await options.stateTracker.updateAgent(agent.name, {
    status: 'running',
    iteration: options.iteration,
    startedAt: Date.now(),
    ...(options.modelOverride === undefined
      ? {}
      : { model: options.modelOverride }),
  })
  await options.stateTracker.appendNodeLog(
    agent.name,
    `Starting iteration ${options.iteration} attempt ${options.attempt}`,
  )
}

function buildSessionOptions(
  agent: SwarmAgent,
  options: SwarmExecutorOptions,
  settings: Settings,
): CreateAgentSessionOptions {
  const tools = buildAgentTools(agent.tools, options.signalToolContext)
  return {
    cwd: options.workspace,
    appendSystemPrompt: buildSystemPrompt(agent),
    ...(tools === undefined ? {} : { toolNames: tools }),
    restrictToolNames: tools !== undefined,
    allowRestrictedCustomTools: true,
    requireYieldTool: true,
    customTools: buildCustomTools(
      tools,
      options.signalToolContext,
      options.modelOverride,
      options.workspace,
      options.swarmName,
      agent.name,
    ),
    enableLsp: false,
    enableMCP: false,
    enableIrc: false,
    disableExtensionDiscovery: true,
    spawns: '',
    taskDepth: 1,
    agentName: agent.name,
    agentDisplayName: agent.name,
    settings,
    ...(options.modelOverride === undefined
      ? {}
      : { modelPattern: options.modelOverride }),
    ...(options.modelRegistry === undefined
      ? {}
      : { modelRegistry: options.modelRegistry }),
  }
}

async function awaitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted()
  const { promise: abortPromise, reject } = Promise.withResolvers<never>()
  const onAbort = (): void => {
    reject(signal.reason)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, abortPromise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function runSession(
  agent: SwarmAgent,
  index: number,
  id: string,
  options: SwarmExecutorOptions,
): Promise<SingleResult> {
  const directory = path.join(options.stateTracker.swarmDir, 'context')
  const settings = createSubagentSettings(
    options.settings ??
      (await Settings.loadReadOnly({ cwd: options.workspace })),
  )
  const limits = monitorSession(
    agent.name,
    options.signal,
    settings.get('task.maxRuntimeMs'),
    settings.get('task.softRequestBudget'),
    settings.get('task.softRequestBudgetNotice'),
  )
  try {
    const session = await createAgentSessionWithLimits(
      agent,
      options,
      settings,
      limits.signal,
    )
    const started = Date.now()
    const progress = initialProgress(agent, index, id)
    const state: SessionResultState = {
      output: '',
      error: undefined,
      stopReason: undefined,
      yielded: false,
    }
    limits.attach(session)
    const unsubscribe = subscribeSession(
      session,
      agent,
      options,
      progress,
      state,
      started,
    )
    try {
      await driveSession(session, agent.task, state, limits)
      return await persistSessionResult(
        directory,
        id,
        progress,
        state,
        started,
        limits.signal,
      )
    } finally {
      unsubscribe()
      await session.dispose()
    }
  } finally {
    limits.dispose()
  }
}

interface SessionResultState {
  output: string
  error: string | undefined
  stopReason: string | undefined
  yielded: boolean
}
interface SessionMonitor {
  signal: AbortSignal
  attach(session: AgentSession): void
  budgetStopRequested(): boolean
  waitForBudgetStop(): Promise<void>
  dispose(): void
}

async function createAgentSessionWithLimits(
  agent: SwarmAgent,
  options: SwarmExecutorOptions,
  settings: Settings,
  signal: AbortSignal,
): Promise<AgentSession> {
  const sessionManagerPromise = createSessionManager(options)
  let sessionManager: SessionManager
  try {
    sessionManager = await awaitAbortable(sessionManagerPromise, signal)
  } catch (error_) {
    void sessionManagerPromise.catch(ignoreError)
    throw error_
  }

  const sessionPromise = createAgentSession({
    ...buildSessionOptions(agent, options, settings),
    sessionManager,
    agentId: sessionManager.getSessionId(),
  })
  try {
    const { session } = await awaitAbortable(sessionPromise, signal)
    return session
  } catch (error_) {
    void sessionPromise
      .then(({ session: lateSession }) => lateSession.dispose())
      .catch(ignoreError)
    throw error_
  }
}

function subscribeSession(
  session: AgentSession,
  agent: SwarmAgent,
  options: SwarmExecutorOptions,
  progress: AgentProgress,
  state: SessionResultState,
  started: number,
): () => void {
  return session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant')
      updateAssistantResult(event.message, progress, state)
    if (isSuccessfulYieldEvent(event)) state.yielded = true
    if (session.model !== undefined)
      progress.resolvedModel = `${session.model.provider}/${session.model.id}`
    progress.durationMs = Date.now() - started
    options.onProgress?.(agent.name, { ...progress })
  })
}

function updateAssistantResult(
  message: AssistantMessage,
  progress: AgentProgress,
  state: SessionResultState,
): void {
  progress.requests++
  progress.tokens +=
    message.usage.input + message.usage.output + message.usage.cacheWrite
  progress.cost += message.usage.cost.total
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (text.length > 0)
    state.output += state.output.length > 0 ? `\n${text}` : text
  state.stopReason = message.stopReason
  state.error =
    message.stopReason === 'error' || message.stopReason === 'aborted'
      ? (message.errorMessage ?? `Agent ${message.stopReason}`)
      : undefined
}

function isSuccessfulYieldEvent(event: AgentSessionEvent): boolean {
  if (
    event.type !== 'tool_execution_end' ||
    event.toolName !== 'yield' ||
    event.isError
  )
    return false
  const result: unknown = event.result
  if (typeof result !== 'object' || result === null || !('details' in result))
    return false
  const details = result.details
  return (
    typeof details === 'object' &&
    details !== null &&
    'status' in details &&
    details.status === 'success'
  )
}

async function driveSession(
  session: AgentSession,
  task: string,
  state: SessionResultState,
  limits: SessionMonitor,
): Promise<void> {
  limits.signal.throwIfAborted()
  try {
    await awaitAbortable(session.prompt(task), limits.signal)
    await awaitAbortable(session.waitForIdle(), limits.signal)
  } catch (error_) {
    if (!limits.budgetStopRequested()) throw error_
  }

  await limits.waitForBudgetStop()
  if (!limits.budgetStopRequested()) return
  limits.signal.throwIfAborted()
  if (state.yielded) return

  const forcedYield = buildNamedToolChoice('yield', session.model)
  await awaitAbortable(
    session.prompt(
      'Your request budget was reached. Stop investigating and yield your final report now.',
      {
        synthetic: true,
        ...(forcedYield === undefined ? {} : { toolChoice: forcedYield }),
      },
    ),
    limits.signal,
  )
  await awaitAbortable(session.waitForIdle(), limits.signal)
}

async function persistSessionResult(
  directory: string,
  id: string,
  progress: AgentProgress,
  state: SessionResultState,
  started: number,
  signal: AbortSignal,
): Promise<SingleResult> {
  if (!state.yielded)
    state.error ??=
      state.stopReason === 'length'
        ? 'Swarm agent reached the response length limit before yielding'
        : 'Swarm agent did not call yield'
  const outputPath = path.join(directory, `${id}.md`)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(outputPath, state.output)
  signal.throwIfAborted()
  const result = {
    ...progress,
    durationMs: Date.now() - started,
    output: state.output,
    outputPath,
    exitCode: state.yielded ? 0 : 1,
    stderr: state.error ?? '',
    truncated: false,
  }
  return state.error === undefined ? result : { ...result, error: state.error }
}

function initialProgress(
  agent: SwarmAgent,
  index: number,
  id: string,
): AgentProgress {
  return {
    index,
    id,
    agent: agent.name,
    agentSource: 'project',
    task: agent.task,
    status: 'running',
    recentTools: [],
    recentOutput: [],
    toolCount: 0,
    requests: 0,
    tokens: 0,
    cost: 0,
    durationMs: 0,
  }
}

async function createSessionManager(
  options: SwarmExecutorOptions,
): Promise<SessionManager> {
  const sessionManager = SessionManager.create(
    options.workspace,
    path.join(options.stateTracker.swarmDir, 'context'),
  )
  const sessionFile = sessionManager.getSessionFile()
  if (sessionFile === undefined)
    throw new Error('Swarm session persistence is unavailable')
  if (options.signalToolContext !== undefined) {
    await writeSignalToolContext(
      options.stateTracker.swarmDir,
      path.basename(sessionFile, '.jsonl'),
      options.signalToolContext,
    )
  }
  return sessionManager
}

function buildAgentTools(
  configuredTools: string[] | undefined,
  signalToolContext: SwarmSignalToolContext | undefined,
): string[] | undefined {
  if (configuredTools === undefined) return undefined
  const tools = [...configuredTools]
  if (
    signalToolContext !== undefined &&
    signalToolContext.controls.length > 0 &&
    !tools.includes(CONTROL_DECISION_TOOL_NAME)
  ) {
    tools.push(CONTROL_DECISION_TOOL_NAME)
  }
  if (
    signalToolContext !== undefined &&
    signalToolContext.repeats.length > 0 &&
    !tools.includes(REPEAT_DECISION_TOOL_NAME)
  ) {
    tools.push(REPEAT_DECISION_TOOL_NAME)
  }
  return tools
}

function buildCustomTools(
  tools: string[] | undefined,
  signalToolContext: SwarmSignalToolContext | undefined,
  modelOverride: string | undefined,
  workspace: string,
  swarmName: string,
  agentName: string,
): CustomTool[] {
  const customTools: CustomTool[] = []
  if (signalToolContext !== undefined) {
    for (const signalTool of createSwarmSignalTools()) {
      const applicable =
        signalTool.name === CONTROL_DECISION_TOOL_NAME
          ? signalToolContext.controls.length > 0
          : signalToolContext.repeats.length > 0
      if (applicable) customTools.push(signalTool)
    }
  }
  if (tools?.includes('multi_review'))
    customTools.push(createMultiReviewTool(modelOverride))
  if (tools?.includes('write_review_report'))
    customTools.push(createReviewReportTool(workspace, swarmName, agentName))
  return customTools
}

function buildRunId(
  agent: SwarmAgent,
  options: Pick<SwarmExecutorOptions, 'swarmName' | 'iteration' | 'attempt'>,
): string {
  return `swarm-${options.swarmName}-${agent.name}-${options.iteration}-attempt${options.attempt}`
}

async function recordAgentResult(
  agent: SwarmAgent,
  result: SingleResult,
  options: SwarmExecutorOptions,
): Promise<void> {
  const status =
    result.exitCode === 0 ? ('completed' as const) : ('failed' as const)
  const update = {
    status,
    completedAt: Date.now(),
    ...(result.resolvedModel === undefined
      ? {}
      : { resolvedModel: result.resolvedModel }),
  }
  await options.stateTracker.updateAgent(
    agent.name,
    result.error === undefined ? update : { ...update, error: result.error },
  )
  const errorSuffix = result.error ? `: ${result.error}` : ''
  await options.stateTracker.appendNodeLog(
    agent.name,
    `Iteration ${options.iteration} attempt ${options.attempt} ${status}${errorSuffix}`,
  )
}

async function recordAgentError(
  agent: SwarmAgent,
  error_: unknown,
  options: SwarmExecutorOptions,
): Promise<void> {
  const error = error_ instanceof Error ? error_.message : String(error_)
  await options.stateTracker.updateAgent(agent.name, {
    status: 'failed',
    completedAt: Date.now(),
    error,
  })
  await options.stateTracker.appendNodeLog(
    agent.name,
    `Iteration ${options.iteration} attempt ${options.attempt} error: ${error}`,
  )
}

function buildSystemPrompt(agent: SwarmAgent): string {
  const parts = [`You are a ${agent.role}.`]
  if (agent.extraContext) {
    parts.push(agent.extraContext)
  }
  return parts.join('\n\n')
}

interface BudgetMonitorState {
  budget: number
  stopThreshold: number
  requests: number
  stopped: boolean
  abortPromise: Promise<void> | undefined
}

function getAssistantMessage(
  event: AgentSessionEvent,
): AssistantMessage | undefined {
  if (event.type !== 'message_end' || event.message.role !== 'assistant')
    return undefined
  return event.message
}

function handleBudgetMessage(
  session: AgentSession,
  message: AssistantMessage,
  state: BudgetMonitorState,
  budgetNotice: boolean,
  abortSession: () => Promise<void>,
  hardAbort: (reason: string) => void,
): void {
  state.requests++
  if (
    state.budget === 0 ||
    message.content.some(
      (block) => block.type === 'toolCall' && block.name === 'yield',
    )
  )
    return
  if (state.stopped) {
    if (state.requests >= state.stopThreshold + 5)
      hardAbort('Swarm agent request budget exceeded')
    return
  }
  if (state.requests >= state.stopThreshold) {
    state.stopped = true
    state.abortPromise = abortSession()
    return
  }
  if (state.requests === state.budget && budgetNotice)
    void session
      .sendUserMessage(buildBudgetNotice(state.requests, state.budget), {
        deliverAs: 'steer',
      })
      .catch(ignoreError)
}

function monitorSession(
  agentName: string,
  parent: AbortSignal | undefined,
  runtimeValue: number,
  budgetValue: number,
  budgetNotice: boolean,
): SessionMonitor {
  const controller = new AbortController()
  const state: BudgetMonitorState = {
    budget: resolveSoftRequestBudget(
      agentName,
      Math.max(0, Math.trunc(budgetValue || 0)),
    ),
    stopThreshold: 0,
    requests: 0,
    stopped: false,
    abortPromise: undefined,
  }
  state.stopThreshold = Math.ceil(state.budget * 1.5)
  let activeSession: AgentSession | undefined
  let unsubscribe = noop
  const abortSession = (): Promise<void> =>
    activeSession?.abort().catch(ignoreError) ?? Promise.resolve()
  const hardAbort = (reason: string): void => {
    if (controller.signal.aborted) return
    controller.abort(new Error(reason))
    void abortSession()
  }
  const parentAbort = (): void => {
    hardAbort('Swarm agent was cancelled')
  }
  const onAbort = (): void => {
    void abortSession()
  }
  controller.signal.addEventListener('abort', onAbort, { once: true })
  parent?.addEventListener('abort', parentAbort, { once: true })
  if (parent?.aborted) parentAbort()
  const runtime = Math.max(0, Math.trunc(runtimeValue || 0))
  const timer =
    runtime > 0
      ? setTimeout(() => {
          hardAbort('Swarm agent runtime limit exceeded')
        }, runtime)
      : undefined

  return {
    signal: controller.signal,
    attach(session: AgentSession): void {
      activeSession = session
      if (controller.signal.aborted) {
        void abortSession()
        return
      }
      unsubscribe = session.subscribe((event) => {
        const message = getAssistantMessage(event)
        if (message !== undefined)
          handleBudgetMessage(
            session,
            message,
            state,
            budgetNotice,
            abortSession,
            hardAbort,
          )
      })
    },
    budgetStopRequested(): boolean {
      return state.stopped
    },
    waitForBudgetStop(): Promise<void> {
      return state.abortPromise ?? Promise.resolve()
    },
    dispose(): void {
      clearTimeout(timer)
      unsubscribe()
      parent?.removeEventListener('abort', parentAbort)
      controller.signal.removeEventListener('abort', onAbort)
    },
  }
}
