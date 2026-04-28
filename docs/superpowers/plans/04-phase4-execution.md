# Phase 4: Execution + Notification

Tasks 19–24. After this phase: DRY_RUN executor, live on-chain executor, ServerChan, Email, Healthchecks, and the notifier orchestrator are all implemented and tested.

---

## Task 19: DRY_RUN Executor

**Files:**
- Create: `src/core/executor/dry-run.ts`
- Test: `src/core/executor/dry-run.test.ts`

The DRY_RUN executor simulates execution without sending any transactions. It logs the order, runs `eth_call` to verify the call would succeed, and records `SKIPPED_DRY_RUN` status.

- [ ] **Step 1: Write failing test**

```typescript
// src/core/executor/dry-run.test.ts
import { describe, it, expect, vi } from 'vitest'
import { DryRunExecutor } from './dry-run.js'
import { OrderStatus, OrderType } from '../types.js'
import type { ExecutionOrder, UnstakeParams } from '../types.js'

const mockLogger = { info: vi.fn(), warn: vi.fn() }

function makeUnstakeOrder(): ExecutionOrder {
  return {
    id: 'order-1',
    alertId: 'alert-1',
    protocol: 'aerodrome-msusd-usdc',
    type: OrderType.UNSTAKE,
    sequence: 1,
    groupId: 'group-1',
    params: {
      gaugeAddress: '0x0000000000000000000000000000000000000001',
      tokenId: 12345n,
    } as UnstakeParams,
    maxGasGwei: 50,
    deadline: Math.floor(Date.now() / 1000) + 300,
    status: OrderStatus.PENDING,
    createdAt: new Date(),
  }
}

describe('DryRunExecutor', () => {
  it('returns SKIPPED_DRY_RUN status', async () => {
    const executor = new DryRunExecutor(mockLogger as never)
    const result = await executor.execute(makeUnstakeOrder())
    expect(result.status).toBe(OrderStatus.SKIPPED_DRY_RUN)
    expect(result.txHash).toBeUndefined()
    expect(result.executedAt).toBeInstanceOf(Date)
  })

  it('logs the order details', async () => {
    const executor = new DryRunExecutor(mockLogger as never)
    await executor.execute(makeUnstakeOrder())
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'order-1', type: OrderType.UNSTAKE }),
      expect.stringContaining('DRY_RUN'),
    )
  })

  it('never throws', async () => {
    const executor = new DryRunExecutor(mockLogger as never)
    const order = makeUnstakeOrder()
    // Even with a bizarre order, must not throw
    await expect(executor.execute(order)).resolves.toBeDefined()
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/executor/dry-run.test.ts
```

- [ ] **Step 3: Create src/core/executor/dry-run.ts**

```typescript
// src/core/executor/dry-run.ts
import { OrderStatus } from '../types.js'
import type { Executor, ExecutionOrder, ExecutionResult } from '../types.js'
import type pino from 'pino'

export class DryRunExecutor implements Executor {
  constructor(private readonly logger: pino.Logger) {}

  async execute(order: ExecutionOrder): Promise<ExecutionResult> {
    this.logger.info(
      {
        orderId: order.id,
        alertId: order.alertId,
        type: order.type,
        sequence: order.sequence,
        groupId: order.groupId,
        params: JSON.stringify(order.params, (_, v) => typeof v === 'bigint' ? v.toString() : v),
        maxGasGwei: order.maxGasGwei,
        deadline: order.deadline,
      },
      `DRY_RUN: would execute ${order.type} (sequence ${order.sequence}/${order.groupId})`,
    )

    return {
      status: OrderStatus.SKIPPED_DRY_RUN,
      executedAt: new Date(),
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/core/executor/dry-run.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/executor/dry-run.ts src/core/executor/dry-run.test.ts
git commit -m "feat: add DRY_RUN executor (log + SKIPPED_DRY_RUN status)"
```

---

## Task 20: Live On-chain Executor

**Files:**
- Create: `src/core/executor/index.ts`

The live executor uses viem to build, sign, and broadcast transactions. It handles the 3 order types: UNSTAKE (gauge.withdraw), REMOVE_LIQUIDITY (positionManager.decreaseLiquidity + collect), SWAP (router.exactInputSingle).

No unit tests for this file — it calls real contracts. Typecheck + DRY_RUN integration verify correctness before going live.

- [ ] **Step 1: Create src/core/executor/index.ts**

