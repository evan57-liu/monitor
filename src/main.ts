// src/main.ts
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'
import { privateKeyToAccount } from 'viem/accounts'
import { loadConfig } from './core/config.js'
import { AlertType } from './core/types.js'
import { initLogger } from './core/logger.js'
import { openDb, closeDb, runRetentionCleanup } from './core/storage/index.js'
import { CoinGeckoClient } from './core/clients/coingecko.js'
import { DeBankClient } from './core/clients/debank.js'
import { RpcClient } from './core/clients/rpc.js'
import { ServerChanChannel } from './core/notify/serverchan.js'
import { EmailChannel } from './core/notify/email.js'
import { HealthchecksMonitor } from './core/notify/healthchecks.js'
import { Notifier } from './core/notify/notifier.js'
import { DryRunExecutor } from './core/executor/dry-run.js'
import { LiveExecutor } from './core/executor/index.js'
import { MacKeychainReader } from './core/keychain.js'
import { Engine } from './core/engine.js'
import { AerodromeMonitor } from './protocols/aerodrome/index.js'
import { SqliteHistoryStore } from './protocols/aerodrome/history-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

async function main(): Promise<void> {
  // ── 配置 ──────────────────────────────────────────────────────────────────
  const cfg = loadConfig(
    resolve(ROOT, 'configs', 'monitor.yaml'),
    resolve(ROOT, 'configs', '.env'),
    new MacKeychainReader(),
  )
  // ── 代理（在任何 fetch 之前，loadConfig 已将 .env 加载到 process.env）─────
  setGlobalDispatcher(new EnvHttpProxyAgent())

  const logger = initLogger(cfg.global.logLevel)

  logger.info({ dryRun: cfg.global.dryRun }, 'DeFi Monitor starting')

  // ── 存储 ─────────────────────────────────────────────────────────────────
  const db = openDb(resolve(ROOT, cfg.storage.sqlitePath))
  logger.info({ path: cfg.storage.sqlitePath }, 'SQLite database opened')

  // ── 客户端 ─────────────────────────────────────────────────────────────────
  const coinGecko = new CoinGeckoClient({
    baseUrl: cfg.sources.coingecko.baseUrl,
    apiKey: cfg.secrets.coingeckoApiKey,
    timeoutMs: cfg.sources.coingecko.timeoutMs,
    retryAttempts: cfg.sources.coingecko.retryAttempts,
  }, logger)
  const deBank = new DeBankClient({
    baseUrl: cfg.sources.debank.baseUrl,
    accessKey: cfg.secrets.debankAccessKey,
    timeoutMs: cfg.sources.debank.timeoutMs,
    retryAttempts: cfg.sources.debank.retryAttempts,
  }, logger)
  const rpc = new RpcClient({
    url: cfg.sources.rpc.base.url,
    timeoutMs: cfg.sources.rpc.base.timeoutMs,
    retryAttempts: cfg.sources.rpc.base.retryAttempts,
  }, logger)

  // ── 通知渠道 ────────────────────────────────────────────────────────────
  const channels = []
  if (cfg.notifications.serverchan.enabled) {
    channels.push(new ServerChanChannel({
      sendkey: cfg.notifications.serverchan.sendkey,
      timeoutMs: cfg.notifications.serverchan.timeoutMs,
      retryAttempts: cfg.notifications.serverchan.retryAttempts,
    }))
  }
  if (cfg.notifications.email.enabled) {
    channels.push(new EmailChannel({
      smtpHost: cfg.notifications.email.smtpHost,
      smtpPort: cfg.notifications.email.smtpPort,
      user: cfg.notifications.email.user,
      password: cfg.notifications.email.password,
      from: cfg.notifications.email.from,
      to: cfg.notifications.email.to,
      retryAttempts: cfg.notifications.email.retryAttempts,
    }))
  }
  const notifier = new Notifier(channels, { criticalTypes: cfg.notifications.routing.criticalTypes as AlertType[] })

  // 启动时测试所有通知渠道
  const testResults = await notifier.testAll()
  logger.info({ channels: testResults }, 'Notification channel test results')

  // ── 健康检查 ─────────────────────────────────────────────────────────────
  let healthchecks: HealthchecksMonitor | undefined
  if (cfg.notifications.healthchecks.enabled) {
    healthchecks = new HealthchecksMonitor(
      cfg.notifications.healthchecks.pingUrl,
      cfg.notifications.healthchecks.intervalSeconds,
      logger,
    )
    healthchecks.start()
  }

  // ── 执行器 ─────────────────────────────────────────────────────────────────
  const executor = cfg.global.dryRun
    ? new DryRunExecutor(logger)
    : new LiveExecutor({
        privateKey: cfg.secrets.privateKey,
        rpcUrl: cfg.sources.rpc.base.url,
        rpcTimeoutMs: cfg.sources.rpc.base.timeoutMs,
        gasMultiplier: cfg.protocols.aerodromeMusdUsdc.execution.gasMultiplier,
      }, logger)

  logger.info({ mode: cfg.global.dryRun ? 'DRY_RUN' : 'LIVE' }, 'Executor initialised')

  // ── 引擎 ───────────────────────────────────────────────────────────────────
  const engine = new Engine({ db, executor, notifier, logger, ...(healthchecks != null && { healthchecks }) })

  // ── 注册协议 ───────────────────────────────────────────────────────────────
  if (cfg.protocols.aerodromeMusdUsdc.enabled) {
    const walletAddress = privateKeyToAccount(cfg.secrets.privateKey as `0x${string}`).address

    const aerodromeMonitor = new AerodromeMonitor(
      cfg.protocols.aerodromeMusdUsdc,
      coinGecko,
      deBank,
      rpc,
      walletAddress,
      logger,
      new SqliteHistoryStore(db),
    )
    engine.register(aerodromeMonitor)
    logger.info({ monitorId: aerodromeMonitor.id }, 'Protocol registered')
  }

  await engine.initAll()

  // ── 每日任务（数据保留清理 + 健康摘要）────────────────────────────────────
  scheduleDailyAt(cfg.notifications.email.dailySummaryHour, async () => {
    runRetentionCleanup(db, cfg.storage.retentionDays)
    logger.info('Data retention cleanup ran')
    const summary = buildDailySummary(db)
    await notifier.sendDailySummary(summary)
    logger.info('Daily summary email sent')
  })

  // ── 启动 ─────────────────────────────────────────────────────────────────────
  engine.start()
  logger.info('Engine started — monitoring active')

  // ── 优雅关闭 ─────────────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully...')
    await engine.stop()
    healthchecks?.stop()
    closeDb(db)
    logger.info('Shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  process.on('uncaughtException', err => {
    logger.error({ err }, 'Uncaught exception — continuing')
  })
  process.on('unhandledRejection', reason => {
    logger.error({ reason }, 'Unhandled rejection — continuing')
  })
}

