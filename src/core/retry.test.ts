// src/core/retry.test.ts
import { describe, it, expect, vi } from 'vitest'
import { withRetry } from './retry.js'

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 })).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('retries and succeeds on 3rd attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok')
    expect(await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws after all attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 })
    ).rejects.toThrow('always fail')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
