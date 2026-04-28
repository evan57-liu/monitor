// src/protocols/aerodrome/monitors/position.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { PositionSignal } from '../types.js'
import type pino from 'pino'

interface PositionMonitorConfig { walletAddress: string; protocolId: string; poolId: string; msUsdAddress: string }

export class PositionMonitor {
  private previousValue: number | null = null

  constructor(
    private readonly cfg: PositionMonitorConfig,
    private readonly debank: DeBankClient,
    private readonly logger?: pino.Logger,
  ) {}

  async check(): Promise<PositionSignal | null> {
    try {
      const pos = await this.debank.getUserProtocolPosition(
        this.cfg.walletAddress, this.cfg.protocolId, this.cfg.poolId,
      )
      const debankMsUsdPrice = pos.supplyTokenPrices[this.cfg.msUsdAddress.toLowerCase()] ?? null
      const signal: PositionSignal = {
        netUsdValue: pos.netUsdValue,
        rewardUsdValue: pos.rewardUsdValue,
        previousNetUsdValue: this.previousValue,
        debankMsUsdPrice,
        fetchedAt: new Date(),
      }
      this.previousValue = pos.netUsdValue
      return signal
    } catch (err) {
      this.logger?.warn({ err, walletAddress: this.cfg.walletAddress, protocolId: this.cfg.protocolId }, 'PositionMonitor: DeBank fetch failed')
      return null
    }
  }
}
