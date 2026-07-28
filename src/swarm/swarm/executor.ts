/**
 * Swarm agent execution via oh-my-pi's subagent infrastructure.
 */
import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import {
  runSubprocess,
  type ExecutorOptions,
} from '@oh-my-pi/pi-coding-agent/task/executor'
import type {
  AgentDefinition,
  AgentProgress,
  SingleResult,
} from '@oh-my-pi/pi-coding-agent/task/types'
import path from 'node:path'
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
  if (options.signalToolContext !== undefined) {
    await writeSignalToolContext(
      options.stateTracker.swarmDir,
      runId,
      options.signalToolContext,
    )
  }
  await markAgentStarted(agent, options)

  try {
    const result = await runSubprocess(
      buildExecutorOptions(agent, index, options),
    )
    await recordAgentResult(agent, result, options)
    return result
  } catch (error_) {
    await recordAgentError(agent, error_, options)
    throw error_
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

function buildExecutorOptions(
  agent: SwarmAgent,
  index: number,
  options: SwarmExecutorOptions,
): ExecutorOptions {
  const executorOptions: ExecutorOptions = {
    cwd: options.workspace,
    agent: buildAgentDefinition(agent, options.signalToolContext),
    task: agent.task,
    index,
    id: buildRunId(agent, options),
    onProgress: (progress) => {
      if (
        progress.resolvedModel !== undefined &&
        options.stateTracker.state.agents[agent.name]?.resolvedModel !==
          progress.resolvedModel
      ) {
        void options.stateTracker
          .updateAgent(agent.name, { resolvedModel: progress.resolvedModel })
          .catch(ignoreProgressPersistenceError)
      }
      options.onProgress?.(agent.name, progress)
    },
    enableLsp: false,
    artifactsDir: path.join(options.stateTracker.swarmDir, 'context'),
  }
  if (options.modelOverride !== undefined)
    executorOptions.modelOverride = options.modelOverride
  if (options.signal !== undefined) executorOptions.signal = options.signal
  if (options.modelRegistry !== undefined)
    executorOptions.modelRegistry = options.modelRegistry
  if (options.settings !== undefined)
    executorOptions.settings = options.settings
  return executorOptions
}

function buildAgentDefinition(
  agent: SwarmAgent,
  signalToolContext: SwarmSignalToolContext | undefined,
): AgentDefinition {
  const tools = buildAgentTools(agent.tools, signalToolContext)
  return {
    name: agent.name,
    description: `Swarm agent: ${agent.role}`,
    systemPrompt: buildSystemPrompt(agent),
    source: 'project',
    ...(tools === undefined ? {} : { tools }),
  }
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

function ignoreProgressPersistenceError(error: unknown): void {
  if (error instanceof Error) return
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
