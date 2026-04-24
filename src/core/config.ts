// src/core/config.ts
import { readFileSync } from 'node:fs'
import { config as loadDotenv } from 'dotenv'
import { parse } from 'yaml'

// ── Config types ───────────────────────────────────────────────────────────────

export interface AppConfig {
  global: { dryRun: boolean; logLevel: string }
  sources: {
    coingecko: { baseUrl: string; rateLimitPerMinute: number; timeoutMs: number; retryAttempts: number }
    debank: { baseUrl: string; timeoutMs: number; retryAttempts: number }
    rpc: { base: { url: string; timeoutMs: number; retryAttempts: number } }
  }
  notifications: {
    serverchan: { enabled: boolean; sendkey: string; timeoutMs: number; retryAttempts: number }
    email: {
      enabled: boolean; smtpHost: string; smtpPort: number; user: string; password: string
      from: string; to: string[]; retryAttempts: number; dailySummaryHour: number
    }
    healthchecks: { enabled: boolean; pingUrl: string; intervalSeconds: number }
  }
  protocols: { aerodromeMusdUsdc: AerodromeConfig }
  storage: { sqlitePath: string; retentionDays: { priceHistory: number; poolSnapshots: number; healthSnapshots: number } }
  secrets: { coingeckoApiKey: string; debankAccessKey: string; privateKey: string }
}

export interface AerodromeConfig {
  enabled: boolean
  chain: string
  chainId: number
  poolAddress: string
  gaugeAddress: string
  msUsdAddress: string
  usdcAddress: string
  routerAddress: string
  positionManagerAddress: string
  lpTokenId: number
  teamWallets: string[]
  polling: { priceMs: number; poolMs: number; supplyMs: number; positionMs: number; protocolMs: number; teamWalletsMs: number }
  alerts: {
    depeg: { priceThreshold: number; twapThreshold: number; poolImbalancePct: number; sustainedSeconds: number; requiredConfirmations: number }
    hackMint: { supplyIncreasePct: number; supplyWindowSeconds: number; priceDropPct: number; sellsSpikeMultiplier: number }
    liquidityDrain: { tvlDropPct: number; tvlWindowSeconds: number; poolMsUsdRatioPct: number; sellsBuysRatio: number }
    insiderExit: { largeOutflowUsd: number; priceDropPct: number }
    positionDrop: { dropPct: number; windowSeconds: number }
  }
  execution: { swapBatchCount: number; swapSlippageBps: number; gasMultiplier: number; deadlineSeconds: number; maxGasGwei: number }
}

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadConfig(yamlPath: string, envPath: string): AppConfig {
  loadDotenv({ path: envPath, override: false })

  const raw = readFileSync(yamlPath, 'utf8')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const y = parse(raw) as any

  const secrets = {
    coingeckoApiKey: requireEnv('DM_COINGECKO_API_KEY'),
    debankAccessKey: requireEnv('DM_DEBANK_ACCESS_KEY'),
    privateKey: requireEnv('DM_PRIVATE_KEY'),
  }

  const ae = y.protocols.aerodrome_msusd_usdc

  return {
    global: {
      dryRun: process.env['DM_GLOBAL_DRY_RUN'] === 'false' ? false : Boolean(y.global.dry_run),
      logLevel: (process.env['DM_GLOBAL_LOG_LEVEL'] ?? y.global.log_level) as string,
    },
    sources: {
      coingecko: y.sources.coingecko,
      debank: y.sources.debank,
      rpc: { base: { url: process.env['DM_RPC_BASE_URL'] ?? y.sources.rpc.base.url, timeoutMs: y.sources.rpc.base.timeout_ms, retryAttempts: y.sources.rpc.base.retry_attempts } },
    },
    notifications: {
      serverchan: { enabled: y.notifications.serverchan.enabled, sendkey: process.env['DM_SERVERCHAN_SENDKEY'] ?? '', timeoutMs: y.notifications.serverchan.timeout_ms, retryAttempts: y.notifications.serverchan.retry_attempts },
      email: { enabled: y.notifications.email.enabled, smtpHost: y.notifications.email.smtp_host, smtpPort: y.notifications.email.smtp_port, user: process.env['DM_EMAIL_USER'] ?? '', password: process.env['DM_EMAIL_PASSWORD'] ?? '', from: y.notifications.email.from, to: y.notifications.email.to as string[], retryAttempts: y.notifications.email.retry_attempts, dailySummaryHour: y.notifications.email.daily_summary_hour },
      healthchecks: { enabled: y.notifications.healthchecks.enabled, pingUrl: process.env['DM_HEALTHCHECKS_PING_URL'] ?? '', intervalSeconds: y.notifications.healthchecks.interval_seconds },
    },
    protocols: {
      aerodromeMusdUsdc: {
        enabled: ae.enabled,
        chain: ae.chain,
        chainId: ae.chain_id,
        poolAddress: ae.pool_address,
        gaugeAddress: ae.gauge_address,
        msUsdAddress: ae.msusd_address,
        usdcAddress: ae.usdc_address,
        routerAddress: ae.router_address,
        positionManagerAddress: ae.position_manager_address,
        lpTokenId: ae.lp_token_id,
        teamWallets: ae.team_wallets as string[],
        polling: { priceMs: ae.polling.price_ms, poolMs: ae.polling.pool_ms, supplyMs: ae.polling.supply_ms, positionMs: ae.polling.position_ms, protocolMs: ae.polling.protocol_ms, teamWalletsMs: ae.polling.team_wallets_ms },
        alerts: {
          depeg: { priceThreshold: ae.alerts.depeg.price_threshold, twapThreshold: ae.alerts.depeg.twap_threshold, poolImbalancePct: ae.alerts.depeg.pool_imbalance_pct, sustainedSeconds: ae.alerts.depeg.sustained_seconds, requiredConfirmations: ae.alerts.depeg.required_confirmations },
          hackMint: { supplyIncreasePct: ae.alerts.hack_mint.supply_increase_pct, supplyWindowSeconds: ae.alerts.hack_mint.supply_window_seconds, priceDropPct: ae.alerts.hack_mint.price_drop_pct, sellsSpikeMultiplier: ae.alerts.hack_mint.sells_spike_multiplier },
          liquidityDrain: { tvlDropPct: ae.alerts.liquidity_drain.tvl_drop_pct, tvlWindowSeconds: ae.alerts.liquidity_drain.tvl_window_seconds, poolMsUsdRatioPct: ae.alerts.liquidity_drain.pool_msusd_ratio_pct, sellsBuysRatio: ae.alerts.liquidity_drain.sells_buys_ratio },
          insiderExit: { largeOutflowUsd: ae.alerts.insider_exit.large_outflow_usd, priceDropPct: ae.alerts.insider_exit.price_drop_pct },
          positionDrop: { dropPct: ae.alerts.position_drop.drop_pct, windowSeconds: ae.alerts.position_drop.window_seconds },
        },
        execution: { swapBatchCount: ae.execution.swap_batch_count, swapSlippageBps: ae.execution.swap_slippage_bps, gasMultiplier: ae.execution.gas_multiplier, deadlineSeconds: ae.execution.deadline_seconds, maxGasGwei: ae.execution.max_gas_gwei },
      },
    },
    storage: { sqlitePath: y.storage.sqlite_path, retentionDays: { priceHistory: y.storage.retention_days.price_history, poolSnapshots: y.storage.retention_days.pool_snapshots, healthSnapshots: y.storage.retention_days.health_snapshots } },
    secrets,
  }
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Required environment variable ${key} is not set`)
  return value
}
