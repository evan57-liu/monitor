// src/protocols/aerodrome/monitors/protocol.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { ProtocolSignal } from '../types.js'
import type pino from 'pino'

interface ProtocolMonitorConfig { protocolId: string }

export class ProtocolMonitor {
  private previousTvl: number | null = null

  constructor(
    private readonly cfg: ProtocolMonitorConfig,
    private readonly debank: DeBankClient,
    private readonly logger?: pino.Logger,
  ) {}

  async check(): Promise<ProtocolSignal | null> {
    const tvlData = await this.debank.getProtocolTvl(this.cfg.protocolId)
    const signal: ProtocolSignal = {
      tvlUsd: tvlData.tvlUsd,
      previousTvlUsd: this.previousTvl,
      fetchedAt: new Date(),
    }
    this.logger?.debug({ tvlUsd: tvlData.tvlUsd, previousTvlUsd: this.previousTvl }, 'ProtocolMonitor signal')
    this.previousTvl = tvlData.tvlUsd
    return signal
  }
}
