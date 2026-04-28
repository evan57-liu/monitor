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

  it('filters items by poolId (case-insensitive) and parses reward + supply prices', async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      portfolio_item_list: [
        {
          pool: { id: '0x3d86aed6ecc8daf71c8b50d06f38455b663265d8' },
          stats: { net_usd_value: 18810.23, asset_usd_value: 18810.23, debt_usd_value: 0 },
          detail: {
            supply_token_list: [
              { id: '0x526728dbc96689597f85ae4cd716d4f7fccbae9d', price: 0.9964 },
              { id: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', price: 1.0 },
            ],
            reward_token_list: [{ amount: 639.76, price: 0.4779 }],
          },
        },
        {
          pool: { id: '0x4f665e05d23a5ab1d1a581e8040b585fb4d0453d' },
          stats: { net_usd_value: 6576.77, asset_usd_value: 6576.77, debt_usd_value: 0 },
          detail: { supply_token_list: [], reward_token_list: [] },
        },
      ],
    }))
    // poolId 大写 → 应匹配 response 中的小写 pool.id
    const pos = await client.getUserProtocolPosition(
      '0xwallet', 'base_aerodrome3', '0x3D86AED6ECC8DAF71C8B50D06F38455B663265D8',
    )
    expect(pos.netUsdValue).toBeCloseTo(18810.23)
    expect(pos.rewardUsdValue).toBeCloseTo(639.76 * 0.4779)
    expect(pos.supplyTokenPrices['0x526728dbc96689597f85ae4cd716d4f7fccbae9d']).toBeCloseTo(0.9964)
    expect(pos.supplyTokenPrices['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']).toBeCloseTo(1.0)
  })

  it('returns zero reward and empty supplyTokenPrices when detail is absent', async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      portfolio_item_list: [
        { stats: { net_usd_value: 100, asset_usd_value: 100, debt_usd_value: 0 } },
      ],
    }))
    const pos = await client.getUserProtocolPosition('0xwallet', 'aerodrome')
    expect(pos.rewardUsdValue).toBe(0)
    expect(pos.supplyTokenPrices).toEqual({})
  })

  it('returns zero netUsdValue when no item matches poolId', async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      portfolio_item_list: [
        {
          pool: { id: '0xother' },
          stats: { net_usd_value: 5000, asset_usd_value: 5000, debt_usd_value: 0 },
          detail: { supply_token_list: [], reward_token_list: [] },
        },
      ],
    }))
    const pos = await client.getUserProtocolPosition('0xwallet', 'base_aerodrome3', '0xgauge')
    expect(pos.netUsdValue).toBe(0)
  })
})