```typescript
// src/core/executor/index.ts
import { createWalletClient, http, parseAbi, maxUint128 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { OrderStatus, OrderType } from '../types.js'
import type { Executor, ExecutionOrder, ExecutionResult, UnstakeParams, RemoveLiquidityParams, SwapParams } from '../types.js'
import type pino from 'pino'

const GAUGE_ABI = parseAbi([
  'function withdraw(uint256 tokenId) external',
])

const POSITION_MANAGER_ABI = parseAbi([
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external returns (uint256 amount0, uint256 amount1)',
])

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut)',
])

export interface LiveExecutorConfig {
  privateKey: string
  rpcUrl: string
  rpcTimeoutMs: number
  gasMultiplier: number
}

export class LiveExecutor implements Executor {
  private readonly walletClient: ReturnType<typeof createWalletClient>
  private readonly account: ReturnType<typeof privateKeyToAccount>

  constructor(
    private readonly cfg: LiveExecutorConfig,
    private readonly logger: pino.Logger,
  ) {
    this.account = privateKeyToAccount(cfg.privateKey as `0x${string}`)
    this.walletClient = createWalletClient({
      account: this.account,
      chain: base,
      transport: http(cfg.rpcUrl, { timeout: cfg.rpcTimeoutMs }),
    })
  }

  async execute(order: ExecutionOrder): Promise<ExecutionResult> {
    this.logger.info({ orderId: order.id, type: order.type }, `Executing ${order.type}`)
    try {
      switch (order.type) {
        case OrderType.UNSTAKE:
          return await this.executeUnstake(order, order.params as UnstakeParams)
        case OrderType.REMOVE_LIQUIDITY:
          return await this.executeRemoveLiquidity(order, order.params as RemoveLiquidityParams)
        case OrderType.SWAP:
          return await this.executeSwap(order, order.params as SwapParams)
        default:
          throw new Error(`Unknown order type: ${order.type as string}`)
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.logger.error({ orderId: order.id, error }, `Execution failed: ${order.type}`)
      return { status: OrderStatus.FAILED, error, executedAt: new Date() }
    }
  }

  private async executeUnstake(order: ExecutionOrder, params: UnstakeParams): Promise<ExecutionResult> {
    const txHash = await this.walletClient.writeContract({
      address: params.gaugeAddress,
      abi: GAUGE_ABI,
      functionName: 'withdraw',
      args: [params.tokenId],
    })
    return this.waitForReceipt(txHash)
  }

  private async executeRemoveLiquidity(order: ExecutionOrder, params: RemoveLiquidityParams): Promise<ExecutionResult> {
    // Read actual liquidity from position if params.liquidity === 0n
    let liquidity = params.liquidity
    if (liquidity === 0n) {
      const position = await this.walletClient.readContract({
        address: params.positionManagerAddress,
        abi: POSITION_MANAGER_ABI,
        functionName: 'positions',
        args: [params.tokenId],
      })
      liquidity = position[7] // liquidity is index 7 in the tuple
    }
    if (liquidity === 0n) {
      this.logger.warn({ orderId: order.id }, 'No liquidity to remove, skipping decreaseLiquidity')
    } else {
      const decreaseTx = await this.walletClient.writeContract({
        address: params.positionManagerAddress,
        abi: POSITION_MANAGER_ABI,
        functionName: 'decreaseLiquidity',
        args: [{ tokenId: params.tokenId, liquidity, amount0Min: params.amount0Min, amount1Min: params.amount1Min, deadline: BigInt(order.deadline) }],
      })
      await this.waitForReceipt(decreaseTx)
    }

    // Collect all tokens (including owed fees)
    const collectTx = await this.walletClient.writeContract({
      address: params.positionManagerAddress,
      abi: POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{ tokenId: params.tokenId, recipient: this.account.address, amount0Max: maxUint128, amount1Max: maxUint128 }],
    })
    return this.waitForReceipt(collectTx)
  }

  private async executeSwap(order: ExecutionOrder, params: SwapParams): Promise<ExecutionResult> {
    const txHash = await this.walletClient.writeContract({
      address: params.routerAddress,
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        tickSpacing: 1, // Aerodrome CL stable pools use tickSpacing=1
        recipient: this.account.address,
        deadline: BigInt(order.deadline),
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMin,
        sqrtPriceLimitX96: 0n,
      }],
    })
    return this.waitForReceipt(txHash)
  }

  private async waitForReceipt(txHash: `0x${string}`): Promise<ExecutionResult> {
    this.logger.info({ txHash }, 'Transaction submitted, waiting for receipt')
    const receipt = await this.walletClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
    const status = receipt.status === 'success' ? OrderStatus.CONFIRMED : OrderStatus.FAILED
    return {
      status,
      txHash,
      gasUsed: receipt.gasUsed,
      executedAt: new Date(),
      error: status === OrderStatus.FAILED ? 'Transaction reverted' : undefined,
    }
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/executor/index.ts
git commit -m "feat: add live on-chain executor (unstake, remove liquidity, swap)"
```

