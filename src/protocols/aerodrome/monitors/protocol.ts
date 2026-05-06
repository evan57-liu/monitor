// src/protocols/aerodrome/monitors/protocol.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { ProtocolSignal } from '../types.js'
import type { HistoryStore } from '../history-store.js'
import type pino from 'pino'

interface ProtocolMonitorConfig { protocolIds: string[]; monitorId: string }

export class ProtocolMonitor {
  constructor(
    private readonly cfg: ProtocolMonitorConfig,
    private readonly debank: DeBankClient,
    private readonly historyStore: HistoryStore,
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

    const now = new Date()
    // 只在至少有一个成功时落库，避免全失败时把 0 污染历史基准
    if (successful.length > 0) {
      this.historyStore.insertProtocolTvl(this.cfg.monitorId, tvlUsd, now)
    }

    const signal: ProtocolSignal = { tvlUsd, fetchedAt: now }
    this.logger?.debug(
      { protocolIds: this.cfg.protocolIds, fetched: successful.length, tvlUsd },
      'ProtocolMonitor signal',
    )
    return signal
  }
}
