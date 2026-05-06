// src/protocols/aerodrome/monitors/position.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { PositionSignal } from '../types.js'
import type { HistoryStore } from '../history-store.js'
import type pino from 'pino'

interface PositionMonitorConfig { walletAddress: string; protocolId: string; poolId: string; msUsdAddress: string; monitorId: string }

export class PositionMonitor {
  constructor(
    private readonly cfg: PositionMonitorConfig,
    private readonly debank: DeBankClient,
    private readonly historyStore: HistoryStore,
    private readonly logger?: pino.Logger,
  ) {}

  async check(): Promise<PositionSignal | null> {
    try {
      const pos = await this.debank.getUserProtocolPosition(
        this.cfg.walletAddress, this.cfg.protocolId, this.cfg.poolId,
      )
      const debankMsUsdPrice = pos.supplyTokenPrices[this.cfg.msUsdAddress.toLowerCase()] ?? null
      const now = new Date()
      this.historyStore.insertPosition(this.cfg.monitorId, this.cfg.walletAddress, pos.netUsdValue, now)
      return { netUsdValue: pos.netUsdValue, rewardUsdValue: pos.rewardUsdValue, debankMsUsdPrice, fetchedAt: now }
    } catch (err) {
      this.logger?.warn({ err, walletAddress: this.cfg.walletAddress, protocolId: this.cfg.protocolId }, 'PositionMonitor: DeBank fetch failed')
      return null
    }
  }
}
