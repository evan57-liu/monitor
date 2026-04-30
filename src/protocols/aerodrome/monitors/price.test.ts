// src/protocols/aerodrome/monitors/price.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PriceMonitor } from './price.js'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type pino from 'pino'

const mockCoinGecko = {
  getPoolData: vi.fn(),
} as unknown as CoinGeckoClient

const mockRpc = {
  getTwapPrice: vi.fn(),
} as unknown as RpcClient

const mockLogger = { warn: vi.fn(), debug: vi.fn() } as unknown as pino.Logger

const cfg = {
  poolAddress: '0x0000000000000000000000000000000000000002' as `0x${string}`,
}

const makePoolData = (baseTokenPriceUsd: number) => ({
  baseTokenPriceUsd,
  reserveInUsd: 1_000_000,
  quotePriceUsd: 1.0,
  volume24h: 50_000,
  buys1h: 10,
  sells1h: 5,
  buys24h: 80,
  sells24h: 40,
  fetchedAt: new Date(),
})

describe('PriceMonitor', () => {
  it('returns coingecko price from pool data as primary', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockResolvedValue(makePoolData(0.9985))
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.999)

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc, mockLogger)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeCloseTo(0.9985)
    expect(signal.twap).toBeCloseTo(0.999)
  })

  it('returns null coingecko when CoinGecko fails, twap still works', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockRejectedValue(new Error('api down'))
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.9982)

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc, mockLogger)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeNull()
    expect(signal.twap).toBeCloseTo(0.9982)
  })

  it('returns fully null signal when both fail', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockRejectedValue(new Error('fail'))
    vi.mocked(mockRpc.getTwapPrice).mockRejectedValue(new Error('fail'))

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc, mockLogger)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeNull()
    expect(signal.twap).toBeNull()
  })
})
