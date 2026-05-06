// src/protocols/aerodrome/monitors/supply.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SupplyMonitor } from './supply.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { HistoryStore } from '../history-store.js'

const mockRpc = { getTotalSupply: vi.fn() } as unknown as RpcClient
const cfg = { msUsdAddress: '0x0000000000000000000000000000000000000001' as `0x${string}`, chain: 'base' }

function makeHistoryStore(): HistoryStore {
  const insertedSupply: Array<{ token: string; totalSupply: bigint; chain: string; recordedAt: Date }> = []
  return {
    insertSupply: (token: string, totalSupply: bigint, chain: string, recordedAt: Date) => { insertedSupply.push({ token, totalSupply, chain, recordedAt }) },
    getSupplyAtOrBefore: vi.fn().mockReturnValue(null),
    insertProtocolTvl: vi.fn(),
    getProtocolTvlAtOrBefore: vi.fn().mockReturnValue(null),
    insertPosition: vi.fn(),
    getPositionAtOrBefore: vi.fn().mockReturnValue(null),
    _insertedSupply: insertedSupply,
  } as unknown as HistoryStore & { _insertedSupply: typeof insertedSupply }
}

describe('SupplyMonitor', () => {
  it('returns current supply and writes to history store', async () => {
    vi.mocked(mockRpc.getTotalSupply)
      .mockResolvedValueOnce(1_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(1_020_000n * 10n ** 18n)

    const store = makeHistoryStore() as HistoryStore & { _insertedSupply: Array<{ totalSupply: bigint }> }
    const monitor = new SupplyMonitor(cfg, mockRpc, store)
    const first = await monitor.check()
    expect(first.totalSupply).toBe(1_000_000n * 10n ** 18n)
    expect(store._insertedSupply[0]?.totalSupply).toBe(1_000_000n * 10n ** 18n)

    const second = await monitor.check()
    expect(second.totalSupply).toBe(1_020_000n * 10n ** 18n)
    expect(store._insertedSupply[1]?.totalSupply).toBe(1_020_000n * 10n ** 18n)
  })

  it('throws when RPC fails (caller handles null)', async () => {
    vi.mocked(mockRpc.getTotalSupply).mockRejectedValue(new Error('rpc fail'))
    const monitor = new SupplyMonitor(cfg, mockRpc, makeHistoryStore())
    await expect(monitor.check()).rejects.toThrow('rpc fail')
  })
})
