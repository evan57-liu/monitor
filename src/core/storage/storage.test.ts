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
  getRecentSupply,
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

describe('supply_history', () => {
  it('inserts and retrieves supply records', () => {
    insertSupplyHistory(db, {
      token: 'msusd',
      totalSupply: 1_000_000n * 10n ** 18n,
      chain: 'base',
      recordedAt: new Date(),
    })
    const rows = getRecentSupply(db, 'msusd', 5)
    expect(rows).toHaveLength(1)
    expect(BigInt(rows[0]?.totalSupply ?? '0')).toBe(1_000_000n * 10n ** 18n)
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

describe('retention cleanup', () => {
  it('deletes price records older than retention days', () => {
    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000) // 35 days ago
    insertPriceHistory(db, { protocol: 'test', token: 'msusd', price: 1.0, source: 'cg', recordedAt: old })
    insertPriceHistory(db, { protocol: 'test', token: 'msusd', price: 1.0, source: 'cg', recordedAt: new Date() })
    runRetentionCleanup(db, { priceHistory: 30, poolSnapshots: 30, healthSnapshots: 7 })
    expect(getRecentPrices(db, 'test', 'msusd', 10)).toHaveLength(1)
  })
})
