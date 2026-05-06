// src/core/engine.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Engine } from './engine.js'
import { AlertLevel, AlertType, OrderStatus, OrderType } from './types.js'
import type { Monitor, PollResult, Executor, ExecutionOrder, UnstakeParams, PriceFloorGuardParams, SwapParams } from './types.js'
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

  it('guard FAILED aborts subsequent swap orders in same group', async () => {
    const executor = makeExecutor()
    vi.mocked(executor.execute)
      .mockResolvedValueOnce({ status: OrderStatus.CONFIRMED, executedAt: new Date() })  // unstake
      .mockResolvedValueOnce({ status: OrderStatus.CONFIRMED, executedAt: new Date() })  // remove
      .mockResolvedValueOnce({ status: OrderStatus.FAILED, error: 'price_floor_breach', executedAt: new Date() })  // guard
      // swap should never be called

    const alertId = crypto.randomUUID()
    insertAlert(db, {
      id: alertId, type: AlertType.DEPEG, level: AlertLevel.RED, protocol: 'test',
      title: 'T', message: 'M', data: {}, triggeredAt: new Date(),
      confirmations: 3, requiredConfirmations: 3, sustainedMs: 200_000, requiredSustainedMs: 180_000,
    })
    const guardParams: PriceFloorGuardParams = {
      poolAddress: '0x1' as `0x${string}`,
      token0Decimals: 18, token1Decimals: 6,
      twapWindowSeconds: 300, floor: 0.92, failClosed: true,
    }
    const swapParams: SwapParams = {
      routerAddress: '0x2' as `0x${string}`,
      tokenIn: '0x3' as `0x${string}`,
      tokenOut: '0x4' as `0x${string}`,
      amountIn: 1000n,
      amountOutMin: 990n,
      poolParam: 50,
      batchIndex: 0,
      totalBatches: 1,
    }
    const orders: ExecutionOrder[] = [
      { id: 'o1', alertId, protocol: 'test', type: OrderType.UNSTAKE, sequence: 1, groupId: 'g1', params: { gaugeAddress: '0x1', tokenId: 1n } as UnstakeParams, maxGasGwei: 50, deadline: 9999999999, status: OrderStatus.PENDING, createdAt: new Date() },
      { id: 'o2', alertId, protocol: 'test', type: OrderType.REMOVE_LIQUIDITY, sequence: 2, groupId: 'g1', params: { gaugeAddress: '0x1', tokenId: 1n } as UnstakeParams, maxGasGwei: 50, deadline: 9999999999, status: OrderStatus.PENDING, createdAt: new Date() },
      { id: 'o3', alertId, protocol: 'test', type: OrderType.PRICE_FLOOR_GUARD, sequence: 3, groupId: 'g1', params: guardParams, maxGasGwei: 50, deadline: 9999999999, status: OrderStatus.PENDING, createdAt: new Date() },
      { id: 'o4', alertId, protocol: 'test', type: OrderType.SWAP, sequence: 4, groupId: 'g1', params: swapParams, maxGasGwei: 50, deadline: 9999999999, status: OrderStatus.PENDING, createdAt: new Date() },
    ]
    const monitor = makeMonitor('test', { orders })
    const engine = new Engine({ db, executor, notifier: makeNotifier(), logger })
    engine.register(monitor)
    await engine.initAll()
    await engine.runCycleForTest('test')
    // unstake + remove + guard = 3 calls; swap must NOT be called
    expect(executor.execute).toHaveBeenCalledTimes(3)
    const calls = vi.mocked(executor.execute).mock.calls
    expect((calls[2]?.[0] as ExecutionOrder).type).toBe(OrderType.PRICE_FLOOR_GUARD)
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
