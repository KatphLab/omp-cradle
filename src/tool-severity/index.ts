import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'

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

function editDeletionTargets(
  input: Record<string, unknown>,
  deletionCount: number,
): string {
  if (!Array.isArray(input['paths'])) return `${deletionCount} file(s)`
  const paths = input['paths'].filter(
    (path): path is string => typeof path === 'string',
  )
  return paths.length > 0 ? paths.join(', ') : `${deletionCount} file(s)`
}

function hasUIContext(value: unknown): value is Pick<ExtensionContext, 'ui'> {
  return typeof value === 'object' && value !== null && 'ui' in value
}

async function getEditDeletionRejection(
  context: ExtensionContext,
  input: Record<string, unknown>,
  rejectedDeletions: Set<string>,
): Promise<string | undefined> {
  const rawInput = input['input'] ?? input['_input']
  if (typeof rawInput !== 'string') return undefined

  const deletionCount = rawInput.match(/^REM\r?$/gmu)?.length ?? 0
  if (deletionCount === 0) return undefined

  const rejectionKey = rawInput.trim()
  if (rejectedDeletions.has(rejectionKey)) {
    return 'Blocked by user: this file deletion was previously rejected and cannot be retried'
  }

  const severity: BashSeverity = deletionCount === 1 ? 'high' : 'critical'
  // Event-scoped dialogs inherit the handler's 30-second timeout. Human approval must not.
  const baseContext: unknown = Object.getPrototypeOf(context)
  const ui = hasUIContext(baseContext) ? baseContext.ui : context.ui
  const allowed = await ui.confirm(
    `High-severity edit: ${severity}`,
    `Delete: ${editDeletionTargets(input, deletionCount)}\nDeclared severity: ${severity}`,
  )
  if (allowed) return undefined

  rejectedDeletions.add(rejectionKey)
  return `Blocked by user: ${severity}-severity file deletion. Do not retry this edit.`
}

export default function toolSeverityExtension(pi: ExtensionAPI): void {
  pi.setLabel('Tool Severity')
  const rejectedCommands = new Set<string>()
  const rejectedEditDeletions = new Set<string>()

  pi.on('tool_call', async (event, context) => {
    if (event.toolName !== 'edit') return
    const reason = await getEditDeletionRejection(
      context,
      event.input,
      rejectedEditDeletions,
    )
    return reason === undefined ? undefined : { block: true, reason }
  })

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
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
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
