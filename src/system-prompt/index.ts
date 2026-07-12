import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const EXTENSION_DIR = import.meta.dirname

export default function systemPromptExtension(pi: ExtensionAPI): void {
  pi.setLabel('System Prompt Prefix/Suffix')

  pi.on('before_agent_start', async (event) => {
    const [prefix, suffix] = await Promise.all([
      readOptionalMarkdown('system_prefix.md'),
      readOptionalMarkdown('system_suffix.md'),
    ])

    if (prefix === undefined && suffix === undefined) {
      return
    }

    const systemPrompt = [...event.systemPrompt]
    if (prefix !== undefined) {
      systemPrompt.unshift(prefix)
    }
    if (suffix !== undefined) {
      systemPrompt.push(suffix)
    }

    return { systemPrompt }
  })
}

async function readOptionalMarkdown(
  filename: 'system_prefix.md' | 'system_suffix.md',
): Promise<string | undefined> {
  const filePath = path.join(EXTENSION_DIR, filename)
  try {
    const text = await readFile(filePath, 'utf8')
    const trimmed = text.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return undefined
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
