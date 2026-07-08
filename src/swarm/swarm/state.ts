/**
 * Filesystem state tracker for swarm pipeline execution.
 *
 * Persists pipeline and per-agent state to `.swarm_<name>/` in the workspace.
 * Supports resumability by loading state from disk.
 */
import * as fs from 'node:fs/promises'
import path from 'node:path'

type PipelineStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'
type AgentStatus = 'pending' | 'waiting' | 'running' | 'completed' | 'failed'

export interface AgentState {
  name: string
  status: AgentStatus
  iteration: number
  wave: number
  startedAt?: number
  completedAt?: number
  error?: string
}

export interface SwarmState {
  name: string
  status: PipelineStatus
  mode: string
  iteration: number
  targetCount: number
  agents: Record<string, AgentState>
  startedAt: number
  completedAt?: number
}

export class StateTracker {
  readonly #swarmDir: string
  #state: SwarmState

  constructor(workspaceDirectory: string, name: string) {
    this.#swarmDir = path.join(workspaceDirectory, `.swarm_${name}`)
    this.#state = {
      name,
      status: 'idle',
      mode: 'sequential',
      iteration: 0,
      targetCount: 1,
      agents: {},
      startedAt: Date.now(),
    }
  }

  get swarmDir(): string {
    return this.#swarmDir
  }

  get state(): Readonly<SwarmState> {
    return this.#state
  }

  async init(
    agentNames: string[],
    targetCount: number,
    mode: string,
  ): Promise<void> {
    await fs.mkdir(path.join(this.#swarmDir, 'state'), { recursive: true })
    await fs.mkdir(path.join(this.#swarmDir, 'logs'), { recursive: true })
    await fs.mkdir(path.join(this.#swarmDir, 'context'), { recursive: true })

    this.#state.targetCount = targetCount
    this.#state.mode = mode
    this.#state.status = 'running'
    this.#state.startedAt = Date.now()

    for (const name of agentNames) {
      this.#state.agents[name] = {
        name,
        status: 'pending',
        iteration: 0,
        wave: 0,
      }
    }

    await this.#persist()
  }

  async updateAgent(name: string, update: Partial<AgentState>): Promise<void> {
    const agent = this.#state.agents[name]
    if (!agent) return
    Object.assign(agent, update)
    await this.#persist()
  }

  async updatePipeline(update: Partial<SwarmState>): Promise<void> {
    Object.assign(this.#state, update)
    await this.#persist()
  }

  async appendLog(agentName: string, message: string): Promise<void> {
    const logPath = path.join(this.#swarmDir, 'logs', `${agentName}.log`)
    const timestamp = new Date().toISOString()
    await fs.appendFile(logPath, `[${timestamp}] ${message}\n`)
  }

  async appendOrchestratorLog(message: string): Promise<void> {
    const logPath = path.join(this.#swarmDir, 'logs', 'orchestrator.log')
    const timestamp = new Date().toISOString()
    await fs.appendFile(logPath, `[${timestamp}] ${message}\n`)
  }

  async load(): Promise<SwarmState | undefined> {
    const statePath = path.join(this.#swarmDir, 'state', 'pipeline.json')
    try {
      const content = await fs.readFile(statePath, 'utf8')
      const parsed: unknown = JSON.parse(content)
      if (!isSwarmState(parsed)) return undefined
      this.#state = parsed
      return this.#state
    } catch {
      return undefined
    }
  }

  async #persist(): Promise<void> {
    await fs.writeFile(
      path.join(this.#swarmDir, 'state', 'pipeline.json'),
      JSON.stringify(this.#state, undefined, 2),
    )
  }
}

function isSwarmState(value: unknown): value is SwarmState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    'status' in value &&
    'agents' in value
  )
}
