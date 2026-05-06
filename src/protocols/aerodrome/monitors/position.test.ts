// src/protocols/aerodrome/monitors/position.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PositionMonitor } from './position.js'
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { HistoryStore } from '../history-store.js'

const mockDeBank = { getUserProtocolPosition: vi.fn() } as unknown as DeBankClient

function makeHistoryStore(): HistoryStore {
  return {
    insertSupply: vi.fn(),
    getSupplyAtOrBefore: vi.fn().mockReturnValue(null),
    insertProtocolTvl: vi.fn(),
    getProtocolTvlAtOrBefore: vi.fn().mockReturnValue(null),
    insertPosition: vi.fn(),
    getPositionAtOrBefore: vi.fn().mockReturnValue(null),
  }
}

const baseCfg = { walletAddress: '0xuser', protocolId: 'base_aerodrome3', poolId: '0xgauge', msUsdAddress: '0x526728dbc96689597f85ae4cd716d4f7fccbae9d', monitorId: 'aerodrome-msusd-usdc' }

describe('PositionMonitor', () => {
  it('writes netUsdValue to history store on each call', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition)
      .mockResolvedValueOnce({ netUsdValue: 18000, assetUsdValue: 18000, debtUsdValue: 0, rewardUsdValue: 0, supplyTokenPrices: {}, fetchedAt: new Date() })
      .mockResolvedValueOnce({ netUsdValue: 17500, assetUsdValue: 17500, debtUsdValue: 0, rewardUsdValue: 0, supplyTokenPrices: {}, fetchedAt: new Date() })
    const store = makeHistoryStore()
    const m = new PositionMonitor(baseCfg, mockDeBank, store)
    const s1 = await m.check()
    expect(s1?.netUsdValue).toBe(18000)
    expect(store.insertPosition).toHaveBeenCalledWith('aerodrome-msusd-usdc', '0xuser', 18000, expect.any(Date))

    const s2 = await m.check()
    expect(s2?.netUsdValue).toBe(17500)
    expect(store.insertPosition).toHaveBeenCalledTimes(2)
  })

  it('returns null when DeBank fails', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition).mockRejectedValue(new Error('fail'))
    const m = new PositionMonitor(baseCfg, mockDeBank, makeHistoryStore())
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
    const m = new PositionMonitor(baseCfg, mockDeBank, makeHistoryStore())
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
    const m = new PositionMonitor(baseCfg, mockDeBank, makeHistoryStore())
    const s = await m.check()
    expect(s?.debankMsUsdPrice).toBeNull()
  })
})
