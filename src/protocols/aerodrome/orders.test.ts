// src/protocols/aerodrome/orders.test.ts
import { describe, it, expect } from 'vitest'
import { generateWithdrawalOrders } from './orders.js'
import { AlertLevel, AlertType, OrderType } from '../../core/types.js'
import type { Alert } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'

const cfg = {
  gaugeAddress: '0x0000000000000000000000000000000000000001',
  positionManagerAddress: '0x0000000000000000000000000000000000000002',
  routerAddress: '0x0000000000000000000000000000000000000003',
  msUsdAddress: '0x0000000000000000000000000000000000000004',
  usdcAddress: '0x0000000000000000000000000000000000000005',
  lpTokenId: 12345,
  execution: { swapBatchCount: 3, swapSlippageBps: 100, gasMultiplier: 1.2, deadlineSeconds: 300, maxGasGwei: 50 },
} as unknown as AerodromeConfig

const redAlert: Alert = {
  id: 'alert-1',
  type: AlertType.DEPEG,
  level: AlertLevel.RED,
  protocol: 'aerodrome-msusd-usdc',
  title: 'test',
  message: 'test',
  data: { msUsdBalance: (100_000n * 10n ** 18n).toString() },
  triggeredAt: new Date(),
  confirmations: 3,
  requiredConfirmations: 3,
  sustainedMs: 200_000,
  requiredSustainedMs: 180_000,
}

describe('generateWithdrawalOrders', () => {
  it('generates 3-step sequence: unstake → remove_liquidity → 3 swaps', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n)
    expect(orders).toHaveLength(5) // 1 unstake + 1 remove + 3 swaps
    expect(orders[0]?.type).toBe(OrderType.UNSTAKE)
    expect(orders[1]?.type).toBe(OrderType.REMOVE_LIQUIDITY)
    expect(orders[2]?.type).toBe(OrderType.SWAP)
    expect(orders[3]?.type).toBe(OrderType.SWAP)
    expect(orders[4]?.type).toBe(OrderType.SWAP)
  })

  it('assigns sequential sequence numbers starting at 1', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n)
    expect(orders.map(o => o.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  it('all orders share the same groupId', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n)
    const groupIds = new Set(orders.map(o => o.groupId))
    expect(groupIds.size).toBe(1)
  })

  it('swap batches divide total amount evenly', () => {
    const totalMsUsd = 90_000n * 10n ** 18n // divisible by 3
    const orders = generateWithdrawalOrders(redAlert, cfg, totalMsUsd)
    const swaps = orders.filter(o => o.type === OrderType.SWAP)
    const batchAmount = totalMsUsd / 3n
    for (const swap of swaps) {
      expect((swap.params as { amountIn: bigint }).amountIn).toBe(batchAmount)
    }
  })

  it('applies slippage correctly (1% = 9900/10000 of amountIn)', () => {
    const totalMsUsd = 30_000n * 10n ** 18n
    const orders = generateWithdrawalOrders(redAlert, cfg, totalMsUsd)
    const swap = orders.find(o => o.type === OrderType.SWAP)
    if (!swap) throw new Error('no swap')
    const params = swap.params as { amountIn: bigint; amountOutMin: bigint }
    // amountOutMin = amountIn / 1e12 * 9900 / 10000
    const expectedMin = params.amountIn / 10n ** 12n * 9900n / 10000n
    expect(params.amountOutMin).toBe(expectedMin)
  })
})
