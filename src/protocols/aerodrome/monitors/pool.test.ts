// src/protocols/aerodrome/monitors/pool.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PoolMonitor } from './pool.js'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'

const mockCoinGecko = { getPoolData: vi.fn() } as unknown as CoinGeckoClient

const cfg = { poolAddress: '0x0000000000000000000000000000000000000001' }

describe('PoolMonitor', () => {
  it('computes msUsdRatio from buys/sells and reserve data', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockResolvedValue({
      reserveInUsd: 2_500_000, baseTokenPriceUsd: 0.999,
      volume24h: 180_000, buys1h: 40, sells1h: 60,
      buys24h: 320, sells24h: 480,
      reserve0Raw: '1260000000000000000000000', // 1.26M msUSD (18 decimals)
      reserve1Raw: '1258700000000',           // 1.2587M USDC (6 decimals)
      fetchedAt: new Date(),
    })
    const monitor = new PoolMonitor(cfg, mockCoinGecko)
    const signal = await monitor.check()
    expect(signal?.msUsdRatio).toBeGreaterThan(0.49)
    expect(signal?.msUsdRatio).toBeLessThan(0.55)
    expect(signal?.buys1h).toBe(40)
    expect(signal?.sells1h).toBe(60)
  })

  it('returns null when CoinGecko fails', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockRejectedValue(new Error('fail'))
    const monitor = new PoolMonitor(cfg, mockCoinGecko)
    expect(await monitor.check()).toBeNull()
  })
})
