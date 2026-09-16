import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type CustomTool,
} from '@oh-my-pi/pi-coding-agent'
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import {
  buildBudgetNotice,
  createSubagentSettings,
  resolveSoftRequestBudget,
} from '@oh-my-pi/pi-coding-agent/task/executor'
import type {
  AgentProgress,
  SingleResult,
} from '@oh-my-pi/pi-coding-agent/task/types'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createMultiReviewTool } from '../../multi-review'
import { createReviewReportTool } from '../review-report-tool'
import { createSwarmSignalTools } from '../signal-tools'
import type { SwarmAgent } from './schema'
import {
  CONTROL_DECISION_TOOL_NAME,
  REPEAT_DECISION_TOOL_NAME,
  writeSignalToolContext,
  type SwarmSignalToolContext,
} from './signal-tool-context'
import type { StateTracker } from './state'

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
): CreateAgentSessionOptions {
  const tools = buildAgentTools(agent.tools, options.signalToolContext)
  return {
    cwd: options.workspace,
    appendSystemPrompt: buildSystemPrompt(agent),
    ...(tools === undefined ? {} : { toolNames: tools }),
    restrictToolNames: tools !== undefined,
    allowRestrictedCustomTools: true,
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
    ...(options.modelOverride === undefined
      ? {}
      : { modelPattern: options.modelOverride }),
    ...(options.modelRegistry === undefined
      ? {}
      : { modelRegistry: options.modelRegistry }),
  }
}

async function runSession(
  agent: SwarmAgent,
  index: number,
  id: string,
  options: SwarmExecutorOptions,
): Promise<SingleResult> {
  options.signal?.throwIfAborted()
  const directory = path.join(options.stateTracker.swarmDir, 'context')
  const sessionManager = await createSessionManager(options)
  const { session } = await createAgentSession({
    ...buildSessionOptions(agent, options),
    sessionManager,
    settings: createSubagentSettings(
      options.settings ??
        (await Settings.loadReadOnly({ cwd: options.workspace })),
    ),
    agentId: sessionManager.getSessionId(),
  })
  const started = Date.now()
  const progress = initialProgress(agent, index, id)
  let output = ''
  let error: string | undefined
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'tool_execution_start') {
      progress.toolCount++
      progress.currentTool = event.toolName
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message
      progress.requests++
      progress.tokens +=
        message.usage.input + message.usage.output + message.usage.cacheWrite
      progress.cost += message.usage.cost.total
      output = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      error =
        message.stopReason === 'error' || message.stopReason === 'aborted'
          ? (message.errorMessage ?? `Agent ${message.stopReason}`)
          : undefined
    }
    if (session.model !== undefined)
      progress.resolvedModel = `${session.model.provider}/${session.model.id}`
    progress.durationMs = Date.now() - started
    options.onProgress?.(agent.name, { ...progress })
  })
  const limits = monitorSession(session, agent.name, options.signal)
  try {
    options.signal?.throwIfAborted()
    if (!(await session.prompt(agent.task)))
      throw new Error('Swarm agent prompt did not execute')
    limits.signal.throwIfAborted()
    const outputPath = path.join(directory, `${id}.md`)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(outputPath, output)
    return {
      ...progress,
      durationMs: Date.now() - started,
      output,
      outputPath,
      exitCode: error === undefined ? 0 : 1,
      stderr: error ?? '',
      truncated: false,
      ...(error === undefined ? {} : { error }),
    }
  } finally {
    limits.dispose()
    unsubscribe()
    await session.dispose()
  }
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

function monitorSession(
  session: AgentSession,
  agentName: string,
  parent: AbortSignal | undefined,
) {
  const controller = new AbortController()
  const stop = (reason: string) => {
    controller.abort(new Error(reason))
  }
  const abort = () => {
    session.agent.abort()
  }
  const parentAbort = () => {
    stop('Swarm agent was cancelled')
  }
  controller.signal.addEventListener('abort', abort, { once: true })
  parent?.addEventListener('abort', parentAbort, { once: true })
  if (parent?.aborted) parentAbort()
  const runtime = session.settings.get('task.maxRuntimeMs')
  const timer =
    runtime > 0
      ? setTimeout(() => {
          stop('Swarm agent runtime limit exceeded')
        }, runtime)
      : undefined
  const budget = resolveSoftRequestBudget(
    agentName,
    session.settings.get('task.softRequestBudget'),
  )
  let requests = 0
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type !== 'message_end' ||
      event.message.role !== 'assistant' ||
      budget === 0
    )
      return
    requests++
    if (requests >= Math.ceil(budget * 1.5))
      stop('Swarm agent request budget exceeded')
    else if (
      requests === budget &&
      session.settings.get('task.softRequestBudgetNotice')
    ) {
      void session
        .sendUserMessage(buildBudgetNotice(requests, budget), {
          deliverAs: 'steer',
        })
        .catch(() => {
          stop('Could not deliver swarm request budget notice')
        })
    }
  })
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      unsubscribe()
      parent?.removeEventListener('abort', parentAbort)
      controller.signal.removeEventListener('abort', abort)
    },
  }
}
