import { AlertLevel } from '../types.js'
import type { Alert, NotificationChannel, Notification } from '../types.js'

interface NotifierOptions {
  criticalChannels?: string[]   // 用于 RED 级别告警的渠道名称列表
  normalChannels?: string[]     // 用于 WARNING 级别告警的渠道名称列表
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
    // 每日摘要仅发送至 email 渠道
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
    // 有意忽略单个渠道的失败——每个渠道自行处理重试逻辑。
    // 若全部失败，告警仍会记录在 SQLite 中。
  }
}
