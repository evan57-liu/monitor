// src/protocols/aerodrome/monitors/position.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PositionMonitor } from './position.js'
import type { DeBankClient } from '../../../core/clients/debank.js'

const mockDeBank = { getUserProtocolPosition: vi.fn() } as unknown as DeBankClient

describe('PositionMonitor', () => {
  it('tracks previous value across calls', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition)
      .mockResolvedValueOnce({ netUsdValue: 18000, assetUsdValue: 18000, debtUsdValue: 0, fetchedAt: new Date() })
      .mockResolvedValueOnce({ netUsdValue: 17500, assetUsdValue: 17500, debtUsdValue: 0, fetchedAt: new Date() })
    const m = new PositionMonitor({ walletAddress: '0xuser', protocolId: 'aerodrome' }, mockDeBank)
    const s1 = await m.check()
    expect(s1?.previousNetUsdValue).toBeNull()
    const s2 = await m.check()
    expect(s2?.previousNetUsdValue).toBe(18000)
    expect(s2?.netUsdValue).toBe(17500)
  })

  it('returns null when DeBank fails', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition).mockRejectedValue(new Error('fail'))
    const m = new PositionMonitor({ walletAddress: '0xuser', protocolId: 'aerodrome' }, mockDeBank)
    expect(await m.check()).toBeNull()
  })
})
