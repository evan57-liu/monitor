// src/protocols/aerodrome/monitors/pool.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PoolMonitor } from './pool.js'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type pino from 'pino'

const mockCoinGecko = { getPoolData: vi.fn() } as unknown as CoinGeckoClient
const mockRpc = { getTokenBalance: vi.fn() } as unknown as RpcClient
const mockLogger = { warn: vi.fn(), debug: vi.fn() } as unknown as pino.Logger

const cfg = {
  poolAddress: '0x0000000000000000000000000000000000000001' as `0x${string}`,
  msUsdAddress: '0x0000000000000000000000000000000000000002' as `0x${string}`,
  usdcAddress: '0x0000000000000000000000000000000000000003' as `0x${string}`,
}

describe('PoolMonitor', () => {
  it('computes msUsdRatio from RPC token balances', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockResolvedValue({
      reserveInUsd: 2_500_000, baseTokenPriceUsd: 0.999, quotePriceUsd: 1.0001,
      volume24h: 180_000, buys1h: 40, sells1h: 60,
      buys24h: 320, sells24h: 480,
      fetchedAt: new Date(),
    })
    // 1.26M msUSD (18 decimals), 1.2587M USDC (6 decimals)
    vi.mocked(mockRpc.getTokenBalance)
      .mockResolvedValueOnce(1_260_000n * 10n ** 18n)  // msUSD
      .mockResolvedValueOnce(1_258_700n * 10n ** 6n)   // USDC

    const monitor = new PoolMonitor(cfg, mockCoinGecko, mockRpc, mockLogger)
    const signal = await monitor.check()
    expect(signal?.msUsdRatio).toBeGreaterThan(0.49)
    expect(signal?.msUsdRatio).toBeLessThan(0.55)
    expect(signal?.poolPriceUsd).toBeCloseTo(0.999)
    expect(signal?.buys1h).toBe(40)
    expect(signal?.sells1h).toBe(60)
  })

  it('returns null when any source fails', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockRejectedValue(new Error('fail'))
    const monitor = new PoolMonitor(cfg, mockCoinGecko, mockRpc, mockLogger)
    expect(await monitor.check()).toBeNull()
  })
})
