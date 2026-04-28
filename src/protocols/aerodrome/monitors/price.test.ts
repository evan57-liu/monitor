// src/protocols/aerodrome/monitors/price.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PriceMonitor } from './price.js'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type pino from 'pino'

const mockCoinGecko = {
  getTokenPrice: vi.fn(),
} as unknown as CoinGeckoClient

const mockRpc = {
  getTwapPrice: vi.fn(),
} as unknown as RpcClient

const mockLogger = { warn: vi.fn(), debug: vi.fn() } as unknown as pino.Logger

const cfg = {
  msUsdAddress: '0x0000000000000000000000000000000000000001' as `0x${string}`,
  poolAddress: '0x0000000000000000000000000000000000000002' as `0x${string}`,
}

describe('PriceMonitor', () => {
  it('returns coingecko price as primary', async () => {
    vi.mocked(mockCoinGecko.getTokenPrice).mockResolvedValue({
      priceUsd: 0.9985, fetchedAt: new Date(),
    })
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.999)

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc, mockLogger)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeCloseTo(0.9985)
    expect(signal.twap).toBeCloseTo(0.999)
  })

  it('returns null coingecko when CoinGecko fails, twap still works', async () => {
    vi.mocked(mockCoinGecko.getTokenPrice).mockRejectedValue(new Error('api down'))
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.9982)

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc, mockLogger)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeNull()
    expect(signal.twap).toBeCloseTo(0.9982)
  })

  it('returns fully null signal when both fail', async () => {
    vi.mocked(mockCoinGecko.getTokenPrice).mockRejectedValue(new Error('fail'))
    vi.mocked(mockRpc.getTwapPrice).mockRejectedValue(new Error('fail'))

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc, mockLogger)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeNull()
    expect(signal.twap).toBeNull()
  })
})
