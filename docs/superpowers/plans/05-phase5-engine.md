# Phase 5: Engine + Entry Point

Tasks 25–26. After this phase: `DRY_RUN=true npm start` runs the full bot — it polls, evaluates alerts, logs signals, and sends test notifications. Nothing executes on-chain.

---

## Task 25: Engine

**Files:**
- Create: `src/core/engine.ts`
- Test: `src/core/engine.test.ts`

The engine is the central orchestrator. It maintains one `setInterval` per registered monitor, prevents overlapping poll cycles, applies a per-monitor circuit breaker, processes alerts, dispatches execution orders, and stores results in SQLite.

- [ ] **Step 1: Write failing test**

```typescript
// src/core/engine.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Engine } from './engine.js'
import { AlertLevel, AlertType, OrderStatus, OrderType } from './types.js'
import type { Monitor, PollResult, Executor, ExecutionOrder, UnstakeParams } from './types.js'
import type { Notifier } from './notify/notifier.js'
import type Database from 'better-sqlite3'
import { openDb, closeDb } from './storage/index.js'
import { insertAlert } from './storage/queries.js'
import pino from 'pino'

const logger = pino({ level: 'silent' })

// ── Fakes ─────────────────────────────────────────────────────────────────────

function makeMonitor(id: string, result: Partial<PollResult> = {}): Monitor {
  return {
    id,
    name: id,
    pollIntervalMs: 10_000,
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({
      alerts: [],
      orders: [],
      health: { healthy: true, sources: {}, checkedAt: new Date() },
      ...result,
    }),
  }
}

function makeExecutor(): Executor {
  return { execute: vi.fn().mockResolvedValue({ status: OrderStatus.SKIPPED_DRY_RUN, executedAt: new Date() }) }
}

function makeNotifier(): Notifier {
  return { notifyAlert: vi.fn().mockResolvedValue(undefined), sendDailySummary: vi.fn(), testAll: vi.fn() } as never
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let db: Database.Database

beforeEach(() => { db = openDb(':memory:') })
afterEach(() => { closeDb(db) })

describe('Engine', () => {
  it('calls init on all registered monitors', async () => {
    const m1 = makeMonitor('m1')
    const m2 = makeMonitor('m2')
    const engine = new Engine({ db, executor: makeExecutor(), notifier: makeNotifier(), logger })
    engine.register(m1)
    engine.register(m2)
    await engine.initAll()
    expect(m1.init).toHaveBeenCalledOnce()
    expect(m2.init).toHaveBeenCalledOnce()
  })

  it('runCycle polls monitor and stores health snapshot', async () => {
    const monitor = makeMonitor('test')
    const engine = new Engine({ db, executor: makeExecutor(), notifier: makeNotifier(), logger })
    engine.register(monitor)
    await engine.initAll()
    await engine.runCycleForTest('test')
    expect(monitor.poll).toHaveBeenCalledOnce()
  })

  it('notifies on RED alert', async () => {
    const notifier = makeNotifier()
    const alert = {
      id: crypto.randomUUID(), type: AlertType.DEPEG, level: AlertLevel.RED,
      protocol: 'test', title: 'Depeg!', message: 'price fell', data: {},
      triggeredAt: new Date(), confirmations: 3, requiredConfirmations: 3, sustainedMs: 200_000, requiredSustainedMs: 180_000,
    }
    const monitor = makeMonitor('test', { alerts: [alert] })
    const engine = new Engine({ db, executor: makeExecutor(), notifier, logger })
    engine.register(monitor)
    await engine.initAll()
    await engine.runCycleForTest('test')
    expect(notifier.notifyAlert).toHaveBeenCalledWith(expect.objectContaining({ level: AlertLevel.RED }))
  })

  it('executes orders from RED alert in sequence', async () => {
    const executor = makeExecutor()
    const alertId = crypto.randomUUID()
    // Pre-insert alert (orders reference it)
    insertAlert(db, {
      id: alertId, type: AlertType.DEPEG, level: AlertLevel.RED, protocol: 'test',
      title: 'T', message: 'M', data: {}, triggeredAt: new Date(),
      confirmations: 3, requiredConfirmations: 3, sustainedMs: 200_000, requiredSustainedMs: 180_000,
    })
    const orders: ExecutionOrder[] = [
      { id: 'o1', alertId, protocol: 'test', type: OrderType.UNSTAKE, sequence: 1, groupId: 'g1', params: { gaugeAddress: '0x1', tokenId: 1n } as UnstakeParams, maxGasGwei: 50, deadline: 9999999999, status: OrderStatus.PENDING, createdAt: new Date() },
      { id: 'o2', alertId, protocol: 'test', type: OrderType.UNSTAKE, sequence: 2, groupId: 'g1', params: { gaugeAddress: '0x1', tokenId: 1n } as UnstakeParams, maxGasGwei: 50, deadline: 9999999999, status: OrderStatus.PENDING, createdAt: new Date() },
    ]
    const monitor = makeMonitor('test', { alerts: [], orders })
    const engine = new Engine({ db, executor, notifier: makeNotifier(), logger })
    engine.register(monitor)
    await engine.initAll()
    await engine.runCycleForTest('test')
    expect(executor.execute).toHaveBeenCalledTimes(2)
    // Verify sequence: o1 before o2
    const calls = vi.mocked(executor.execute).mock.calls
    expect((calls[0]?.[0] as ExecutionOrder).sequence).toBe(1)
    expect((calls[1]?.[0] as ExecutionOrder).sequence).toBe(2)
  })

  it('stops executing remaining orders in group if one fails', async () => {
    const executor = makeExecutor()
    vi.mocked(executor.execute)
      .mockResolvedValueOnce({ status: OrderStatus.FAILED, error: 'reverted', executedAt: new Date() })
      .mockResolvedValueOnce({ status: OrderStatus.CONFIRMED, executedAt: new Date() })

    const alertId = crypto.randomUUID()
    insertAlert(db, {
      id: alertId, type: AlertType.DEPEG, level: AlertLevel.RED, protocol: 'test',
      title: 'T', message: 'M', data: {}, triggeredAt: new Date(),
      confirmations: 3, requiredConfirmations: 3, sustainedMs: 200_000, requiredSustainedMs: 180_000,
    })
    const orders: ExecutionOrder[] = [
      { id: 'o1', alertId, protocol: 'test', type: OrderType.UNSTAKE, sequence: 1, groupId: 'g1', params: { gaugeAddress: '0x1', tokenId: 1n } as UnstakeParams, maxGasGwei: 50, deadline: 9999999999, status: OrderStatus.PENDING, createdAt: new Date() },
      { id: 'o2', alertId, protocol: 'test', type: OrderType.UNSTAKE, sequence: 2, groupId: 'g1', params: { gaugeAddress: '0x1', tokenId: 1n } as UnstakeParams, maxGasGwei: 50, deadline: 9999999999, status: OrderStatus.PENDING, createdAt: new Date() },
    ]
    const monitor = makeMonitor('test', { orders })
    const engine = new Engine({ db, executor, notifier: makeNotifier(), logger })
    engine.register(monitor)
    await engine.initAll()
    await engine.runCycleForTest('test')
    // Second order should NOT be executed because first failed
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  it('applies circuit breaker after 5 consecutive poll failures', async () => {
    const monitor = makeMonitor('test')
    vi.mocked(monitor.poll).mockRejectedValue(new Error('poll failed'))
    const notifier = makeNotifier()
    const engine = new Engine({ db, executor: makeExecutor(), notifier, logger })
    engine.register(monitor)
    await engine.initAll()
    for (let i = 0; i < 5; i++) {
      await engine.runCycleForTest('test')
    }
    // After 5 failures, circuit opens → DATA_SOURCE_FAILURE alert sent
    expect(notifier.notifyAlert).toHaveBeenCalledWith(
      expect.objectContaining({ type: AlertType.DATA_SOURCE_FAILURE }),
    )
  })

  it('does not run overlapping cycles for the same monitor', async () => {
    const monitor = makeMonitor('test')
    let resolvePoll: () => void
    vi.mocked(monitor.poll).mockReturnValue(new Promise(resolve => {
      resolvePoll = () => resolve({ alerts: [], orders: [], health: { healthy: true, sources: {}, checkedAt: new Date() } })
    }))

    const engine = new Engine({ db, executor: makeExecutor(), notifier: makeNotifier(), logger })
    engine.register(monitor)
    await engine.initAll()

    // Start two cycles concurrently
    const p1 = engine.runCycleForTest('test')
    const p2 = engine.runCycleForTest('test') // should be skipped (cycle already running)
    resolvePoll!()
    await Promise.all([p1, p2])

    expect(monitor.poll).toHaveBeenCalledOnce() // only once, not twice
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/engine.test.ts
```

