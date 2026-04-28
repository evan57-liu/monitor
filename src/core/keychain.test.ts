// src/core/keychain.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process')

import { readFromKeychain } from './keychain.js'
import { execSync } from 'node:child_process'

describe('readFromKeychain', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns trimmed value when item exists in Keychain', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(execSync).mockReturnValue('0xabc123\n' as any)
    const result = readFromKeychain('defi-monitor', 'private-key')
    expect(result).toBe('0xabc123')
    expect(execSync).toHaveBeenCalledWith(
      'security find-generic-password -s defi-monitor -a private-key -w',
      expect.objectContaining({ encoding: 'utf8' }),
    )
  })

  it('returns null when item not found in Keychain', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('exit 44: The specified item could not be found in the keychain.')
    })
    const result = readFromKeychain('defi-monitor', 'private-key')
    expect(result).toBeNull()
  })

  it('returns null on any execSync error', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('security: command not found')
    })
    const result = readFromKeychain('defi-monitor', 'private-key')
    expect(result).toBeNull()
  })

  it('returns null when Keychain returns empty string', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(execSync).mockReturnValue('   \n' as any)
    const result = readFromKeychain('defi-monitor', 'private-key')
    expect(result).toBeNull()
  })
})
