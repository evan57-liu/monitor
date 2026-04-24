// src/protocols/aerodrome/monitors/protocol.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { ProtocolSignal } from '../types.js'

interface ProtocolMonitorConfig { protocolId: string }

export class ProtocolMonitor {
  private previousTvl: number | null = null

  constructor(private readonly cfg: ProtocolMonitorConfig, private readonly debank: DeBankClient) {}

  async check(): Promise<ProtocolSignal | null> {
    try {
      const tvlData = await this.debank.getProtocolTvl(this.cfg.protocolId)
      const signal: ProtocolSignal = {
        tvlUsd: tvlData.tvlUsd,
        previousTvlUsd: this.previousTvl,
        fetchedAt: new Date(),
      }
      this.previousTvl = tvlData.tvlUsd
      return signal
    } catch { return null }
  }
}