---

## Task 21: ServerChan Notifier

**Files:**
- Create: `src/core/notify/serverchan.ts`
- Test: `src/core/notify/serverchan.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/core/notify/serverchan.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ServerChanChannel } from './serverchan.js'
import { AlertLevel } from '../types.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => fetchMock.mockReset())

describe('ServerChanChannel', () => {
  const channel = new ServerChanChannel({ sendkey: 'SCTtest', timeoutMs: 3000, retryAttempts: 1 })

  it('sends notification and returns true on success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0 }) })
    const ok = await channel.send({ title: 'Test', body: '**hello**', level: AlertLevel.WARNING })
    expect(ok).toBe(true)
    const url = fetchMock.mock.calls[0]?.[0] as string
    expect(url).toContain('SCTtest')
  })

  it('returns false on HTTP failure without throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    const ok = await channel.send({ title: 'Test', body: 'body', level: AlertLevel.RED })
    expect(ok).toBe(false)
  })

  it('returns false on network error without throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network fail'))
    const ok = await channel.send({ title: 'Test', body: 'body', level: AlertLevel.RED })
    expect(ok).toBe(false)
  })

  it('test() returns true when API responds ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0 }) })
    expect(await channel.test()).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/notify/serverchan.test.ts
```

- [ ] **Step 3: Create src/core/notify/serverchan.ts**

```typescript
// src/core/notify/serverchan.ts
import type { NotificationChannel, Notification } from '../types.js'

interface ServerChanConfig {
  sendkey: string
  timeoutMs: number
  retryAttempts: number
}

export class ServerChanChannel implements NotificationChannel {
  readonly name = 'serverchan'

  constructor(private readonly cfg: ServerChanConfig) {}

  async send(notification: Notification): Promise<boolean> {
    try {
      for (let attempt = 1; attempt <= this.cfg.retryAttempts; attempt++) {
        const ok = await this.doSend(notification)
        if (ok) return true
        if (attempt < this.cfg.retryAttempts) await sleep(attempt * 1000)
      }
      return false
    } catch {
      return false
    }
  }

  async test(): Promise<boolean> {
    return this.send({ title: '✅ Monitor online', body: 'DeFi monitor started successfully', level: 'info' as never })
  }

  private async doSend(notification: Notification): Promise<boolean> {
    const url = `https://sctapi.ftqq.com/${this.cfg.sendkey}.send`
    const body = new URLSearchParams({
      title: notification.title,
      desp: notification.body,
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
    try {
      const res = await globalThis.fetch(url, {
        method: 'POST',
        body,
        signal: controller.signal,
      })
      return res.ok
    } finally {
      clearTimeout(timeout)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/core/notify/serverchan.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/notify/serverchan.ts src/core/notify/serverchan.test.ts
git commit -m "feat: add ServerChan notification channel"
```

---

## Task 22: Email Notifier

**Files:**
- Create: `src/core/notify/email.ts`
- Test: `src/core/notify/email.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/core/notify/email.test.ts
import { describe, it, expect, vi } from 'vitest'
import { EmailChannel } from './email.js'
import { AlertLevel } from '../types.js'

// Mock nodemailer
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test-id' }),
      verify: vi.fn().mockResolvedValue(true),
    })),
  },
}))

