// src/protocols/aerodrome/monitors/market.test.ts
import { describe, it, expect, vi } from 'vitest'
import { MarketMonitor } from './market.js'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type pino from 'pino'

const mockCoinGecko = { getPoolData: vi.fn() } as unknown as CoinGeckoClient
const mockRpc = {
  getTwapPrice: vi.fn(),
  getTokenBalance: vi.fn(),
} as unknown as RpcClient
const mockLogger = { warn: vi.fn(), debug: vi.fn() } as unknown as pino.Logger

const cfg = {
  poolAddress:    '0x0000000000000000000000000000000000000001' as `0x${string}`,
  msUsdAddress:   '0x0000000000000000000000000000000000000002' as `0x${string}`,
  usdcAddress:    '0x0000000000000000000000000000000000000003' as `0x${string}`,
  token0Decimals: 18,
  token1Decimals: 6,
}

const makePoolData = (baseTokenPriceUsd: number) => ({
  baseTokenPriceUsd,
  reserveInUsd: 2_500_000,
  quotePriceUsd: 1.0,
  volume24h: 180_000,
  buys1h: 40,
  sells1h: 60,
  buys24h: 320,
  sells24h: 480,
  fetchedAt: new Date(),
})

describe('MarketMonitor', () => {
  it('returns price and pool signals when all sources succeed', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockResolvedValue(makePoolData(0.999))
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.9982)
    vi.mocked(mockRpc.getTokenBalance)
      .mockResolvedValueOnce(1_260_000n * 10n ** 18n)  // msUSD
      .mockResolvedValueOnce(1_258_700n * 10n ** 6n)   // USDC

    const signal = await new MarketMonitor(cfg, mockCoinGecko, mockRpc, mockLogger).check()

    expect(signal.price.coingecko).toBeCloseTo(0.999)
    expect(signal.price.twap).toBeCloseTo(0.9982)
    expect(signal.pool?.msUsdRatio).toBeGreaterThan(0.49)
    expect(signal.pool?.msUsdRatio).toBeLessThan(0.55)
    expect(signal.pool?.poolPriceUsd).toBeCloseTo(0.999)
    expect(signal.pool?.buys1h).toBe(40)
    expect(signal.pool?.sells1h).toBe(60)
  })

  it('returns null coingecko and null pool when CoinGecko fails, twap still works', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockRejectedValue(new Error('api down'))
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.9982)
    vi.mocked(mockRpc.getTokenBalance).mockResolvedValue(0n)

    const signal = await new MarketMonitor(cfg, mockCoinGecko, mockRpc, mockLogger).check()

    expect(signal.price.coingecko).toBeNull()
    expect(signal.price.twap).toBeCloseTo(0.9982)
    expect(signal.pool).toBeNull()
  })

  it('returns price signal but null pool when RPC balance calls fail', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockResolvedValue(makePoolData(0.999))
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.999)
    vi.mocked(mockRpc.getTokenBalance).mockRejectedValue(new Error('rpc down'))

    const signal = await new MarketMonitor(cfg, mockCoinGecko, mockRpc, mockLogger).check()

    expect(signal.price.coingecko).toBeCloseTo(0.999)
    expect(signal.pool).toBeNull()
  })

  it('returns fully null signals when all sources fail', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockRejectedValue(new Error('fail'))
    vi.mocked(mockRpc.getTwapPrice).mockRejectedValue(new Error('fail'))
    vi.mocked(mockRpc.getTokenBalance).mockRejectedValue(new Error('fail'))

    const signal = await new MarketMonitor(cfg, mockCoinGecko, mockRpc, mockLogger).check()

    expect(signal.price.coingecko).toBeNull()
    expect(signal.price.twap).toBeNull()
    expect(signal.pool).toBeNull()
  })
})
