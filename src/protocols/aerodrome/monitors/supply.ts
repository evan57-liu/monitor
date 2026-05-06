// src/protocols/aerodrome/monitors/supply.ts
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { SupplySignal } from '../types.js'
import type { HistoryStore } from '../history-store.js'
import type pino from 'pino'

interface SupplyMonitorConfig { msUsdAddress: `0x${string}`; chain: string }

export class SupplyMonitor {
  constructor(
    private readonly cfg: SupplyMonitorConfig,
    private readonly rpc: RpcClient,
    private readonly historyStore: HistoryStore,
    private readonly logger?: pino.Logger,
  ) {}

  async check(): Promise<SupplySignal> {
    const totalSupply = await this.rpc.getTotalSupply(this.cfg.msUsdAddress)
    const now = new Date()
    this.historyStore.insertSupply(this.cfg.msUsdAddress, totalSupply, this.cfg.chain, now)
    const signal: SupplySignal = { totalSupply, fetchedAt: now }
    this.logger?.debug({ totalSupply: totalSupply.toString() }, 'SupplyMonitor signal')
    return signal
  }
}
