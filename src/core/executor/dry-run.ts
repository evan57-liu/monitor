// src/core/executor/dry-run.ts
import { OrderStatus, OrderType } from '../types.js'
import type { Executor, ExecutionOrder, ExecutionResult, PriceFloorGuardParams } from '../types.js'
import type pino from 'pino'

export class DryRunExecutor implements Executor {
  constructor(private readonly logger: pino.Logger) {}

  async execute(order: ExecutionOrder): Promise<ExecutionResult> {
    switch (order.type) {
      case OrderType.PRICE_FLOOR_GUARD: {
        const params = order.params as PriceFloorGuardParams
        this.logger.info(
          { orderId: order.id, sequence: order.sequence, groupId: order.groupId, floor: params.floor, failClosed: params.failClosed },
          `DRY_RUN: would check price floor (TWAP vs $${params.floor}) — always passes in dry-run`,
        )
        break
      }
      default:
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
        break
    }
    return { status: OrderStatus.SKIPPED_DRY_RUN, executedAt: new Date() }
  }
}
