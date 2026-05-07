// src/protocols/aerodrome/history-store.ts
import type Database from 'better-sqlite3'
import {
  insertSupplyHistory,
  getSupplyAtOrBefore,
  insertProtocolTvl,
  getProtocolTvlAtOrBefore,
  insertPositionSnapshot,
  getPositionAtOrBefore,
  insertPriceHistory,
  insertPoolSnapshot,
} from '../../core/storage/queries.js'
import type { PoolSignal } from './types.js'

export interface HistoryStore {
  insertSupply(token: string, totalSupply: bigint, chain: string, recordedAt: Date): void
  getSupplyAtOrBefore(token: string, before: Date): bigint | null
  insertProtocolTvl(protocol: string, tvlUsd: number, recordedAt: Date): void
  getProtocolTvlAtOrBefore(protocol: string, before: Date): number | null
  insertPosition(protocol: string, wallet: string, netUsdValue: number, recordedAt: Date): void
  getPositionAtOrBefore(protocol: string, wallet: string, before: Date): number | null
  insertPrice(protocol: string, token: string, price: number, source: string, recordedAt: Date): void
  insertPool(protocol: string, poolAddress: string, pool: PoolSignal): void
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

  insertPrice(protocol: string, token: string, price: number, source: string, recordedAt: Date): void {
    insertPriceHistory(this.db, { protocol, token, price, source, recordedAt })
  }

  insertPool(protocol: string, poolAddress: string, pool: PoolSignal): void {
    insertPoolSnapshot(this.db, {
      protocol,
      poolAddress,
      reserve0: pool.reserve0,
      reserve1: pool.reserve1,
      volume24h: pool.volume24h,
      buys1h: pool.buys1h,
      sells1h: pool.sells1h,
      msUsdRatio: pool.msUsdRatio,
      recordedAt: pool.fetchedAt,
    })
  }
}
