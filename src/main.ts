// src/main.ts
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici'
import { privateKeyToAccount } from 'viem/accounts'
import { loadConfig } from './core/config.js'
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
  })
  const deBank = new DeBankClient({
    baseUrl: cfg.sources.debank.baseUrl,
    accessKey: cfg.secrets.debankAccessKey,
    timeoutMs: cfg.sources.debank.timeoutMs,
    retryAttempts: cfg.sources.debank.retryAttempts,
  })
  const rpc = new RpcClient({
    url: cfg.sources.rpc.base.url,
    timeoutMs: cfg.sources.rpc.base.timeoutMs,
  })

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
  const notifier = new Notifier(channels)

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
    )
    engine.register(aerodromeMonitor)
    logger.info({ monitorId: aerodromeMonitor.id }, 'Protocol registered')
  }

  await engine.initAll()

  // ── 每日任务（数据保留清理 + 健康摘要）────────────────────────────────────
  scheduleDailyAt(cfg.notifications.email.dailySummaryHour, async () => {
    runRetentionCleanup(db, cfg.storage.retentionDays)
    logger.info('Data retention cleanup ran')
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
  const checkAndRun = () => {
    if (new Date().getHours() === hour) void fn()
  }
  // 每 30 分钟检查一次
  setInterval(checkAndRun, 30 * 60 * 1000)
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
