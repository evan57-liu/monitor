import type { NotificationChannel, Notification } from '../types.js'

interface ServerChanConfig {
  sendkey: string
  timeoutMs: number
  retryAttempts: number
}

export class ServerChanChannel implements NotificationChannel {
  readonly name = 'serverchan'

  constructor(private readonly cfg: ServerChanConfig) {}

  async send(notification: Notification): Promise<boolean> {
    try {
      for (let attempt = 1; attempt <= this.cfg.retryAttempts; attempt++) {
        const ok = await this.doSend(notification)
        if (ok) return true
        if (attempt < this.cfg.retryAttempts) await sleep(attempt * 1000)
      }
      return false
    } catch {
      return false
    }
  }

  async test(): Promise<boolean> {
    return this.send({ title: '✅ Monitor online', body: 'DeFi monitor started successfully', level: 'info' as never })
  }

  private async doSend(notification: Notification): Promise<boolean> {
    const url = `https://sctapi.ftqq.com/${this.cfg.sendkey}.send`
    const body = new URLSearchParams({
      title: notification.title,
      desp: notification.body,
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
    try {
      const res = await globalThis.fetch(url, {
        method: 'POST',
        body,
        signal: controller.signal,
      })
      return res.ok
    } finally {
      clearTimeout(timeout)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
