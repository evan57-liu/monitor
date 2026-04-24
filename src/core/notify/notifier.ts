import { AlertLevel } from '../types.js'
import type { Alert, NotificationChannel, Notification } from '../types.js'

interface NotifierOptions {
  criticalChannels?: string[]   // channel names to use for RED alerts
  normalChannels?: string[]     // channel names to use for WARNING alerts
}

const DEFAULT_OPTS: Required<NotifierOptions> = {
  criticalChannels: ['serverchan', 'email'],
  normalChannels: ['serverchan'],
}

export class Notifier {
  private readonly opts: Required<NotifierOptions>

  constructor(
    private readonly channels: NotificationChannel[],
    opts: NotifierOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts }
  }

  async notifyAlert(alert: Alert): Promise<void> {
    const channelNames = alert.level === AlertLevel.RED
      ? this.opts.criticalChannels
      : this.opts.normalChannels

    const notification: Notification = {
      title: alert.title,
      body: alert.message,
      level: alert.level,
      metadata: { alertId: alert.id, type: alert.type, protocol: alert.protocol },
    }

    await this.sendToChannels(channelNames, notification)
  }

  async sendDailySummary(markdown: string): Promise<void> {
    const notification: Notification = {
      title: `📊 Daily Monitor Summary — ${new Date().toLocaleDateString()}`,
      body: markdown,
      level: AlertLevel.INFO,
    }
    // Daily summary goes to email only
    await this.sendToChannels(['email'], notification)
  }

  async testAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    await Promise.all(
      this.channels.map(async ch => {
        results[ch.name] = await ch.test()
      }),
    )
    return results
  }

  private async sendToChannels(names: string[], notification: Notification): Promise<void> {
    const targets = this.channels.filter(ch => names.includes(ch.name))
    await Promise.allSettled(targets.map(ch => ch.send(notification)))
    // We intentionally ignore individual failures — each channel handles its own retries.
    // If all fail, the alert is still logged in SQLite.
  }
}
