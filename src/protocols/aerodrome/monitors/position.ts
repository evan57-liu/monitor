// src/protocols/aerodrome/monitors/position.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { PositionSignal } from '../types.js'

interface PositionMonitorConfig { walletAddress: string; protocolId: string }

export class PositionMonitor {
  private previousValue: number | null = null

  constructor(private readonly cfg: PositionMonitorConfig, private readonly debank: DeBankClient) {}

  async check(): Promise<PositionSignal | null> {
    try {
      const pos = await this.debank.getUserProtocolPosition(this.cfg.walletAddress, this.cfg.protocolId)
      const signal: PositionSignal = {
        netUsdValue: pos.netUsdValue,
        previousNetUsdValue: this.previousValue,
        fetchedAt: new Date(),
      }
      this.previousValue = pos.netUsdValue
      return signal
    } catch { return null }
  }
}
