import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'

const DISABLED_TOOLS = new Set(['generate_image', 'ast_edit'])

export default function hideUnusedTools(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, _context) => {
    const active = pi.getActiveTools()
    const filtered = active.filter((t) => !DISABLED_TOOLS.has(t))
    if (filtered.length !== active.length) {
      await pi.setActiveTools(filtered)
    }
  })
}
