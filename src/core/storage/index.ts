// src/core/storage/index.ts
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function closeDb(db: Database.Database): void {
  db.close()
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,
      token TEXT NOT NULL,
      price REAL NOT NULL,
      source TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_price_protocol_time ON price_history(protocol, recorded_at);

    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      reserve0 TEXT NOT NULL,
      reserve1 TEXT NOT NULL,
      volume_24h REAL,
      buys_1h INTEGER,
      sells_1h INTEGER,
      msusd_ratio REAL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pool_protocol_time ON pool_snapshots(protocol, recorded_at);

    CREATE TABLE IF NOT EXISTS supply_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      total_supply TEXT NOT NULL,
      chain TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_supply_token_time ON supply_history(token, recorded_at);

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      level TEXT NOT NULL,
      protocol TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT NOT NULL,
      confirmations INTEGER NOT NULL,
      required_confirmations INTEGER NOT NULL,
      sustained_ms INTEGER NOT NULL,
      required_sustained_ms INTEGER NOT NULL,
      triggered_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_protocol_time ON alerts(protocol, triggered_at);

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id),
      protocol TEXT NOT NULL,
      order_type TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      params_json TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      gas_used TEXT,
      gas_price_gwei REAL,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      executed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exec_alert ON executions(alert_id);

    CREATE TABLE IF NOT EXISTS health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id TEXT NOT NULL,
      healthy INTEGER NOT NULL,
      sources_json TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_health_monitor_time ON health_snapshots(monitor_id, checked_at);
  `)
}

export function runRetentionCleanup(
  db: Database.Database,
  days: { priceHistory: number; poolSnapshots: number; healthSnapshots: number },
): void {
  db.prepare(`DELETE FROM price_history WHERE recorded_at < datetime('now', '-${days.priceHistory} days')`).run()
  db.prepare(`DELETE FROM pool_snapshots WHERE recorded_at < datetime('now', '-${days.poolSnapshots} days')`).run()
  db.prepare(`DELETE FROM health_snapshots WHERE checked_at < datetime('now', '-${days.healthSnapshots} days')`).run()
}