- [ ] **Step 3: Create src/core/engine.ts**

```typescript
// src/core/engine.ts
import { AlertLevel, AlertType, OrderStatus } from './types.js'
import type { Monitor, Alert, ExecutionOrder, Executor } from './types.js'
import type { Notifier } from './notify/notifier.js'
import type { HealthchecksMonitor } from './notify/healthchecks.js'
import { insertAlert, insertExecution, insertHealthSnapshot } from './storage/queries.js'
import type Database from 'better-sqlite3'
import type pino from 'pino'

interface EngineConfig {
  db: Database.Database
  executor: Executor
  notifier: Notifier
  logger: pino.Logger
  healthchecks?: HealthchecksMonitor
}

interface RegisteredMonitor {
  monitor: Monitor
  running: boolean
  consecutiveFailures: number
  timer: ReturnType<typeof setInterval> | null
  paused: boolean
}

const MAX_CONSECUTIVE_FAILURES = 5
const PAUSE_DURATION_MS = 5 * 60 * 1000  // 5 minutes

export class Engine {
  private readonly monitors = new Map<string, RegisteredMonitor>()

  constructor(private readonly cfg: EngineConfig) {}

  register(monitor: Monitor): void {
    this.monitors.set(monitor.id, {
      monitor,
      running: false,
      consecutiveFailures: 0,
      timer: null,
      paused: false,
    })
  }

  async initAll(): Promise<void> {
    for (const { monitor } of this.monitors.values()) {
      await monitor.init()
    }
  }

  start(): void {
    for (const [id, reg] of this.monitors) {
      // Run first cycle immediately, then on interval
      void this.runCycle(id)
      reg.timer = setInterval(() => void this.runCycle(id), reg.monitor.pollIntervalMs)
    }
  }

  async stop(): Promise<void> {
    for (const reg of this.monitors.values()) {
      if (reg.timer) clearInterval(reg.timer)
      await reg.monitor.shutdown()
    }
  }

  /** Exposed for testing only */
  async runCycleForTest(monitorId: string): Promise<void> {
    await this.runCycle(monitorId)
  }

  private async runCycle(monitorId: string): Promise<void> {
    const reg = this.monitors.get(monitorId)
    if (!reg) return
    if (reg.running || reg.paused) return

    reg.running = true
    try {
      const result = await reg.monitor.poll()
      reg.consecutiveFailures = 0

      // Store health
      insertHealthSnapshot(this.cfg.db, monitorId, result.health)

      // Process alerts
      for (const alert of result.alerts) {
        insertAlert(this.cfg.db, alert)
        if (alert.level === AlertLevel.RED || alert.level === AlertLevel.WARNING) {
          await this.cfg.notifier.notifyAlert(alert)
        }
      }

      // Execute orders (sequential within group, abort on failure)
      if (result.orders.length > 0) {
        await this.executeOrderGroup(result.orders)
      }
    } catch (err) {
      reg.consecutiveFailures++
      this.cfg.logger.error({ monitorId, err, consecutiveFailures: reg.consecutiveFailures }, 'Monitor poll failed')

      if (reg.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await this.cfg.notifier.notifyAlert(this.makeDataSourceFailureAlert(monitorId, err))
        this.pauseMonitor(reg)
      }
    } finally {
      reg.running = false
    }
  }

  private async executeOrderGroup(orders: ExecutionOrder[]): Promise<void> {
    const sorted = [...orders].sort((a, b) => a.sequence - b.sequence)
    for (const order of sorted) {
      const result = await this.cfg.executor.execute(order)
      insertExecution(this.cfg.db, order, result)

      if (result.status === OrderStatus.FAILED) {
        this.cfg.logger.error({ orderId: order.id, error: result.error }, 'Order failed — aborting group')
        await this.cfg.notifier.notifyAlert(this.makeExecutionFailureAlert(order, result.error))
        break // abort remaining orders in this group
      }
    }
  }

  private pauseMonitor(reg: RegisteredMonitor): void {
    reg.paused = true
    this.cfg.logger.warn({ monitorId: reg.monitor.id }, `Monitor paused for ${PAUSE_DURATION_MS / 60_000} minutes after circuit open`)
    setTimeout(() => {
      reg.paused = false
      reg.consecutiveFailures = 0
      this.cfg.logger.info({ monitorId: reg.monitor.id }, 'Monitor resumed after pause')
    }, PAUSE_DURATION_MS)
  }

  private makeDataSourceFailureAlert(monitorId: string, err: unknown): Alert {
    return {
      id: crypto.randomUUID(),
      type: AlertType.DATA_SOURCE_FAILURE,
      level: AlertLevel.RED,
      protocol: monitorId,
      title: `Monitor failure: ${monitorId}`,
      message: `Monitor has failed ${MAX_CONSECUTIVE_FAILURES} consecutive times and is now paused for 5 minutes.\n\n**Last error:** ${err instanceof Error ? err.message : String(err)}`,
      data: { consecutiveFailures: MAX_CONSECUTIVE_FAILURES, error: String(err) },
      triggeredAt: new Date(),
      confirmations: 1,
      requiredConfirmations: 1,
      sustainedMs: 0,
      requiredSustainedMs: 0,
    }
  }

  private makeExecutionFailureAlert(order: ExecutionOrder, error?: string): Alert {
    return {
      id: crypto.randomUUID(),
      type: AlertType.DATA_SOURCE_FAILURE,
      level: AlertLevel.RED,
      protocol: order.protocol,
      title: `Execution failed: ${order.type} (group ${order.groupId})`,
      message: `Order ${order.id} (${order.type}, sequence ${order.sequence}) failed. Remaining orders in group aborted.\n\n**Error:** ${error ?? 'unknown'}`,
      data: { orderId: order.id, type: order.type, sequence: order.sequence, groupId: order.groupId, error },
      triggeredAt: new Date(),
      confirmations: 1,
      requiredConfirmations: 1,
      sustainedMs: 0,
      requiredSustainedMs: 0,
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/core/engine.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Full suite**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/core/engine.ts src/core/engine.test.ts
git commit -m "feat: add engine (poll orchestration, circuit breaker, sequential execution)"
```

