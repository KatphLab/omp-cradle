import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { runCommitCommand } from '@oh-my-pi/pi-coding-agent/commit'

export default function commit(pi: ExtensionAPI) {
  pi.registerCommand('commit', {
    description: 'Run omp commit on staged changes',
    handler: async (args, ctx) => {
      await runCommitCommand({
        push: args.includes('--push'),
        dryRun: args.includes('--dry-run'),
        noChangelog: args.includes('--no-changelog'),
      })
      ctx.ui.notify('Commit finished', 'info')
    },
  })
}
