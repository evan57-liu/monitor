// src/protocols/aerodrome/orders.test.ts
import { describe, it, expect } from 'vitest'
import { generateWithdrawalOrders } from './orders.js'
import { AlertLevel, AlertType, OrderType } from '../../core/types.js'
import type { Alert, PriceFloorGuardParams, SwapParams } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'

const cfg = {
  poolAddress: '0x0000000000000000000000000000000000000010',
  gaugeAddress: '0x0000000000000000000000000000000000000001',
  positionManagerAddress: '0x0000000000000000000000000000000000000002',
  routerAddress: '0x0000000000000000000000000000000000000003',
  msUsdAddress: '0x0000000000000000000000000000000000000004',
  usdcAddress: '0x0000000000000000000000000000000000000005',
  lpTokenId: 12345,
  execution: {
    swapBatchCount: 3,
    swapSlippageBps: 100,
    swapPoolParam: 0x32,
    gasMultiplier: 1.2,
    deadlineSeconds: 300,
    maxGasGwei: 50,
    minPriceToSwap: 0.92,
    priceFloorRequired: true,
  },
} as unknown as AerodromeConfig

const redAlert: Alert = {
  id: 'alert-1',
  type: AlertType.DEPEG,
  level: AlertLevel.RED,
  protocol: 'aerodrome-msusd-usdc',
  title: 'test',
  message: 'test',
  data: {},
  triggeredAt: new Date(),
  confirmations: 3,
  requiredConfirmations: 3,
  sustainedMs: 200_000,
  requiredSustainedMs: 180_000,
}

describe('generateWithdrawalOrders', () => {
  it('generates 8-order sequence: unstake → remove → 3×(guard + swap)', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n, 0.99)
    expect(orders).toHaveLength(8)
    expect(orders[0]?.type).toBe(OrderType.UNSTAKE)
    expect(orders[1]?.type).toBe(OrderType.REMOVE_LIQUIDITY)
    expect(orders[2]?.type).toBe(OrderType.PRICE_FLOOR_GUARD)
    expect(orders[3]?.type).toBe(OrderType.SWAP)
    expect(orders[4]?.type).toBe(OrderType.PRICE_FLOOR_GUARD)
    expect(orders[5]?.type).toBe(OrderType.SWAP)
    expect(orders[6]?.type).toBe(OrderType.PRICE_FLOOR_GUARD)
    expect(orders[7]?.type).toBe(OrderType.SWAP)
  })

  it('assigns sequential sequence numbers 1–8', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n, 0.99)
    expect(orders.map(o => o.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('all orders share the same groupId', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n, 0.99)
    const groupIds = new Set(orders.map(o => o.groupId))
    expect(groupIds.size).toBe(1)
  })

  it('swap batches divide total amount evenly', () => {
    const totalMsUsd = 90_000n * 10n ** 18n
    const orders = generateWithdrawalOrders(redAlert, cfg, totalMsUsd, 0.99)
    const swaps = orders.filter(o => o.type === OrderType.SWAP)
    const batchAmount = totalMsUsd / 3n
    for (const swap of swaps) {
      expect((swap.params as SwapParams).amountIn).toBe(batchAmount)
    }
  })

  it('calculates amountOutMin using real effectivePrice (not $1 assumption)', () => {
    const totalMsUsd = 30_000n * 10n ** 18n
    const effectivePrice = 0.96
    const orders = generateWithdrawalOrders(redAlert, cfg, totalMsUsd, effectivePrice)
    const swap = orders.find(o => o.type === OrderType.SWAP)
    if (!swap) throw new Error('no swap')
    const params = swap.params as SwapParams
    // expectedUsdc = amountIn * floor(0.96*1e6) / 1e6 / 1e12
    const priceE6 = BigInt(Math.floor(effectivePrice * 1_000_000))
    const expectedUsdc = params.amountIn * priceE6 / 1_000_000n / 10n ** 12n
    const expectedMin = expectedUsdc * 9900n / 10000n
    expect(params.amountOutMin).toBe(expectedMin)
  })

  it('guard params carry correct floor and pool address', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n, 0.99)
    const guard = orders.find(o => o.type === OrderType.PRICE_FLOOR_GUARD)
    if (!guard) throw new Error('no guard')
    const params = guard.params as PriceFloorGuardParams
    expect(params.floor).toBe(0.92)
    expect(params.failClosed).toBe(true)
    expect(params.poolAddress.toLowerCase()).toBe('0x0000000000000000000000000000000000000010')
    expect(params.twapWindowSeconds).toBe(300)
  })
})
