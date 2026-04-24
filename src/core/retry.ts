// src/core/retry.ts

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < opts.maxAttempts) {
        const base = opts.baseDelayMs * 2 ** (attempt - 1)
        const delay = Math.min(base, opts.maxDelayMs)
        const jitter = delay * 0.1 * Math.random()
        await sleep(delay + jitter)
      }
    }
  }
  throw lastErr
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
