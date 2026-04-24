import nodemailer from 'nodemailer'
import type { NotificationChannel, Notification } from '../types.js'

interface EmailConfig {
  smtpHost: string
  smtpPort: number
  user: string
  password: string
  from: string
  to: string[]
  retryAttempts: number
}

export class EmailChannel implements NotificationChannel {
  readonly name = 'email'
  private readonly transporter: ReturnType<typeof nodemailer.createTransport>

  constructor(private readonly cfg: EmailConfig) {
    this.transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: false,
      auth: { user: cfg.user, pass: cfg.password },
    })
  }

  async send(notification: Notification): Promise<boolean> {
    for (let attempt = 1; attempt <= this.cfg.retryAttempts; attempt++) {
      try {
        await this.transporter.sendMail({
          from: this.cfg.from,
          to: this.cfg.to.join(', '),
          subject: notification.title,
          text: notification.body,
          html: markdownToHtml(notification.body),
        })
        return true
      } catch {
        if (attempt === this.cfg.retryAttempts) return false
        await sleep(attempt * 2000)
      }
    }
    return false
  }

  async test(): Promise<boolean> {
    try {
      await this.transporter.verify()
      return true
    } catch {
      return false
    }
  }
}

/** Minimal markdown→HTML: bold, newlines, code blocks */
function markdownToHtml(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/\n/g, '<br>')
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
