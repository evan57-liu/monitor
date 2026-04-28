// src/protocols/aerodrome/monitors/position.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PositionMonitor } from './position.js'
import type { DeBankClient } from '../../../core/clients/debank.js'

const mockDeBank = { getUserProtocolPosition: vi.fn() } as unknown as DeBankClient

describe('PositionMonitor', () => {
  it('tracks previous value across calls', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition)
      .mockResolvedValueOnce({ netUsdValue: 18000, assetUsdValue: 18000, debtUsdValue: 0, rewardUsdValue: 0, supplyTokenPrices: {}, fetchedAt: new Date() })
      .mockResolvedValueOnce({ netUsdValue: 17500, assetUsdValue: 17500, debtUsdValue: 0, rewardUsdValue: 0, supplyTokenPrices: {}, fetchedAt: new Date() })
    const m = new PositionMonitor({ walletAddress: '0xuser', protocolId: 'base_aerodrome3', poolId: '0xgauge', msUsdAddress: '0x526728dbc96689597f85ae4cd716d4f7fccbae9d' }, mockDeBank)
    const s1 = await m.check()
    expect(s1?.previousNetUsdValue).toBeNull()
    const s2 = await m.check()
    expect(s2?.previousNetUsdValue).toBe(18000)
    expect(s2?.netUsdValue).toBe(17500)
  })

  it('returns null when DeBank fails', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition).mockRejectedValue(new Error('fail'))
    const m = new PositionMonitor({ walletAddress: '0xuser', protocolId: 'base_aerodrome3', poolId: '0xgauge', msUsdAddress: '0x526728dbc96689597f85ae4cd716d4f7fccbae9d' }, mockDeBank)
    expect(await m.check()).toBeNull()
  })

  it('populates debankMsUsdPrice from supply token map', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition).mockResolvedValueOnce({
      netUsdValue: 18810.23, assetUsdValue: 18810.23, debtUsdValue: 0,
      rewardUsdValue: 305.67,
      supplyTokenPrices: {
        '0x526728dbc96689597f85ae4cd716d4f7fccbae9d': 0.9964,
        '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 1.0,
      },
      fetchedAt: new Date(),
    })
    const m = new PositionMonitor(
      { walletAddress: '0xuser', protocolId: 'base_aerodrome3', poolId: '0xgauge', msUsdAddress: '0x526728dbc96689597f85ae4cd716d4f7fccbae9d' },
      mockDeBank,
    )
    const s = await m.check()
    expect(s?.debankMsUsdPrice).toBeCloseTo(0.9964)
    expect(s?.rewardUsdValue).toBeCloseTo(305.67)
  })

  it('sets debankMsUsdPrice to null when msUSD address not in supply tokens', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition).mockResolvedValueOnce({
      netUsdValue: 0, assetUsdValue: 0, debtUsdValue: 0,
      rewardUsdValue: 0, supplyTokenPrices: {},
      fetchedAt: new Date(),
    })
    const m = new PositionMonitor(
      { walletAddress: '0xuser', protocolId: 'base_aerodrome3', poolId: '0xgauge', msUsdAddress: '0x526728dbc96689597f85ae4cd716d4f7fccbae9d' },
      mockDeBank,
    )
    const s = await m.check()
    expect(s?.debankMsUsdPrice).toBeNull()
  })
})
