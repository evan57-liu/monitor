import nodemailer from 'nodemailer'
import { SocksClient } from 'socks'
import { getLogger } from '../logger.js'
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

interface SocksProxy {
  host: string
  port: number
}

export class EmailChannel implements NotificationChannel {
  readonly name = 'email'
  private readonly proxy: SocksProxy | null

  constructor(private readonly cfg: EmailConfig) {
    this.proxy = parseSocksProxy(process.env['ALL_PROXY'] ?? process.env['all_proxy'])
  }

  private async createTransporter(): Promise<{ transporter: ReturnType<typeof nodemailer.createTransport>; close: () => void }> {
    const baseOpts = {
      host: this.cfg.smtpHost,
      port: this.cfg.smtpPort,
      // port 465 → implicit TLS; port 587 → STARTTLS
      secure: this.cfg.smtpPort === 465,
      requireTLS: true,
      auth: { user: this.cfg.user, pass: this.cfg.password },
      connectionTimeout: 15_000,
      socketTimeout: 15_000,
    }

    if (!this.proxy) {
      const transporter = nodemailer.createTransport(baseOpts)
      return { transporter, close: () => transporter.close() }
    }

    // Node.js 不读 all_proxy，手动通过 SOCKS5 建立 TCP 隧道
    const { socket } = await SocksClient.createConnection({
      proxy: { host: this.proxy.host, port: this.proxy.port, type: 5 },
      command: 'connect',
      destination: { host: this.cfg.smtpHost, port: this.cfg.smtpPort },
    })

    getLogger().debug(
      { proxy: `socks5://${this.proxy.host}:${this.proxy.port}` },
      'SMTP via SOCKS5 proxy',
    )
    // 用 connection（已建立的连接）而非 socket（未连接的 socket）
    // nodemailer 的 socket 选项会再次调用 socket.connect() 导致 EISCONN
    const transporter = nodemailer.createTransport({ ...baseOpts, connection: socket })
    return { transporter, close: () => { transporter.close(); socket.destroy() } }
  }

  async send(notification: Notification): Promise<boolean> {
    const { transporter, close } = await this.createTransporter()
    try {
      for (let attempt = 1; attempt <= this.cfg.retryAttempts; attempt++) {
        try {
          await transporter.sendMail({
            from: this.cfg.from,
            to: this.cfg.to.join(', '),
            subject: notification.title,
            text: notification.body,
            html: markdownToHtml(notification.body),
          })
          return true
        } catch (err) {
          getLogger().error({ err, attempt, retryAttempts: this.cfg.retryAttempts }, 'Email send failed')
          if (attempt === this.cfg.retryAttempts) return false
          await sleep(attempt * 2000)
        }
      }
      return false
    } finally {
      close()
    }
  }

  async test(): Promise<boolean> {
    let close: (() => void) | undefined
    try {
      const created = await this.createTransporter()
      close = created.close
      await created.transporter.verify()
      return true
    } catch (err) {
      getLogger().error({ err }, 'Email channel test (SMTP verify) failed')
      return false
    } finally {
      close?.()
    }
  }
}

function parseSocksProxy(proxyUrl: string | undefined): SocksProxy | null {
  if (!proxyUrl?.startsWith('socks5://')) return null
  try {
    const url = new URL(proxyUrl)
    return { host: url.hostname, port: Number(url.port) }
  } catch {
    return null
  }
}

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
