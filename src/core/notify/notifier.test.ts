import { describe, it, expect, vi } from 'vitest'
import { Notifier } from './notifier.js'
import { AlertLevel, AlertType } from '../types.js'
import type { NotificationChannel, Alert } from '../types.js'

function makeChannel(name: string, returns: boolean): NotificationChannel {
  return { name, send: vi.fn().mockResolvedValue(returns), test: vi.fn().mockResolvedValue(true) }
}

function makeAlert(level: AlertLevel): Alert {
  return {
    id: 'a1', type: AlertType.DEPEG, level, protocol: 'test', title: 'T', message: 'M',
    data: {}, triggeredAt: new Date(), confirmations: 1, requiredConfirmations: 1, sustainedMs: 0, requiredSustainedMs: 0,
  }
}

describe('Notifier', () => {
  it('sends to all channels for RED alert', async () => {
    const sc = makeChannel('serverchan', true)
    const email = makeChannel('email', true)
    const notifier = new Notifier([sc, email])

    await notifier.notifyAlert(makeAlert(AlertLevel.RED))

    expect(sc.send).toHaveBeenCalledOnce()
    expect(email.send).toHaveBeenCalledOnce()
  })

  it('sends only to primary channel for WARNING alert', async () => {
    const sc = makeChannel('serverchan', true)
    const email = makeChannel('email', true)
    const notifier = new Notifier([sc, email], { criticalChannels: ['serverchan', 'email'], normalChannels: ['serverchan'] })

    await notifier.notifyAlert(makeAlert(AlertLevel.WARNING))

    expect(sc.send).toHaveBeenCalledOnce()
    expect(email.send).not.toHaveBeenCalled()
  })

  it('does not throw if one channel fails', async () => {
    const sc = makeChannel('serverchan', false) // fails
    const email = makeChannel('email', true)
    const notifier = new Notifier([sc, email])

    await expect(notifier.notifyAlert(makeAlert(AlertLevel.RED))).resolves.not.toThrow()
    expect(email.send).toHaveBeenCalledOnce()
  })

  it('sendDailySummary sends to email channel only', async () => {
    const sc = makeChannel('serverchan', true)
    const email = makeChannel('email', true)
    const notifier = new Notifier([sc, email])

    await notifier.sendDailySummary('## Daily Report\n\nAll good.')

    expect(email.send).toHaveBeenCalledOnce()
    expect(sc.send).not.toHaveBeenCalled()
  })
})
