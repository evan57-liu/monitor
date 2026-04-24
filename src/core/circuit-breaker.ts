// src/core/circuit-breaker.ts

export interface CircuitBreakerConfig {
  maxFailures: number
  resetTimeMs: number
  name: string
}

type State = 'closed' | 'open' | 'half-open'

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit ${name} is open`)
    this.name = 'CircuitOpenError'
  }
}

export class CircuitBreaker {
  private failures = 0
  private lastFailureAt = 0
  private state: State = 'closed'

  constructor(private readonly cfg: CircuitBreakerConfig) {}

  get isOpen(): boolean {
    return this.state === 'open'
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.cfg.resetTimeMs) {
        this.state = 'half-open'
      } else {
        throw new CircuitOpenError(this.cfg.name)
      }
    }

    try {
      const result = await fn()
      if (this.state === 'half-open') this.reset()
      return result
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  private onFailure(): void {
    this.failures++
    this.lastFailureAt = Date.now()
    if (this.state === 'half-open' || this.failures >= this.cfg.maxFailures) {
      this.state = 'open'
    }
  }

  private reset(): void {
    this.failures = 0
    this.lastFailureAt = 0
    this.state = 'closed'
  }
}
