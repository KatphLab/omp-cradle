import { formatDuration, truncate } from './format'
import type {
  AgentState,
  BashNodeState,
  BashNodeStatus,
  GraphState,
  SwarmState,
} from './state'

const STATUS_LABELS: Record<string, string> = {
  completed: '[done]',
  running: '[....]',
  failed: '[FAIL]',
  pending: '[    ]',
  waiting: '[wait]',
  stale: '[redo]',
  idle: '[idle]',
  aborted: '[stop]',
}

export function renderSwarmProgress(state: SwarmState): string[] {
  const now = Date.now()
  const agents: AgentState[] = Object.values(state.agents)
  const bashNodes: BashNodeState[] = Object.values(state.bashNodes)
  const graphs: GraphState[] = Object.values(state.graphs)
  const lines = renderHeader(state)

  if (agents.length === 0 && bashNodes.length === 0 && graphs.length === 0)
    return [...lines, '  (no nodes)']

  lines.push(
    ...renderNodeLines(state, '  ', now),
    '',
    renderSummaryLine(state, agents, bashNodes, graphs, now, '  '),
  )
  return lines
}

function renderHeader(state: SwarmState): string[] {
  return [
    `Swarm: ${state.name} [${state.status.toUpperCase()}]`,
    `Mode: ${state.mode} | Iteration: ${state.iteration + 1}/${state.targetCount}`,
    '',
  ]
}

function renderNodeLines(
  state: SwarmState,
  indent: string,
  now: number,
): string[] {
  const agents: AgentState[] = Object.values(state.agents)
  const bashNodes: BashNodeState[] = Object.values(state.bashNodes)
  const graphs: GraphState[] = Object.values(state.graphs)
  return [
    ...agents.map((agent) => renderAgentLine(agent, indent, now)),
    ...bashNodes.map((bashNode) => renderBashLine(bashNode, indent, now)),
    ...graphs.flatMap((graph) => renderGraphSection(graph, indent, now)),
  ]
}

function renderAgentLine(
  agent: AgentState,
  indent: string,
  now: number,
): string {
  const icon = STATUS_LABELS[agent.status] ?? '[????]'
  const duration = formatNodeDuration(agent, now)
  const attemptSuffix = formatAttemptSuffix(agent.attempt)
  const modelSuffix = formatModelSuffix(agent)
  const errorSuffix = formatErrorSuffix(agent.error)
  return `${indent}${icon} ${agent.name}: ${agent.status}${attemptSuffix}${modelSuffix}${duration}${errorSuffix}`
}

function renderBashLine(
  bashNode: BashNodeState,
  indent: string,
  now: number,
): string {
  const icon = STATUS_LABELS[bashNode.status] ?? '[????]'
  const duration = formatNodeDuration(bashNode, now)
  const attemptSuffix = formatAttemptSuffix(bashNode.attempt)
  const outputSuffix =
    bashNode.outputPath === undefined ? '' : ` -> ${bashNode.outputPath}`
  const exitSuffix =
    bashNode.exitCode === undefined ? '' : ` exit ${bashNode.exitCode}`
  const errorSuffix = formatErrorSuffix(bashNode.error)
  return `${indent}${icon} bash ${bashNode.name}: ${bashNode.status}${attemptSuffix}${duration}${outputSuffix}${exitSuffix}${errorSuffix}`
}

function renderGraphSection(
  graph: GraphState,
  indent: string,
  now: number,
): string[] {
  const lines = [renderGraphLine(graph, indent, now)]
  if (graph.childState !== undefined) {
    lines.push(...renderSubgraphSection(graph.childState, `${indent}    `, now))
  }
  return lines
}

function renderGraphLine(
  graph: GraphState,
  indent: string,
  now: number,
): string {
  const icon = STATUS_LABELS[graph.status] ?? '[????]'
  const duration = formatNodeDuration(graph, now)
  const attemptSuffix = formatAttemptSuffix(graph.attempt)
  const roundSuffix = formatRoundSuffix(graph)
  const errorSuffix = formatErrorSuffix(graph.error)
  return `${indent}${icon} graph ${graph.name}: ${graph.status}${attemptSuffix}${roundSuffix}${duration}${errorSuffix}`
}

function renderSubgraphSection(
  child: SwarmState,
  indent: string,
  now: number,
): string[] {
  const agents: AgentState[] = Object.values(child.agents)
  const bashNodes: BashNodeState[] = Object.values(child.bashNodes)
  const graphs: GraphState[] = Object.values(child.graphs)
  const lines = [
    `${indent}subgraph ${child.name} [${child.status.toUpperCase()}] | Mode: ${child.mode} | Iteration: ${child.iteration + 1}/${child.targetCount}`,
  ]
  if (agents.length === 0 && bashNodes.length === 0 && graphs.length === 0) {
    lines.push(`${indent}  (no nodes)`)
    return lines
  }
  lines.push(
    ...renderNodeLines(child, `${indent}  `, now),
    renderSummaryLine(child, agents, bashNodes, graphs, now, `${indent}  `),
  )
  return lines
}

function renderSummaryLine(
  state: SwarmState,
  agents: AgentState[],
  bashNodes: BashNodeState[],
  graphs: GraphState[],
  now: number,
  indent: string,
): string {
  const nodes = [...agents, ...bashNodes, ...graphs]
  const completed = nodes.filter((node) => node.status === 'completed').length
  const running = nodes.filter((node) => node.status === 'running').length
  const failed =
    agents.filter((node) => node.status === 'failed').length +
    bashNodes.filter((node) => isFailedBashStatus(node.status)).length +
    graphs.filter((node) => node.status === 'failed').length
  const parts = [`${completed}/${nodes.length} done`]
  appendCount(parts, running, 'running')
  appendCount(parts, failed, 'failed')
  if (state.restartCount > 0) parts.push(`${state.restartCount} restart(s)`)
  parts.push(`elapsed: ${formatDuration(now - state.startedAt)}`)
  return `${indent}${parts.join(' | ')}`
}

function isFailedBashStatus(status: BashNodeStatus): boolean {
  return status === 'failed'
}

function appendCount(parts: string[], count: number, label: string): void {
  if (count > 0) parts.push(`${count} ${label}`)
}

function formatAttemptSuffix(attempt: number): string {
  return attempt > 1 ? ` attempt ${attempt}` : ''
}

function formatRoundSuffix(graph: GraphState): string {
  if (graph.currentRound === undefined || graph.maxRounds === undefined)
    return ''
  return ` round ${graph.currentRound}/${graph.maxRounds}`
}

function formatModelSuffix(agent: AgentState): string {
  if (agent.resolvedModel !== undefined)
    return ` [model: ${agent.resolvedModel}]`
  if (agent.model !== undefined) return ` [model: ${agent.model}]`
  return ' [model: default]'
}

function formatErrorSuffix(error: string | undefined): string {
  return error === undefined ? '' : ` - ${truncate(error, 60)}`
}

function formatNodeDuration(
  node: {
    startedAt?: number
    completedAt?: number
    status: string
  },
  now: number,
): string {
  if (node.startedAt && node.completedAt) {
    return ` (${formatDuration(node.completedAt - node.startedAt)})`
  }
  if (node.startedAt && isActiveStatus(node.status)) {
    return ` (${formatDuration(now - node.startedAt)}...)`
  }
  return ''
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'waiting'
}
