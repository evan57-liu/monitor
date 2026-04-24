import type pino from 'pino'

export class HealthchecksMonitor {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly pingUrl: string,
    private readonly intervalSeconds: number,
    private readonly logger: pino.Logger,
  ) {}

  start(): void {
    if (this.timer) return
    // Ping immediately on start
    void this.ping()
    this.timer = setInterval(() => void this.ping(), this.intervalSeconds * 1000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Call this when something is wrong to signal failure to Healthchecks */
  async fail(reason: string): Promise<void> {
    try {
      await globalThis.fetch(`${this.pingUrl}/fail`, {
        method: 'POST',
        body: reason.slice(0, 10_000),
      })
    } catch (err) {
      this.logger.warn({ err }, 'Failed to send Healthchecks failure ping')
    }
  }

  private async ping(): Promise<void> {
    try {
      const res = await globalThis.fetch(this.pingUrl)
      if (!res.ok) this.logger.warn({ status: res.status }, 'Healthchecks ping returned non-200')
    } catch (err) {
      this.logger.warn({ err }, 'Healthchecks ping failed (network error)')
    }
  }
}
