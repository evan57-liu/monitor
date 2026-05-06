// src/protocols/aerodrome/monitors/protocol.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { ProtocolSignal } from '../types.js'
import type pino from 'pino'

interface ProtocolMonitorConfig { protocolIds: string[] }

export class ProtocolMonitor {
  private previousTvl: number | null = null

  constructor(
    private readonly cfg: ProtocolMonitorConfig,
    private readonly debank: DeBankClient,
    private readonly logger?: pino.Logger,
  ) {}

  async check(): Promise<ProtocolSignal | null> {
    if (this.cfg.protocolIds.length === 0) return null

    const tvls = await Promise.all(
      this.cfg.protocolIds.map(async id => {
        try {
          return (await this.debank.getProtocolTvl(id)).tvlUsd
        } catch (err) {
          this.logger?.warn({ protocolId: id, err }, 'ProtocolMonitor: failed to fetch TVL')
          return null
        }
      }),
    )

    const successful = tvls.filter((v): v is number => v !== null)
    const tvlUsd = successful.reduce((sum, v) => sum + v, 0)
    const signal: ProtocolSignal = {
      tvlUsd,
      previousTvlUsd: this.previousTvl,
      fetchedAt: new Date(),
    }
    this.logger?.debug(
      { protocolIds: this.cfg.protocolIds, fetched: successful.length, tvlUsd, previousTvlUsd: this.previousTvl },
      'ProtocolMonitor signal',
    )
    // 只在至少有一个成功时更新，避免全部失败时以 0 污染历史基准
    if (successful.length > 0) this.previousTvl = tvlUsd
    return signal
  }
}
