import nodemailer from 'nodemailer'
import { SocksClient } from 'socks'
import { getLogger } from '../logger.js'
import { AlertLevel } from '../types.js'
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
            html: buildHtmlEmail(notification),
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

function buildHtmlEmail(notification: Notification): string {
  const isRed = notification.level === AlertLevel.RED
  const isWarning = notification.level === AlertLevel.WARNING
  const headerBg = isRed ? '#dc2626' : isWarning ? '#d97706' : '#2563eb'
  const levelLabel = isRed ? '🔴 RED — 紧急' : isWarning ? '🟡 WARNING' : 'ℹ️ INFO'
  const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;padding:24px 16px}',
    '.wrap{max-width:600px;margin:0 auto}',
    '.card{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.12)}',
    `.hd{padding:18px 24px;color:#fff;background:${headerBg}}`,
    '.hd-badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.5px;padding:2px 9px;border:1px solid rgba(255,255,255,.55);border-radius:20px;margin-bottom:8px}',
    '.hd-title{font-size:16px;font-weight:600;line-height:1.4}',
    '.bd{padding:20px 24px;color:#374151;font-size:14px;line-height:1.75}',
    '.bd p{margin:3px 0}',
    '.bd strong{color:#111;font-weight:600}',
    '.bd hr{border:none;border-top:1px solid #e5e7eb;margin:18px 0}',
    '.bd pre{background:#1e1e2e;color:#cdd6f4;padding:14px 16px;border-radius:6px;font-size:12.5px;line-height:1.6;overflow-x:auto;margin:8px 0;white-space:pre-wrap;word-break:break-all}',
    '.bd code{background:#f1f5f9;color:#0f172a;padding:1px 5px;border-radius:3px;font-size:12.5px;font-family:"SF Mono",Consolas,monospace}',
    '.bd pre code{background:none;color:inherit;padding:0;font-size:inherit}',
    '.ft{padding:10px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center}',
    '</style>',
    '</head>',
    '<body><div class="wrap"><div class="card">',
    `<div class="hd"><div class="hd-badge">${levelLabel}</div><div class="hd-title">${escapeHtml(notification.title)}</div></div>`,
    `<div class="bd">${mdToHtml(notification.body)}</div>`,
    `<div class="ft">DeFi Monitor &nbsp;·&nbsp; ${escapeHtml(nowStr)} CST</div>`,
    '</div></div></body></html>',
  ].join('\n')
}

function mdToHtml(md: string): string {
  // 先拆出代码块，避免对其内容做 Markdown 处理
  const parts = md.split(/(```[\w]*\n[\s\S]*?```)/g)
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const m = part.match(/```[\w]*\n([\s\S]*?)```/)
      return `<pre><code>${escapeHtml(m?.[1] ?? '')}</code></pre>`
    }
    return part.split('\n').map(line => {
      if (line.trim() === '---') return '<hr>'
      if (line.trim() === '') return ''
      const html = escapeHtml(line.trim())
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
      return `<p>${html}</p>`
    }).join('')
  }).join('')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
