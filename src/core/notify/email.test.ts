import { describe, it, expect, vi } from 'vitest'
import { EmailChannel } from './email.js'
import { AlertLevel } from '../types.js'

// Mock nodemailer
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-id' }),
      verify: vi.fn().mockResolvedValue(true),
      close: vi.fn(),
    })),
  },
}))

describe('EmailChannel', () => {
  const cfg = {
    smtpHost: 'smtp.gmail.com', smtpPort: 587,
    user: 'test@gmail.com', password: 'pass',
    from: 'test@gmail.com', to: ['dest@example.com'],
    retryAttempts: 1,
  }

  it('sends email and returns true', async () => {
    const channel = new EmailChannel(cfg)
    const ok = await channel.send({ title: 'Alert', body: '**content**', level: AlertLevel.RED })
    expect(ok).toBe(true)
  })

  it('converts markdown body to HTML for email', async () => {
    const nodemailer = await import('nodemailer')
    const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'x' })
    vi.mocked(nodemailer.default.createTransport).mockReturnValue({ sendMail: sendMailMock, verify: vi.fn(), close: vi.fn() } as never)

    const channel = new EmailChannel(cfg)
    await channel.send({ title: 'Test', body: '**bold text**', level: AlertLevel.WARNING })

    const callArg = sendMailMock.mock.calls[0]?.[0] as { html?: string; text?: string }
    expect(callArg?.html ?? callArg?.text ?? '').toContain('bold text')
  })

  it('returns false on SMTP error without throwing', async () => {
    const nodemailer = await import('nodemailer')
    vi.mocked(nodemailer.default.createTransport).mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error('smtp fail')),
      verify: vi.fn(),
      close: vi.fn(),
    } as never)
    const channel = new EmailChannel(cfg)
    const ok = await channel.send({ title: 'Test', body: 'body', level: AlertLevel.RED })
    expect(ok).toBe(false)
  })
})
