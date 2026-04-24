import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ServerChanChannel } from './serverchan.js'
import { AlertLevel } from '../types.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => fetchMock.mockReset())

describe('ServerChanChannel', () => {
  const channel = new ServerChanChannel({ sendkey: 'SCTtest', timeoutMs: 3000, retryAttempts: 1 })

  it('sends notification and returns true on success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0 }) })
    const ok = await channel.send({ title: 'Test', body: '**hello**', level: AlertLevel.WARNING })
    expect(ok).toBe(true)
    const url = fetchMock.mock.calls[0]?.[0] as string
    expect(url).toContain('SCTtest')
  })

  it('returns false on HTTP failure without throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    const ok = await channel.send({ title: 'Test', body: 'body', level: AlertLevel.RED })
    expect(ok).toBe(false)
  })

  it('returns false on network error without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network fail'))
    const ok = await channel.send({ title: 'Test', body: 'body', level: AlertLevel.RED })
    expect(ok).toBe(false)
  })

  it('test() returns true when API responds ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0 }) })
    expect(await channel.test()).toBe(true)
  })
})