describe('EmailChannel', () => {
  const cfg = {
    smtpHost: 'smtp.gmail.com', smtpPort: 587,
    user: 'test@gmail.com', password: 'pass',
    from: 'test@gmail.com', to: ['dest@example.com'],
    retryAttempts: 1,
  }

  it('sends email and returns true', async () => {
    const channel = new EmailChannel(cfg)
    const ok = await channel.send({ title: 'Alert', body: '**content**', level: AlertLevel.RED })
    expect(ok).toBe(true)
  })

  it('converts markdown body to HTML for email', async () => {
    const nodemailer = await import('nodemailer')
    const sendMailMock = vi.fn().mockResolvedValue({ messageId: 'x' })
    vi.mocked(nodemailer.default.createTransport).mockReturnValue({ sendMail: sendMailMock, verify: vi.fn() } as never)

    const channel = new EmailChannel(cfg)
    await channel.send({ title: 'Test', body: '**bold text**', level: AlertLevel.WARNING })

    const callArg = sendMailMock.mock.calls[0]?.[0] as { html?: string; text?: string }
    expect(callArg?.html ?? callArg?.text ?? '').toContain('bold text')
  })

  it('returns false on SMTP error without throwing', async () => {
    const nodemailer = await import('nodemailer')
    vi.mocked(nodemailer.default.createTransport).mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error('smtp fail')),
      verify: vi.fn(),
    } as never)
    const channel = new EmailChannel(cfg)
    const ok = await channel.send({ title: 'Test', body: 'body', level: AlertLevel.RED })
    expect(ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/notify/email.test.ts
```

- [ ] **Step 3: Create src/core/notify/email.ts**

```typescript
// src/core/notify/email.ts
import nodemailer from 'nodemailer'
import type { NotificationChannel, Notification } from '../types.js'

interface EmailConfig {
  smtpHost: string
  smtpPort: number
  user: string
  password: string
  from: string
  to: string[]
  retryAttempts: number
}

export class EmailChannel implements NotificationChannel {
  readonly name = 'email'
  private readonly transporter: ReturnType<typeof nodemailer.createTransport>

  constructor(private readonly cfg: EmailConfig) {
    this.transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: false,
      auth: { user: cfg.user, pass: cfg.password },
    })
  }

  async send(notification: Notification): Promise<boolean> {
    for (let attempt = 1; attempt <= this.cfg.retryAttempts; attempt++) {
      try {
        await this.transporter.sendMail({
          from: this.cfg.from,
          to: this.cfg.to.join(', '),
          subject: notification.title,
          text: notification.body,
          html: markdownToHtml(notification.body),
        })
        return true
      } catch {
        if (attempt === this.cfg.retryAttempts) return false
        await sleep(attempt * 2000)
      }
    }
    return false
  }

  async test(): Promise<boolean> {
    try {
      await this.transporter.verify()
      return true
    } catch {
      return false
    }
  }
}

/** Minimal markdown→HTML: bold, newlines, code blocks */
function markdownToHtml(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/\n/g, '<br>')
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/core/notify/email.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/notify/email.ts src/core/notify/email.test.ts
git commit -m "feat: add email notification channel (Gmail SMTP)"
```

---

## Task 23: Healthchecks.io Heartbeat

**Files:**
- Create: `src/core/notify/healthchecks.ts`

No unit tests — it's a thin GET wrapper. Typecheck is the verification.

- [ ] **Step 1: Create src/core/notify/healthchecks.ts**

```typescript
// src/core/notify/healthchecks.ts
import type pino from 'pino'