function scheduleDailyAt(hour: number, fn: () => Promise<void>): void {
  let lastRanDay: number | null = null
  const checkAndRun = () => {
    // 使用上海时区判断小时，避免 launchd 环境下 TZ 不继承
    const parts = new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', hour12: false, day: 'numeric', timeZone: 'Asia/Shanghai' }).formatToParts(new Date())
    const nowHour = Number(parts.find(p => p.type === 'hour')?.value)
    const nowDay = Number(parts.find(p => p.type === 'day')?.value)
    if (nowHour === hour && lastRanDay !== nowDay) {
      lastRanDay = nowDay
      void fn()
    }
  }
  setInterval(checkAndRun, 30 * 60 * 1000)
}

function buildDailySummary(db: ReturnType<typeof openDb>): string {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  type AlertRow = { type: string; level: string; title: string; triggered_at: string }
  const alerts = db.prepare<[string], AlertRow>(
    `SELECT type, level, title, triggered_at FROM alerts WHERE triggered_at >= ? ORDER BY triggered_at DESC`,
  ).all(since)

  type ExecRow = { order_type: string; status: string; executed_at: string | null }
  const execs = db.prepare<[string], ExecRow>(
    `SELECT order_type, status, executed_at FROM executions WHERE created_at >= ? ORDER BY created_at DESC`,
  ).all(since)

  type PosRow = { net_usd_value: number; recorded_at: string }
  const latestPos = db.prepare<[], PosRow>(
    `SELECT net_usd_value, recorded_at FROM position_history ORDER BY recorded_at DESC LIMIT 1`,
  ).get()

  const lines: string[] = [`## DeFi Monitor 每日运营摘要 — ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`]

  if (latestPos != null) {
    lines.push(`**仓位净值（最新）**：$${latestPos.net_usd_value.toFixed(2)}（${latestPos.recorded_at}）\n`)
  }

  lines.push(`### 过去 24 小时告警（共 ${alerts.length} 条）\n`)
  if (alerts.length === 0) {
    lines.push('无告警，系统运行正常。\n')
  } else {
    for (const a of alerts) {
      lines.push(`- [${a.level}] ${a.type} — ${a.title}（${a.triggered_at}）`)
    }
    lines.push('')
  }

  lines.push(`### 过去 24 小时链上操作（共 ${execs.length} 笔）\n`)
  if (execs.length === 0) {
    lines.push('无链上操作。\n')
  } else {
    for (const e of execs) {
      lines.push(`- ${e.order_type} → ${e.status}（${e.executed_at ?? '—'}）`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
