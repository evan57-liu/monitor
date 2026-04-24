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
