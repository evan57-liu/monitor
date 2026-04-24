// src/core/storage/queries.ts
import type Database from 'better-sqlite3'
import type { Alert, ExecutionOrder, ExecutionResult, MonitorHealth } from '../types.js'

// ── Price ──────────────────────────────────────────────────────────────────────

export interface PriceRecord {
  protocol: string
  token: string
  price: number
  source: string
  recordedAt: Date
}

export function insertPriceHistory(db: Database.Database, r: PriceRecord): void {
  db.prepare(
    `INSERT INTO price_history (protocol, token, price, source, recorded_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(r.protocol, r.token, r.price, r.source, r.recordedAt.toISOString())
}

export function getRecentPrices(
  db: Database.Database,
  protocol: string,
  token: string,
  limit: number,
): Array<{ price: number; source: string; recordedAt: string }> {
  return db
    .prepare(
      `SELECT price, source, recorded_at as recordedAt FROM price_history WHERE protocol = ? AND token = ? ORDER BY recorded_at DESC LIMIT ?`,
    )
    .all(protocol, token, limit) as Array<{ price: number; source: string; recordedAt: string }>
}

// ── Pool ───────────────────────────────────────────────────────────────────────

export interface PoolSnapshotRecord {
  protocol: string
  poolAddress: string
  reserve0: bigint
  reserve1: bigint
  volume24h: number | null
  buys1h: number | null
  sells1h: number | null
  msUsdRatio: number | null
  recordedAt: Date
}

export function insertPoolSnapshot(db: Database.Database, r: PoolSnapshotRecord): void {
  db.prepare(
    `INSERT INTO pool_snapshots (protocol, pool_address, reserve0, reserve1, volume_24h, buys_1h, sells_1h, msusd_ratio, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.protocol,
    r.poolAddress,
    r.reserve0.toString(),
    r.reserve1.toString(),
    r.volume24h,
    r.buys1h,
    r.sells1h,
    r.msUsdRatio,
    r.recordedAt.toISOString(),
  )
}

// ── Supply ─────────────────────────────────────────────────────────────────────

export interface SupplyRecord {
  token: string
  totalSupply: bigint
  chain: string
  recordedAt: Date
}

export function insertSupplyHistory(db: Database.Database, r: SupplyRecord): void {
  db.prepare(
    `INSERT INTO supply_history (token, total_supply, chain, recorded_at) VALUES (?, ?, ?, ?)`,
  ).run(r.token, r.totalSupply.toString(), r.chain, r.recordedAt.toISOString())
}

export function getRecentSupply(
  db: Database.Database,
  token: string,
  limit: number,
): Array<{ totalSupply: string; recordedAt: string }> {
  return db
    .prepare(
      `SELECT total_supply as totalSupply, recorded_at as recordedAt FROM supply_history WHERE token = ? ORDER BY recorded_at DESC LIMIT ?`,
    )
    .all(token, limit) as Array<{ totalSupply: string; recordedAt: string }>
}

// ── Alert ──────────────────────────────────────────────────────────────────────

export function insertAlert(db: Database.Database, a: Alert): void {
  db.prepare(
    `INSERT INTO alerts (id, type, level, protocol, title, message, data_json, confirmations, required_confirmations, sustained_ms, required_sustained_ms, triggered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.id,
    a.type,
    a.level,
    a.protocol,
    a.title,
    a.message,
    JSON.stringify(a.data),
    a.confirmations,
    a.requiredConfirmations,
    a.sustainedMs,
    a.requiredSustainedMs,
    a.triggeredAt.toISOString(),
  )
}

// ── Execution ──────────────────────────────────────────────────────────────────

export function insertExecution(
  db: Database.Database,
  order: ExecutionOrder,
  result: ExecutionResult,
): void {
  db.prepare(
    `INSERT INTO executions (id, alert_id, protocol, order_type, sequence, group_id, params_json, status, tx_hash, gas_used, gas_price_gwei, error_message, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    order.id,
    order.alertId,
    order.protocol,
    order.type,
    order.sequence,
    order.groupId,
    JSON.stringify(order.params),
    result.status,
    result.txHash ?? null,
    result.gasUsed?.toString() ?? null,
    result.gasPriceGwei ?? null,
    result.error ?? null,
    result.executedAt.toISOString(),
  )
}

// ── Health ─────────────────────────────────────────────────────────────────────

export function insertHealthSnapshot(
  db: Database.Database,
  monitorId: string,
  health: MonitorHealth,
): void {
  db.prepare(
    `INSERT INTO health_snapshots (monitor_id, healthy, sources_json, checked_at) VALUES (?, ?, ?, ?)`,
  ).run(monitorId, health.healthy ? 1 : 0, JSON.stringify(health.sources), health.checkedAt.toISOString())
}
