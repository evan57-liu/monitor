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
