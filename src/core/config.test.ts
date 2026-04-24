// src/core/config.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './config.js'

const TMP = join(tmpdir(), 'dm-config-test')

const MINIMAL_YAML = `
global:
  dry_run: true
  log_level: "info"
sources:
  coingecko:
    base_url: "https://pro-api.coingecko.com/api/v3"
    rate_limit_per_minute: 500
    timeout_ms: 10000
    retry_attempts: 3
  debank:
    base_url: "https://pro-openapi.debank.com/v1"
    timeout_ms: 15000
    retry_attempts: 3
  rpc:
    base:
      url: "https://mainnet.base.org"
      timeout_ms: 10000
      retry_attempts: 3
notifications:
  serverchan:
    enabled: false
    timeout_ms: 5000
    retry_attempts: 3
  email:
    enabled: false
    smtp_host: "smtp.gmail.com"
    smtp_port: 587
    from: "x@gmail.com"
    to: ["x@gmail.com"]
    retry_attempts: 3
    daily_summary_hour: 9
  healthchecks:
    enabled: false
    interval_seconds: 60
protocols:
  aerodrome_msusd_usdc:
    enabled: true
    chain: "base"
    chain_id: 8453
    pool_address: "0x0000000000000000000000000000000000000001"
    gauge_address: "0x0000000000000000000000000000000000000002"
    msusd_address: "0x0000000000000000000000000000000000000003"
    usdc_address: "0x0000000000000000000000000000000000000004"
    router_address: "0x0000000000000000000000000000000000000005"
    position_manager_address: "0x0000000000000000000000000000000000000006"
    lp_token_id: 12345
    team_wallets: []
    polling:
      price_ms: 10000
      pool_ms: 30000
      supply_ms: 60000
      position_ms: 60000
      protocol_ms: 120000
      team_wallets_ms: 120000
    alerts:
      depeg:
        price_threshold: 0.992
        twap_threshold: 0.992
        pool_imbalance_pct: 75
        sustained_seconds: 180
        required_confirmations: 3
      hack_mint:
        supply_increase_pct: 15
        supply_window_seconds: 3600
        price_drop_pct: 2
        sells_spike_multiplier: 5
      liquidity_drain:
        tvl_drop_pct: 30
        tvl_window_seconds: 3600
        pool_msusd_ratio_pct: 70
        sells_buys_ratio: 3
      insider_exit:
        large_outflow_usd: 50000
        price_drop_pct: 1
      position_drop:
        drop_pct: 10
        window_seconds: 3600
    execution:
      swap_batch_count: 3
      swap_slippage_bps: 100
      gas_multiplier: 1.2
      deadline_seconds: 300
      max_gas_gwei: 50
storage:
  sqlite_path: "data/monitor.db"
  retention_days:
    price_history: 30
    pool_snapshots: 30
    health_snapshots: 7
`

const MINIMAL_ENV = `
DM_COINGECKO_API_KEY=test-cg-key
DM_DEBANK_ACCESS_KEY=test-db-key
DM_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
DM_SERVERCHAN_SENDKEY=SCTtest
DM_EMAIL_USER=test@gmail.com
DM_EMAIL_PASSWORD=test-pass
DM_HEALTHCHECKS_PING_URL=https://hc-ping.com/test
`

const SECRET_KEYS = [
  'DM_COINGECKO_API_KEY',
  'DM_DEBANK_ACCESS_KEY',
  'DM_PRIVATE_KEY',
  'DM_SERVERCHAN_SENDKEY',
  'DM_EMAIL_USER',
  'DM_EMAIL_PASSWORD',
  'DM_HEALTHCHECKS_PING_URL',
]

beforeEach(() => {
  // Clear secrets from process.env so dotenv can load fresh values each test
  for (const key of SECRET_KEYS) {
    delete process.env[key]
  }
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'monitor.yaml'), MINIMAL_YAML)
  writeFileSync(join(TMP, '.env'), MINIMAL_ENV)
})

describe('loadConfig', () => {
  it('loads yaml and env secrets', () => {
    const cfg = loadConfig(join(TMP, 'monitor.yaml'), join(TMP, '.env'))
    expect(cfg.global.dryRun).toBe(true)
    expect(cfg.secrets.coingeckoApiKey).toBe('test-cg-key')
    expect(cfg.secrets.privateKey).toMatch(/^0x/)
    expect(cfg.sources.coingecko.baseUrl).toBe('https://pro-api.coingecko.com/api/v3')
    expect(cfg.sources.coingecko.rateLimitPerMinute).toBe(500)
    expect(cfg.sources.debank.baseUrl).toBe('https://pro-openapi.debank.com/v1')
    expect(cfg.sources.debank.timeoutMs).toBe(15000)
  })

  it('exposes aerodrome protocol config', () => {
    const cfg = loadConfig(join(TMP, 'monitor.yaml'), join(TMP, '.env'))
    const ae = cfg.protocols.aerodromeMusdUsdc
    expect(ae.chainId).toBe(8453)
    expect(ae.lpTokenId).toBe(12345)
    expect(ae.alerts.depeg.priceThreshold).toBe(0.992)
    expect(ae.execution.swapBatchCount).toBe(3)
  })

  it('throws when required secret is missing', () => {
    writeFileSync(join(TMP, '.env'), '') // empty env
    expect(() => loadConfig(join(TMP, 'monitor.yaml'), join(TMP, '.env'))).toThrow(
      /DM_COINGECKO_API_KEY/,
    )
  })
})