---

## Task 26: Entry Point

**Files:**
- Create: `src/main.ts`

No unit tests — verified by running `DRY_RUN=true npm start` and observing logs.

- [ ] **Step 1: Create src/main.ts**

> Use this complete, corrected version (the dynamic import version in Step 2 is superseded by this).

```typescript
// src/main.ts
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { Engine } from './core/engine.js'
import { AerodromeMonitor } from './protocols/aerodrome/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

async function main(): Promise<void> {
  // ── Config ──────────────────────────────────────────────────────────────────
  const cfg = loadConfig(
    resolve(ROOT, 'configs', 'monitor.yaml'),
    resolve(ROOT, 'configs', '.env'),
  )
  const logger = initLogger(cfg.global.logLevel)

  logger.info({ dryRun: cfg.global.dryRun }, 'DeFi Monitor starting')

  // ── Storage ─────────────────────────────────────────────────────────────────
  const db = openDb(resolve(ROOT, cfg.storage.sqlitePath))
  logger.info({ path: cfg.storage.sqlitePath }, 'SQLite database opened')

  // ── Clients ─────────────────────────────────────────────────────────────────
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

  // ── Notifications ────────────────────────────────────────────────────────────
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

  // Test notification channels at startup
  const testResults = await notifier.testAll()
  logger.info({ channels: testResults }, 'Notification channel test results')

  // ── Healthchecks ─────────────────────────────────────────────────────────────
  let healthchecks: HealthchecksMonitor | undefined
  if (cfg.notifications.healthchecks.enabled) {
    healthchecks = new HealthchecksMonitor(
      cfg.notifications.healthchecks.pingUrl,
      cfg.notifications.healthchecks.intervalSeconds,
      logger,
    )
    healthchecks.start()
  }

  // ── Executor ─────────────────────────────────────────────────────────────────
  const executor = cfg.global.dryRun
    ? new DryRunExecutor(logger)
    : new LiveExecutor({
        privateKey: cfg.secrets.privateKey,
        rpcUrl: cfg.sources.rpc.base.url,
        rpcTimeoutMs: cfg.sources.rpc.base.timeoutMs,
        gasMultiplier: cfg.protocols.aerodromeMusdUsdc.execution.gasMultiplier,
      }, logger)

  logger.info({ mode: cfg.global.dryRun ? 'DRY_RUN' : 'LIVE' }, 'Executor initialised')

  // ── Engine ───────────────────────────────────────────────────────────────────
  const engine = new Engine({ db, executor, notifier, logger, healthchecks })

  // ── Register Protocols ───────────────────────────────────────────────────────
  if (cfg.protocols.aerodromeMusdUsdc.enabled) {
    // Derive wallet address from private key (used for collect() recipient and DeBank queries).
    // In DRY_RUN mode no signing occurs, but we still need a valid address.
    // Use a dummy private key (0x000...001) in .env for DRY_RUN testing.
    const walletAddress = privateKeyToAccount(cfg.secrets.privateKey as `0x${string}`).address

    const aerodromeMonitor = new AerodromeMonitor(
      cfg.protocols.aerodromeMusdUsdc,
      coinGecko,
      deBank,
      rpc,
      walletAddress,
    )
    engine.register(aerodromeMonitor)
    logger.info({ monitorId: aerodromeMonitor.id }, 'Protocol registered')
  }

  await engine.initAll()

  // ── Daily Tasks (data retention + health summary) ────────────────────────────
  scheduleDailyAt(cfg.notifications.email.dailySummaryHour, async () => {
    runRetentionCleanup(db, cfg.storage.retentionDays)
    logger.info('Data retention cleanup ran')
    // TODO in future: build daily summary from DB and send via notifier.sendDailySummary()
  })

  // ── Start ─────────────────────────────────────────────────────────────────────
  engine.start()
  logger.info('Engine started — monitoring active')

  // ── Graceful Shutdown ─────────────────────────────────────────────────────────
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
  // Check every 30 minutes
  setInterval(checkAndRun, 30 * 60 * 1000)
}

main().catch(err => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
```

