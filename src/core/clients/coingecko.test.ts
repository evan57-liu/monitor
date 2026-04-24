// src/core/clients/coingecko.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoinGeckoClient } from './coingecko.js'

const BASE_URL = 'https://pro-api.coingecko.com/api/v3'
const API_KEY = 'test-key'

// Mock global fetch
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function makeTokenResponse(price: number) {
  return {
    data: {
      attributes: {
        price_usd: price.toString(),
        price_change_percentage: { h24: '-0.5' },
      },
    },
  }
}

function makePoolResponse(opts: { reserve0: string; reserve1: string; buys1h: number; sells1h: number }) {
  return {
    data: {
      attributes: {
        reserve_in_usd: '2500000',
        base_token_price_usd: '1.001',
        volume_usd: { h24: '180000' },
        transactions: {
          h1: { buys: opts.buys1h, sells: opts.sells1h },
          h24: { buys: opts.buys1h * 8, sells: opts.sells1h * 8 },
        },
        reserve0: opts.reserve0,
        reserve1: opts.reserve1,
      },
    },
  }
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('CoinGeckoClient', () => {
  it('fetches token price', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeTokenResponse(0.9985),
    })
    const client = new CoinGeckoClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5000, retryAttempts: 1 })
    const result = await client.getTokenPrice('0xabc123')
    expect(result.priceUsd).toBeCloseTo(0.9985)
    expect(fetchMock).toHaveBeenCalledOnce()
    const url = fetchMock.mock.calls[0]?.[0] as string
    expect(url).toContain('/onchain/networks/base/tokens/0xabc123')
  })

  it('returns cached result within TTL', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeTokenResponse(1.0) })
    const client = new CoinGeckoClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5000, retryAttempts: 1 })
    await client.getTokenPrice('0xabc123')
    await client.getTokenPrice('0xabc123') // should use cache
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('fetches pool data', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makePoolResponse({ reserve0: '1250000000000000000000000', reserve1: '1250000000', buys1h: 40, sells1h: 10 }),
    })
    const client = new CoinGeckoClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5000, retryAttempts: 1 })
    const pool = await client.getPoolData('0xpool123')
    expect(pool.buys1h).toBe(40)
    expect(pool.sells1h).toBe(10)
  })

  it('throws on non-200 response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
    const client = new CoinGeckoClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5000, retryAttempts: 1 })
    await expect(client.getTokenPrice('0xabc')).rejects.toThrow('CoinGecko API error: 429')
  })
})
