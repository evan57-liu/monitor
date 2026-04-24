// src/core/clients/debank.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeBankClient } from './debank.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => fetchMock.mockReset())

function okJson(data: unknown) {
  return { ok: true, json: async () => data }
}

describe('DeBankClient', () => {
  let client: DeBankClient
  beforeEach(() => {
    client = new DeBankClient({
      baseUrl: 'https://pro-openapi.debank.com/v1',
      accessKey: 'test-key',
      timeoutMs: 5000,
      retryAttempts: 1,
    })
  })

  it('fetches user position for a protocol', async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      portfolio_item_list: [
        { stats: { net_usd_value: 18650.5, asset_usd_value: 18650.5, debt_usd_value: 0 } },
      ],
    }))
    const pos = await client.getUserProtocolPosition('0xwallet', 'aerodrome')
    expect(pos.netUsdValue).toBeCloseTo(18650.5)
  })

  it('returns zero value when no position found', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ portfolio_item_list: [] }))
    const pos = await client.getUserProtocolPosition('0xwallet', 'aerodrome')
    expect(pos.netUsdValue).toBe(0)
  })

  it('fetches protocol TVL', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ tvl: 55_000_000, user_count: 1200 }))
    const tvl = await client.getProtocolTvl('metronome-synth')
    expect(tvl.tvlUsd).toBe(55_000_000)
  })

  it('fetches wallet token list', async () => {
    fetchMock.mockResolvedValueOnce(okJson([
      { id: 'msusd', symbol: 'msUSD', amount: 50000, price: 0.999, chain: 'base' },
    ]))
    const tokens = await client.getWalletTokens('0xteam', 'base')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.symbol).toBe('msUSD')
    expect(tokens[0]?.usdValue).toBeCloseTo(49950)
  })

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
    await expect(client.getProtocolTvl('x')).rejects.toThrow('DeBank API error: 401')
  })
})
