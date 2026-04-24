// src/protocols/aerodrome/monitors/supply.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SupplyMonitor } from './supply.js'
import type { RpcClient } from '../../../core/clients/rpc.js'

const mockRpc = { getTotalSupply: vi.fn() } as unknown as RpcClient
const cfg = { msUsdAddress: '0x0000000000000000000000000000000000000001' as `0x${string}` }

describe('SupplyMonitor', () => {
  it('returns current supply and tracks previous', async () => {
    vi.mocked(mockRpc.getTotalSupply)
      .mockResolvedValueOnce(1_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(1_020_000n * 10n ** 18n)

    const monitor = new SupplyMonitor(cfg, mockRpc)
    const first = await monitor.check()
    expect(first.totalSupply).toBe(1_000_000n * 10n ** 18n)
    expect(first.previousSupply).toBeNull()

    const second = await monitor.check()
    expect(second.totalSupply).toBe(1_020_000n * 10n ** 18n)
    expect(second.previousSupply).toBe(1_000_000n * 10n ** 18n)
  })

  it('throws when RPC fails (caller handles null)', async () => {
    vi.mocked(mockRpc.getTotalSupply).mockRejectedValue(new Error('rpc fail'))
    const monitor = new SupplyMonitor(cfg, mockRpc)
    await expect(monitor.check()).rejects.toThrow('rpc fail')
  })
})
