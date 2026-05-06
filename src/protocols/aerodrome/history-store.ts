// src/protocols/aerodrome/history-store.ts
import type Database from 'better-sqlite3'
import {
  insertSupplyHistory,
  getSupplyAtOrBefore,
  insertProtocolTvl,
  getProtocolTvlAtOrBefore,
  insertPositionSnapshot,
  getPositionAtOrBefore,
} from '../../core/storage/queries.js'

export interface HistoryStore {
  insertSupply(token: string, totalSupply: bigint, chain: string, recordedAt: Date): void
  getSupplyAtOrBefore(token: string, before: Date): bigint | null
  insertProtocolTvl(protocol: string, tvlUsd: number, recordedAt: Date): void
  getProtocolTvlAtOrBefore(protocol: string, before: Date): number | null
  insertPosition(protocol: string, wallet: string, netUsdValue: number, recordedAt: Date): void
  getPositionAtOrBefore(protocol: string, wallet: string, before: Date): number | null
}

export class SqliteHistoryStore implements HistoryStore {
  constructor(private readonly db: Database.Database) {}

  insertSupply(token: string, totalSupply: bigint, chain: string, recordedAt: Date): void {
    insertSupplyHistory(this.db, { token, totalSupply, chain, recordedAt })
  }

  getSupplyAtOrBefore(token: string, before: Date): bigint | null {
    return getSupplyAtOrBefore(this.db, token, before)
  }

  insertProtocolTvl(protocol: string, tvlUsd: number, recordedAt: Date): void {
    insertProtocolTvl(this.db, { protocol, tvlUsd, recordedAt })
  }

  getProtocolTvlAtOrBefore(protocol: string, before: Date): number | null {
    return getProtocolTvlAtOrBefore(this.db, protocol, before)
  }

  insertPosition(protocol: string, wallet: string, netUsdValue: number, recordedAt: Date): void {
    insertPositionSnapshot(this.db, { protocol, wallet, netUsdValue, recordedAt })
  }

  getPositionAtOrBefore(protocol: string, wallet: string, before: Date): number | null {
    return getPositionAtOrBefore(this.db, protocol, wallet, before)
  }
}
