// src/core/storage/storage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb, closeDb, runRetentionCleanup } from './index.js'
import {
  insertPriceHistory,
  insertPoolSnapshot,
  insertSupplyHistory,
  insertAlert,
  insertExecution,
  getRecentPrices,
  getSupplyAtOrBefore,
  insertProtocolTvl,
  getProtocolTvlAtOrBefore,
  insertPositionSnapshot,
  getPositionAtOrBefore,
} from './queries.js'
import { AlertLevel, AlertType, OrderStatus, OrderType } from '../types.js'
import type Database from 'better-sqlite3'

let db: Database.Database

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  closeDb(db)
})

describe('price_history', () => {
  it('inserts and retrieves price records', () => {
    insertPriceHistory(db, {
      protocol: 'aerodrome-msusd-usdc',
      token: 'msusd',
      price: 0.9985,
      source: 'coingecko',
      recordedAt: new Date(),
    })
    const rows = getRecentPrices(db, 'aerodrome-msusd-usdc', 'msusd', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.price).toBeCloseTo(0.9985)
  })
})

describe('alerts', () => {
  it('inserts alert record', () => {
    insertAlert(db, {
      id: crypto.randomUUID(),
      type: AlertType.DEPEG,
      level: AlertLevel.RED,
      protocol: 'aerodrome-msusd-usdc',
      title: 'Test depeg',
      message: 'price fell',
      data: { price: 0.985 },
      triggeredAt: new Date(),
      confirmations: 3,
      requiredConfirmations: 3,
      sustainedMs: 200_000,
      requiredSustainedMs: 180_000,
    })
    // No error = pass
  })
})

describe('getSupplyAtOrBefore', () => {
  it('returns null when table is empty', () => {
    expect(getSupplyAtOrBefore(db, 'msusd', new Date())).toBeNull()
  })

  it('returns the closest record at or before the given timestamp', () => {
    const t1 = new Date('2025-01-01T00:00:00Z')
    const t2 = new Date('2025-01-01T01:00:00Z')
    const t3 = new Date('2025-01-01T02:00:00Z')
    insertSupplyHistory(db, { token: 'msusd', totalSupply: 1_000n, chain: 'base', recordedAt: t1 })
    insertSupplyHistory(db, { token: 'msusd', totalSupply: 1_100n, chain: 'base', recordedAt: t2 })
    insertSupplyHistory(db, { token: 'msusd', totalSupply: 1_200n, chain: 'base', recordedAt: t3 })

    expect(getSupplyAtOrBefore(db, 'msusd', t2)).toBe(1_100n)
    expect(getSupplyAtOrBefore(db, 'msusd', new Date('2025-01-01T01:30:00Z'))).toBe(1_100n)
    expect(getSupplyAtOrBefore(db, 'msusd', new Date('2024-12-31T00:00:00Z'))).toBeNull()
  })

  it('isolates by token name', () => {
    const now = new Date()
    insertSupplyHistory(db, { token: 'msusd', totalSupply: 100n, chain: 'base', recordedAt: now })
    insertSupplyHistory(db, { token: 'other', totalSupply: 999n, chain: 'eth', recordedAt: now })
    expect(getSupplyAtOrBefore(db, 'msusd', now)).toBe(100n)
    expect(getSupplyAtOrBefore(db, 'other', now)).toBe(999n)
  })
})

describe('getProtocolTvlAtOrBefore', () => {
  it('returns null when table is empty', () => {
    expect(getProtocolTvlAtOrBefore(db, 'aerodrome', new Date())).toBeNull()
  })

  it('returns the closest TVL record at or before the timestamp', () => {
    const t1 = new Date('2025-01-01T00:00:00Z')
    const t2 = new Date('2025-01-01T01:00:00Z')
    insertProtocolTvl(db, { protocol: 'aerodrome', tvlUsd: 50_000_000, recordedAt: t1 })
    insertProtocolTvl(db, { protocol: 'aerodrome', tvlUsd: 55_000_000, recordedAt: t2 })

    expect(getProtocolTvlAtOrBefore(db, 'aerodrome', t1)).toBeCloseTo(50_000_000)
    expect(getProtocolTvlAtOrBefore(db, 'aerodrome', t2)).toBeCloseTo(55_000_000)
    expect(getProtocolTvlAtOrBefore(db, 'aerodrome', new Date('2024-12-31T00:00:00Z'))).toBeNull()
  })

  it('isolates by protocol', () => {
    const now = new Date()
    insertProtocolTvl(db, { protocol: 'proto-a', tvlUsd: 100, recordedAt: now })
    insertProtocolTvl(db, { protocol: 'proto-b', tvlUsd: 200, recordedAt: now })
    expect(getProtocolTvlAtOrBefore(db, 'proto-a', now)).toBeCloseTo(100)
    expect(getProtocolTvlAtOrBefore(db, 'proto-b', now)).toBeCloseTo(200)
  })
})

describe('getPositionAtOrBefore', () => {
  it('returns null when table is empty', () => {
    expect(getPositionAtOrBefore(db, 'aerodrome', '0xwallet', new Date())).toBeNull()
  })

  it('returns the closest position record at or before the timestamp', () => {
    const t1 = new Date('2025-01-01T00:00:00Z')
    const t2 = new Date('2025-01-01T01:00:00Z')
    insertPositionSnapshot(db, { protocol: 'aerodrome', wallet: '0xwallet', netUsdValue: 18_000, recordedAt: t1 })
    insertPositionSnapshot(db, { protocol: 'aerodrome', wallet: '0xwallet', netUsdValue: 17_500, recordedAt: t2 })

    expect(getPositionAtOrBefore(db, 'aerodrome', '0xwallet', t1)).toBeCloseTo(18_000)
    expect(getPositionAtOrBefore(db, 'aerodrome', '0xwallet', new Date('2025-01-01T01:30:00Z'))).toBeCloseTo(17_500)
    expect(getPositionAtOrBefore(db, 'aerodrome', '0xwallet', new Date('2024-12-31T00:00:00Z'))).toBeNull()
  })

  it('isolates by protocol and wallet', () => {
    const now = new Date()
    insertPositionSnapshot(db, { protocol: 'a', wallet: '0xw1', netUsdValue: 100, recordedAt: now })
    insertPositionSnapshot(db, { protocol: 'a', wallet: '0xw2', netUsdValue: 200, recordedAt: now })
    insertPositionSnapshot(db, { protocol: 'b', wallet: '0xw1', netUsdValue: 300, recordedAt: now })
    expect(getPositionAtOrBefore(db, 'a', '0xw1', now)).toBeCloseTo(100)
    expect(getPositionAtOrBefore(db, 'a', '0xw2', now)).toBeCloseTo(200)
    expect(getPositionAtOrBefore(db, 'b', '0xw1', now)).toBeCloseTo(300)
  })
})

describe('retention cleanup', () => {
  it('deletes price records older than retention days', () => {
    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000) // 35 days ago
    insertPriceHistory(db, { protocol: 'test', token: 'msusd', price: 1.0, source: 'cg', recordedAt: old })
    insertPriceHistory(db, { protocol: 'test', token: 'msusd', price: 1.0, source: 'cg', recordedAt: new Date() })
    runRetentionCleanup(db, { priceHistory: 30, poolSnapshots: 30, healthSnapshots: 7, tvlHistory: 30, positionHistory: 30 })
    expect(getRecentPrices(db, 'test', 'msusd', 10)).toHaveLength(1)
  })
})
