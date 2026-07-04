import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'

export default function hideUnusedTools(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, _context) => {
    const active = pi.getActiveTools()
    const filtered = active.filter((t) => t !== 'generate_image')
    if (filtered.length !== active.length) {
      await pi.setActiveTools(filtered)
    }
  })
}
