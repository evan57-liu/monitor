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
const PAUSE_DURATION_MS = 5 * 60 * 1000  // 5 分钟

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
      // 立即执行第一次轮询，之后按间隔执行
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

  /** 仅用于测试暴露 */
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

      // 存储健康快照
      insertHealthSnapshot(this.cfg.db, monitorId, result.health)

      const notifyPromises: Promise<void>[] = []
      for (const alert of result.alerts) {
        insertAlert(this.cfg.db, alert)
        this.cfg.logger.warn(
          { type: alert.type, level: alert.level, confirmations: alert.confirmations, requiredConfirmations: alert.requiredConfirmations, sustainedMs: alert.sustainedMs, data: alert.data },
          alert.title,
        )
        if (alert.level === AlertLevel.RED || alert.level === AlertLevel.WARNING) {
          notifyPromises.push(this.cfg.notifier.notifyAlert(alert))
        }
      }

      // 订单执行优先于通知等待（撤出操作不能被 email 重试拖延）
      if (result.orders.length > 0) {
        await this.executeOrderGroup(result.orders)
      }

      await Promise.allSettled(notifyPromises)
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

      try {
        insertExecution(this.cfg.db, order, result)
      } catch (err) {
        this.cfg.logger.error({ orderId: order.id, err }, 'Failed to persist execution record')
      }

      if (result.status === OrderStatus.FAILED) {
        this.cfg.logger.error({ orderId: order.id, error: result.error }, 'Order failed — aborting group')
        await this.cfg.notifier.notifyAlert(this.makeExecutionFailureAlert(order, result.error))
        break // 中止该组剩余订单
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
      data: { orderId: order.id, type: order.type, sequence: order.sequence, groupId: order.groupId, ...(error != null && { error }) },
      triggeredAt: new Date(),
      confirmations: 1,
      requiredConfirmations: 1,
      sustainedMs: 0,
      requiredSustainedMs: 0,
    }
  }
}
