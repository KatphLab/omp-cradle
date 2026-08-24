import type {
  ExtensionAPI,
  ExtensionContext,
  ToolApprovalDecision,
} from '@oh-my-pi/pi-coding-agent'

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const

type BashSeverity = (typeof SEVERITIES)[number]

async function confirmHighSeverityCommand(
  context: ExtensionContext,
  command: string,
  severity: BashSeverity,
): Promise<boolean> {
  if (severity !== 'high' && severity !== 'critical') return true
  return context.ui.confirm(
    `High-severity command: ${severity}`,
    `Command: ${command}\nDeclared severity: ${severity}`,
  )
}

async function getRejectionMessage(
  context: ExtensionContext,
  command: string,
  severity: BashSeverity,
  rejectedCommands: Set<string>,
): Promise<string | undefined> {
  const rejectionKey = command.trim()
  if (rejectedCommands.has(rejectionKey)) {
    return 'Blocked by user: this command was previously rejected and cannot be retried'
  }

  const allowed = await confirmHighSeverityCommand(context, command, severity)
  if (allowed) return undefined
  context.abort()

  rejectedCommands.add(rejectionKey)
  return `Blocked by user: ${severity}-severity command. Do not retry this command.`
}

interface EditSeverityState {
  rejected: Set<string>
  pending: Map<string, string>
  targetsByKey: Map<string, string>
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getEditDeletion(
  input: unknown,
): { deletionCount: number; rejectionKey: string } | undefined {
  if (!isUnknownRecord(input)) return undefined
  const rawInput = input['input'] ?? input['_input']
  if (typeof rawInput !== 'string') return undefined

  const deletionCount = rawInput.match(/^REM\r?$/gmu)?.length ?? 0
  return deletionCount === 0
    ? undefined
    : { deletionCount, rejectionKey: rawInput.trim() }
}

function editDeletionTargets(input: unknown, deletionCount: number): string {
  if (!isUnknownRecord(input)) return `${deletionCount} file(s)`
  const paths = input['paths']
  if (!Array.isArray(paths)) return `${deletionCount} file(s)`
  const stringPaths = paths.filter(
    (path): path is string => typeof path === 'string',
  )
  return stringPaths.length > 0
    ? stringPaths.join(', ')
    : `${deletionCount} file(s)`
}

function registerEditSeverityHandlers(
  pi: ExtensionAPI,
  state: EditSeverityState,
): void {
  pi.on('tool_call', (event) => {
    if (event.toolName !== 'edit') return
    const deletion = getEditDeletion(event.input)
    if (deletion === undefined) return

    let result:
      | {
          block: true
          reason: string
        }
      | undefined
    if (state.rejected.has(deletion.rejectionKey)) {
      result = {
        block: true,
        reason:
          'Blocked by user: this file deletion was previously rejected and cannot be retried',
      }
    } else {
      state.pending.set(event.toolCallId, deletion.rejectionKey)
      state.targetsByKey.set(
        deletion.rejectionKey,
        editDeletionTargets(event.input, deletion.deletionCount),
      )
    }
    return result
  })

  pi.on('tool_approval_resolved', (event) => {
    if (event.toolName !== 'edit') return
    const rejectionKey = state.pending.get(event.toolCallId)
    if (rejectionKey === undefined) return
    state.pending.delete(event.toolCallId)
    state.targetsByKey.delete(rejectionKey)
    if (!event.approved) state.rejected.add(rejectionKey)
  })
}

function registerEditSeverityTool(pi: ExtensionAPI): void {
  const state: EditSeverityState = {
    rejected: new Set<string>(),
    pending: new Map<string, string>(),
    targetsByKey: new Map<string, string>(),
  }
  registerEditSeverityHandlers(pi, state)

  const nativeEdit = new pi.pi.EditTool({
    cwd: process.cwd(),
    hasUI: false,
    getSessionFile: () => '',
    getSessionSpawns: () => '',
    settings: pi.pi.settings,
  })
  const nativeEditMetadata = {
    concurrency: nativeEdit.concurrency,
    customFormat: nativeEdit.customFormat,
    examples: nativeEdit.examples,
    strict: nativeEdit.strict,
    matcherDigest: nativeEdit.matcherDigest.bind(nativeEdit),
    matcherEntries: nativeEdit.matcherEntries.bind(nativeEdit),
    matcherPaths: nativeEdit.matcherPaths.bind(nativeEdit),
    formatApprovalDetails(input: unknown) {
      const deletion = getEditDeletion(input)
      if (deletion === undefined) {
        return nativeEdit.formatApprovalDetails(input)
      }
      const severity = deletion.deletionCount === 1 ? 'high' : 'critical'
      return [
        `Delete: ${
          state.targetsByKey.get(deletion.rejectionKey) ??
          editDeletionTargets(input, deletion.deletionCount)
        }`,
        `Declared severity: ${severity}`,
      ]
    },
  }

  pi.registerTool({
    ...nativeEditMetadata,
    name: nativeEdit.name,
    label: nativeEdit.label,
    description: nativeEdit.description,
    parameters: nativeEdit.parameters,
    approval(input): ToolApprovalDecision {
      const deletion = getEditDeletion(input)
      if (deletion === undefined) {
        return { tier: nativeEdit.approval(input) }
      }
      const severity = deletion.deletionCount === 1 ? 'high' : 'critical'
      const decision = {
        tier: 'write' as const,
        policy: 'prompt' as const,
        reason: `${severity}-severity file deletion`,
      }
      return decision
    },
    async execute(_toolCallId, parameters, signal, onUpdate, context) {
      if (context.invokeTool === undefined) {
        throw new Error('Native edit tool is unavailable')
      }
      try {
        return await context.invokeTool(parameters, {
          ...(signal === undefined ? {} : { signal }),
          ...(onUpdate === undefined ? {} : { onUpdate }),
        })
      } catch (error_) {
        throw error_ instanceof Error ? error_ : new Error(String(error_))
      }
    },
  })
}

function registerBashSeverityTool(pi: ExtensionAPI): void {
  const rejectedCommands = new Set<string>()
  pi.registerTool({
    name: 'bash',
    label: 'Bash',
    description:
      'Execute a bash command in the current working directory. Every command must declare its severity: low for read-only inspection, medium for reversible local changes, high for destructive or externally visible changes, or critical for broadly destructive commands, remote code execution, or secret exposure. High and critical commands require explicit user confirmation. A command rejected by the user remains blocked for this session and must not be retried with a different severity.',
    parameters: pi.zod.object({
      command: pi.zod.string().describe('The shell command to execute'),
      severity: pi.zod.enum(SEVERITIES).describe('Command severity'),
    }),
    approval: 'exec',
    async execute(
      _toolCallId,
      parameters: { command: string; severity: BashSeverity },
      signal,
      _onUpdate,
      context,
    ) {
      try {
        const rejectionMessage = await getRejectionMessage(
          context,
          parameters.command,
          parameters.severity,
          rejectedCommands,
        )
        if (rejectionMessage !== undefined) {
          return {
            content: [
              {
                type: 'text' as const,
                text: rejectionMessage,
              },
            ],
            details: {
              severity: parameters.severity,
              blocked: true,
            },
          }
        }

        const result = await pi.exec('bash', ['-lc', parameters.command], {
          ...(signal === undefined ? {} : { signal }),
        })
        const output =
          [result.stdout.trimEnd(), result.stderr.trimEnd()]
            .filter((text) => text.length > 0)
            .join('\n') || '(no output)'
        const failed = result.code !== 0 || result.killed
        const text = failed
          ? `${output}\n\nCommand failed with exit code ${result.code}`
          : output

        return {
          content: [{ type: 'text' as const, text }],
          details: {
            severity: parameters.severity,
            exitCode: result.code,
            killed: result.killed,
          },
          ...(failed ? { isError: true } : {}),
        }
      } catch (error_) {
        throw error_ instanceof Error ? error_ : new Error(String(error_))
      }
    },
  })
}

export default function toolSeverityExtension(pi: ExtensionAPI): void {
  pi.setLabel('Tool Severity')
  registerEditSeverityTool(pi)
  registerBashSeverityTool(pi)
}
