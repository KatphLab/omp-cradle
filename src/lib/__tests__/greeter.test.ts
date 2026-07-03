import { buildFarewell, buildGreeting } from '@lib/greeter.js'
import { describe, expect, it } from 'vitest'

describe('buildGreeting', () => {
  it('returns default greeting', () => {
    const result = buildGreeting({ name: 'World' })
    expect(result).toBe('Hello, World!')
  })

  it('returns custom greeting', () => {
    const result = buildGreeting({ name: 'World', greeting: 'Hi' })
    expect(result).toBe('Hi, World!')
  })
})

describe('buildFarewell', () => {
  it('returns farewell', () => {
    const result = buildFarewell('World')
    expect(result).toBe('Goodbye, World!')
  })
})
