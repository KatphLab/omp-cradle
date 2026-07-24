import type { NodeReuseDecision, RestartOverrides } from './state'

interface ParsedRestartOverrides {
  reuse: string[]
  rerun: string[]
  from?: string
}

export function parseRestartOverrides(
  arguments_: readonly string[],
): RestartOverrides {
  const parsed: ParsedRestartOverrides = { reuse: [], rerun: [] }
  for (let index = 0; index < arguments_.length; index += 2) {
    applyRestartOption(
      parsed,
      requireOptionPair(arguments_[index], arguments_[index + 1]),
    )
  }
  return {
    ...(parsed.reuse.length === 0 ? {} : { reuse: [...new Set(parsed.reuse)] }),
    ...(parsed.rerun.length === 0 ? {} : { rerun: [...new Set(parsed.rerun)] }),
    ...(parsed.from === undefined ? {} : { from: parsed.from }),
  }
}

function requireOptionPair(
  option: string | undefined,
  value: string | undefined,
): readonly [string, string] {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Restart option '${option ?? ''}' requires a value`)
  }
  return [option ?? '', value]
}

function applyRestartOption(
  parsed: ParsedRestartOverrides,
  [option, value]: readonly [string, string],
): void {
  if (option === '--reuse' || option === '--rerun') {
    const names = value
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    if (names.length === 0) {
      throw new Error(`Restart option '${option}' requires at least one node`)
    }
    const target = option === '--reuse' ? parsed.reuse : parsed.rerun
    target.push(...names)
    return
  }
  if (option === '--from') {
    if (parsed.from !== undefined) {
      throw new Error("Restart option '--from' may only be specified once")
    }
    parsed.from = value
    return
  }
  throw new Error(`Unknown restart option '${option}'`)
}

export function formatRestartDecision(decision: NodeReuseDecision): string {
  switch (decision.action) {
    case 'reuse': {
      const warningSuffix =
        decision.warnings.length === 0
          ? ''
          : `; ${decision.warnings.join('; ')}`
      return `reuse (${decision.basis})${warningSuffix}`
    }
    case 'rerun': {
      return `rerun (${decision.reason})`
    }
    case 'migrate': {
      return `reuse (state ${decision.fromStateVersion}->${decision.toStateVersion})`
    }
  }
}
