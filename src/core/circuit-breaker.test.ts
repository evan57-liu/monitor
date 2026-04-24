// src/core/circuit-breaker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js'

describe('CircuitBreaker', () => {
  it('passes through successful calls', async () => {
    const cb = new CircuitBreaker({ maxFailures: 3, resetTimeMs: 60_000, name: 'test' })
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await cb.call(fn)).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('propagates errors when closed', async () => {
    const cb = new CircuitBreaker({ maxFailures: 3, resetTimeMs: 60_000, name: 'test' })
    const fn = vi.fn().mockRejectedValue(new Error('api fail'))
    await expect(cb.call(fn)).rejects.toThrow('api fail')
  })

  it('opens after maxFailures consecutive failures', async () => {
    const cb = new CircuitBreaker({ maxFailures: 3, resetTimeMs: 60_000, name: 'test' })
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fn)).rejects.toThrow('fail')
    }
    // Now open — fn is NOT called again
    await expect(cb.call(fn)).rejects.toThrow(CircuitOpenError)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('resets to half-open after resetTime and succeeds', async () => {
    const cb = new CircuitBreaker({ maxFailures: 2, resetTimeMs: 50, name: 'test' })
    const failFn = vi.fn().mockRejectedValue(new Error('fail'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.call(failFn)).rejects.toThrow('fail')
    }
    await new Promise(r => setTimeout(r, 60))
    const okFn = vi.fn().mockResolvedValue('recovered')
    expect(await cb.call(okFn)).toBe('recovered')
    // Back to closed — next call goes through again
    await expect(cb.call(okFn)).resolves.toBe('recovered')
  })

  it('goes back to open if half-open probe fails', async () => {
    const cb = new CircuitBreaker({ maxFailures: 2, resetTimeMs: 50, name: 'test' })
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.call(fn)).rejects.toThrow('fail')
    }
    await new Promise(r => setTimeout(r, 60))
    await expect(cb.call(fn)).rejects.toThrow('fail') // half-open probe fails
    // Back to open
    await expect(cb.call(fn)).rejects.toThrow(CircuitOpenError)
  })

  it('exposes isOpen getter', async () => {
    const cb = new CircuitBreaker({ maxFailures: 1, resetTimeMs: 60_000, name: 'test' })
    expect(cb.isOpen).toBe(false)
    await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(cb.isOpen).toBe(true)
  })
})
