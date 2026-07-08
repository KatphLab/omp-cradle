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
import type { StateTracker } from './state'

export interface SwarmExecutorOptions {
  workspace: string
  swarmName: string
  iteration: number
  modelOverride?: string
  signal?: AbortSignal
  onProgress?: (agentName: string, progress: AgentProgress) => void
  modelRegistry?: ModelRegistry
  settings?: Settings
  stateTracker: StateTracker
}

export async function executeSwarmAgent(
  agent: SwarmAgent,
  index: number,
  options: SwarmExecutorOptions,
): Promise<SingleResult> {
  const {
    workspace,
    swarmName,
    iteration,
    modelOverride,
    signal,
    onProgress,
    modelRegistry,
    settings,
    stateTracker,
  } = options
  const agentId = `swarm-${swarmName}-${agent.name}-${iteration}`
  const agentDefinition: AgentDefinition = {
    name: agent.name,
    description: `Swarm agent: ${agent.role}`,
    systemPrompt: buildSystemPrompt(agent),
    source: 'project',
  }

  await stateTracker.updateAgent(agent.name, {
    status: 'running',
    iteration,
    startedAt: Date.now(),
  })
  await stateTracker.appendLog(agent.name, `Starting iteration ${iteration}`)

  try {
    const executorOptions: ExecutorOptions = {
      cwd: workspace,
      agent: agentDefinition,
      task: agent.task,
      index,
      id: agentId,
      onProgress: (progress) => onProgress?.(agent.name, progress),
      enableLsp: false,
      artifactsDir: path.join(stateTracker.swarmDir, 'context'),
    }
    if (modelOverride !== undefined)
      executorOptions.modelOverride = modelOverride
    if (signal !== undefined) executorOptions.signal = signal
    if (modelRegistry !== undefined)
      executorOptions.modelRegistry = modelRegistry
    if (settings !== undefined) executorOptions.settings = settings

    const result = await runSubprocess(executorOptions)

    const status =
      result.exitCode === 0 ? ('completed' as const) : ('failed' as const)
    const update = {
      status,
      completedAt: Date.now(),
    }
    await stateTracker.updateAgent(
      agent.name,
      result.error === undefined ? update : { ...update, error: result.error },
    )
    const errorSuffix = result.error ? `: ${result.error}` : ''
    await stateTracker.appendLog(
      agent.name,
      `Iteration ${iteration} ${status}${errorSuffix}`,
    )

    return result
  } catch (error_) {
    const error = error_ instanceof Error ? error_.message : String(error_)
    await stateTracker.updateAgent(agent.name, {
      status: 'failed',
      completedAt: Date.now(),
      error,
    })
    await stateTracker.appendLog(
      agent.name,
      `Iteration ${iteration} error: ${error}`,
    )
    throw error_
  }
}

function buildSystemPrompt(agent: SwarmAgent): string {
  const parts = [`You are a ${agent.role}.`]
  if (agent.extraContext) {
    parts.push(agent.extraContext)
  }
  return parts.join('\n\n')
}
