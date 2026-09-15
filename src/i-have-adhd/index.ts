// Adapted from ayoubben18/i-have-adhd; see LICENSE in this directory.
import {
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionContext,
} from '@oh-my-pi/pi-coding-agent'
import { readFile } from 'node:fs/promises'

const SKILL_URL = new URL('../../skills/i-have-adhd/SKILL.md', import.meta.url)
const STATE_TYPE = 'i-have-adhd-state'
const RULES_TYPE = 'i-have-adhd-rules'
const DISABLED_TYPE = 'i-have-adhd-disabled'
const STOP_PHRASES = new Set(['stop adhd mode', 'normal mode'])
const RULES_HEADER =
  'ADHD MODE ACTIVE. The ruleset below applies to every response until turned off. "stop adhd mode" or "normal mode" turns it off for this session.'
const DISABLED_NOTICE =
  'ADHD MODE OFF. Ignore the i-have-adhd ruleset injected earlier in this conversation and return to your default response style.'

function stripFrontmatter(content: string): string {
  const lines = content.split('\n')
  const end = lines.indexOf('---', 1)
  return (lines[0] === '---' && end !== -1 ? lines.slice(end + 1) : lines)
    .join('\n')
    .trim()
}

function savedState(ctx: ExtensionContext): boolean | undefined {
  let enabled: boolean | undefined
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== STATE_TYPE) continue
    if (typeof entry.data !== 'object' || entry.data === null) continue
    if (!('enabled' in entry.data) || typeof entry.data.enabled !== 'boolean')
      continue
    enabled = entry.data.enabled
  }
  return enabled
}

function rulesAreInContext(ctx: ExtensionContext): boolean {
  let active = false
  const { messages } = buildSessionContext(ctx.sessionManager.getBranch())
  for (const message of messages) {
    if (message.role !== 'custom') continue
    if (message.customType === RULES_TYPE) active = true
    else if (message.customType === DISABLED_TYPE) active = false
  }
  return active
}

export default async function indexHaveAdhdExtension(
  pi: ExtensionAPI,
): Promise<void> {
  pi.setLabel('I Have ADHD')
  const rules = stripFrontmatter(await readFile(SKILL_URL, 'utf8'))
  let enabled = false

  const updateStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      'i-have-adhd',
      enabled ? ctx.ui.theme.fg('accent', 'ADHD ON') : undefined,
    )
  }

  const syncContext = (ctx: ExtensionContext): void => {
    const injected = rulesAreInContext(ctx)
    if (enabled === injected) return
    pi.sendMessage(
      {
        customType: enabled ? RULES_TYPE : DISABLED_TYPE,
        content: enabled ? `${RULES_HEADER}\n\n${rules}` : DISABLED_NOTICE,
        display: false,
      },
      { triggerTurn: false },
    )
  }

  const restoreState = (ctx: ExtensionContext, sync = true): void => {
    enabled = savedState(ctx) ?? pi.getFlag('adhd') === true
    updateStatus(ctx)
    if (sync) syncContext(ctx)
  }

  const setEnabled = (nextEnabled: boolean, ctx: ExtensionContext): void => {
    enabled = nextEnabled
    pi.appendEntry(STATE_TYPE, { enabled })
    updateStatus(ctx)
    syncContext(ctx)
    ctx.ui.notify(`ADHD mode ${enabled ? 'enabled' : 'disabled'}.`, 'info')
  }

  pi.registerFlag('adhd', {
    description: 'Start with ADHD-friendly output enabled',
    type: 'boolean',
    default: false,
  })
  registerCommand(pi, () => enabled, setEnabled)
  registerEvents(pi, () => enabled, setEnabled, restoreState, syncContext)
}

function registerCommand(
  pi: ExtensionAPI,
  isEnabled: () => boolean,
  setEnabled: (enabled: boolean, ctx: ExtensionContext) => void,
): void {
  pi.registerCommand('i-have-adhd', {
    description: 'Toggle ADHD-friendly output for this session',
    handler: (args, ctx) => {
      const argument = args.trim().toLowerCase()
      switch (argument) {
        case '': {
          setEnabled(!isEnabled(), ctx)
          break
        }
        case 'on': {
          setEnabled(true, ctx)
          break
        }
        case 'off':
        case 'stop': {
          setEnabled(false, ctx)
          break
        }
        default: {
          ctx.ui.notify('Usage: /i-have-adhd [on|off|stop]', 'warning')
        }
      }
      return Promise.resolve()
    },
  })
}

function registerEvents(
  pi: ExtensionAPI,
  isEnabled: () => boolean,
  setEnabled: (enabled: boolean, ctx: ExtensionContext) => void,
  restoreState: (ctx: ExtensionContext, sync?: boolean) => void,
  syncContext: (ctx: ExtensionContext) => void,
): void {
  pi.on('input', (event, ctx) => {
    const input = event.text.trim().toLowerCase()
    if (input === '/skill:i-have-adhd') {
      setEnabled(true, ctx)
      return { handled: true }
    }
    if (isEnabled() && STOP_PHRASES.has(input)) {
      setEnabled(false, ctx)
      if (ctx.hasUI) return { handled: true }
      return { text: 'Reply with exactly: ADHD mode disabled.' }
    }
    return {}
  })
  pi.on('session_start', (_event, ctx) => {
    restoreState(ctx)
  })
  pi.on('session_switch', (_event, ctx) => {
    restoreState(ctx)
  })
  pi.on('session_branch', (_event, ctx) => {
    // The host replaces conversation messages after this event.
    restoreState(ctx, false)
  })
  pi.on('before_agent_start', (_event, ctx) => {
    syncContext(ctx)
  })
  pi.on('session_tree', (_event, ctx) => {
    restoreState(ctx)
  })
  pi.on('session_compact', (_event, ctx) => {
    syncContext(ctx)
  })
}
