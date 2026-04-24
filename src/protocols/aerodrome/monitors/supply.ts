// src/protocols/aerodrome/monitors/supply.ts
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { SupplySignal } from '../types.js'

interface SupplyMonitorConfig { msUsdAddress: `0x${string}` }

export class SupplyMonitor {
  private previousSupply: bigint | null = null

  constructor(
    private readonly cfg: SupplyMonitorConfig,
    private readonly rpc: RpcClient,
  ) {}

  async check(): Promise<SupplySignal> {
    const totalSupply = await this.rpc.getTotalSupply(this.cfg.msUsdAddress)
    const signal: SupplySignal = {
      totalSupply,
      previousSupply: this.previousSupply,
      fetchedAt: new Date(),
    }
    this.previousSupply = totalSupply
    return signal
  }
}