> **Note:** The `await import('viem/accounts')` inside the arrow function uses a dynamic import to avoid top-level await issues. For a cleaner approach, import at the top level and compute the address unconditionally (even in DRY_RUN mode).

**Simplified wallet address resolution (replace the walletAddress block above):**

```typescript
// At top of file
import { privateKeyToAccount } from 'viem/accounts'

// Inside main(), after executor setup:
const walletAddress = cfg.protocols.aerodromeMusdUsdc.enabled
  ? privateKeyToAccount(cfg.secrets.privateKey as `0x${string}`).address
  : '0x0000000000000000000000000000000000000000' as `0x${string}`
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Smoke test in DRY_RUN mode**

First, copy `.env.example` to `.env` and fill in real API keys:

```bash
cp configs/.env.example configs/.env
# Edit configs/.env with real keys
# Set monitor.yaml: global.dry_run: true
# Set monitor.yaml: aerodrome_msusd_usdc.lp_token_id: YOUR_TOKEN_ID
# Fill in pool_address, gauge_address, msusd_address from Basescan/Aerodrome UI
```

Run:

```bash
npm run dev
```

Expected in logs:
```
INFO: DeFi Monitor starting {"dryRun":true}
INFO: SQLite database opened
INFO: Notification channel test results {"channels":{...}}
INFO: Executor initialised {"mode":"DRY_RUN"}
INFO: Protocol registered {"monitorId":"aerodrome-msusd-usdc"}
INFO: Engine started — monitoring active
```

After first poll (~10s):
```
INFO: price signal fetched {"coingecko":1.0001,"twap":1.0001}
INFO: no alerts triggered
```

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: add main entry point with graceful shutdown and DRY_RUN mode"
```

---

## Phase 5 Checkpoint

```bash
npm run typecheck && npm test
# Then:
npm run dev
```

Bot starts, polls all monitors, logs signals, no on-chain transactions in DRY_RUN mode. All tests remain green.