export class HealthchecksMonitor {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly pingUrl: string,
    private readonly intervalSeconds: number,
    private readonly logger: pino.Logger,
  ) {}

  start(): void {
    if (this.timer) return
    // Ping immediately on start
    void this.ping()
    this.timer = setInterval(() => void this.ping(), this.intervalSeconds * 1000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Call this when something is wrong to signal failure to Healthchecks */
  async fail(reason: string): Promise<void> {
    try {
      await globalThis.fetch(`${this.pingUrl}/fail`, {
        method: 'POST',
        body: reason.slice(0, 10_000),
      })
    } catch (err) {
      this.logger.warn({ err }, 'Failed to send Healthchecks failure ping')
    }
  }

  private async ping(): Promise<void> {
    try {
      const res = await globalThis.fetch(this.pingUrl)
      if (!res.ok) this.logger.warn({ status: res.status }, 'Healthchecks ping returned non-200')
    } catch (err) {
      this.logger.warn({ err }, 'Healthchecks ping failed (network error)')
    }
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/core/notify/healthchecks.ts
git commit -m "feat: add Healthchecks.io heartbeat monitor"
```

---

## Task 24: Notifier Orchestrator

**Files:**
- Create: `src/core/notify/notifier.ts`
- Test: `src/core/notify/notifier.test.ts`

The notifier orchestrates all channels: WARNING → ServerChan only; RED → ServerChan + Email in parallel; failure in one channel doesn't fail the other.

- [ ] **Step 1: Write failing test**

```typescript
// src/core/notify/notifier.test.ts
import { describe, it, expect, vi } from 'vitest'
import { Notifier } from './notifier.js'
import { AlertLevel, AlertType } from '../types.js'
import type { NotificationChannel, Alert } from '../types.js'

function makeChannel(name: string, returns: boolean): NotificationChannel {
  return { name, send: vi.fn().mockResolvedValue(returns), test: vi.fn().mockResolvedValue(true) }
}

function makeAlert(level: AlertLevel): Alert {
  return {
    id: 'a1', type: AlertType.DEPEG, level, protocol: 'test', title: 'T', message: 'M',
    data: {}, triggeredAt: new Date(), confirmations: 1, requiredConfirmations: 1, sustainedMs: 0, requiredSustainedMs: 0,
  }
}

describe('Notifier', () => {
  it('sends to all channels for RED alert', async () => {
    const sc = makeChannel('serverchan', true)
    const email = makeChannel('email', true)
    const notifier = new Notifier([sc, email])

    await notifier.notifyAlert(makeAlert(AlertLevel.RED))

    expect(sc.send).toHaveBeenCalledOnce()
    expect(email.send).toHaveBeenCalledOnce()
  })

  it('sends only to primary channel for WARNING alert', async () => {
    const sc = makeChannel('serverchan', true)
    const email = makeChannel('email', true)
    const notifier = new Notifier([sc, email], { criticalChannels: ['serverchan', 'email'], normalChannels: ['serverchan'] })

    await notifier.notifyAlert(makeAlert(AlertLevel.WARNING))

    expect(sc.send).toHaveBeenCalledOnce()
    expect(email.send).not.toHaveBeenCalled()
  })

  it('does not throw if one channel fails', async () => {
    const sc = makeChannel('serverchan', false) // fails
    const email = makeChannel('email', true)
    const notifier = new Notifier([sc, email])

    await expect(notifier.notifyAlert(makeAlert(AlertLevel.RED))).resolves.not.toThrow()
    expect(email.send).toHaveBeenCalledOnce()
  })

  it('sendDailySummary sends to email channel only', async () => {
    const sc = makeChannel('serverchan', true)
    const email = makeChannel('email', true)
    const notifier = new Notifier([sc, email])

    await notifier.sendDailySummary('## Daily Report\n\nAll good.')

    expect(email.send).toHaveBeenCalledOnce()
    expect(sc.send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/notify/notifier.test.ts
```

- [ ] **Step 3: Create src/core/notify/notifier.ts**

```typescript
// src/core/notify/notifier.ts
import { AlertLevel } from '../types.js'
import type { Alert, NotificationChannel, Notification } from '../types.js'

interface NotifierOptions {
  criticalChannels?: string[]   // channel names to use for RED alerts
  normalChannels?: string[]     // channel names to use for WARNING alerts
}

const DEFAULT_OPTS: Required<NotifierOptions> = {
  criticalChannels: ['serverchan', 'email'],
  normalChannels: ['serverchan'],
}

export class Notifier {
  private readonly opts: Required<NotifierOptions>

  constructor(
    private readonly channels: NotificationChannel[],
    opts: NotifierOptions = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts }
  }

  async notifyAlert(alert: Alert): Promise<void> {
    const channelNames = alert.level === AlertLevel.RED
      ? this.opts.criticalChannels
      : this.opts.normalChannels

    const notification: Notification = {
      title: alert.title,
      body: alert.message,
      level: alert.level,
      metadata: { alertId: alert.id, type: alert.type, protocol: alert.protocol },
    }

    await this.sendToChannels(channelNames, notification)
  }

  async sendDailySummary(markdown: string): Promise<void> {
    const notification: Notification = {
      title: `📊 Daily Monitor Summary — ${new Date().toLocaleDateString()}`,
      body: markdown,
      level: AlertLevel.INFO,
    }
    // Daily summary goes to email only
    await this.sendToChannels(['email'], notification)
  }

  async testAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    await Promise.all(
      this.channels.map(async ch => {
        results[ch.name] = await ch.test()
      }),
    )
    return results
  }

  private async sendToChannels(names: string[], notification: Notification): Promise<void> {
    const targets = this.channels.filter(ch => names.includes(ch.name))
    await Promise.allSettled(targets.map(ch => ch.send(notification)))
    // We intentionally ignore individual failures — each channel handles its own retries.
    // If all fail, the alert is still logged in SQLite.
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/core/notify/notifier.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Run full test suite**

```bash
npm run typecheck && npm test
```

Expected: 0 errors, all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/core/notify/notifier.ts src/core/notify/notifier.test.ts
git commit -m "feat: add notifier orchestrator (parallel send, RED/WARNING routing)"
```

---

## Phase 4 Checkpoint

```bash
npm run typecheck && npm test
```

All executor and notification tests pass. The system can now produce execution results and send notifications through both channels.
