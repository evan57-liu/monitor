// src/protocols/aerodrome/orders.ts
import { OrderStatus, OrderType } from '../../core/types.js'
import type { Alert, ExecutionOrder, UnstakeParams, RemoveLiquidityParams, SwapParams, PriceFloorGuardParams } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'

/**
 * 生成撤出序列：
 * 1. 从 gauge 中取消质押 LP NFT
 * 2. 移除全部流动性
 * 3. 分 N 批将 msUSD 换成 USDC，每批 swap 前都先执行价格地板门控检查
 *
 * 所有订单共享同一个 groupId，引擎按顺序执行，任意步骤失败则中止后续步骤。
 *
 * @param msUsdBalance  — 移除流动性后估算的 msUSD 余额（18 位精度）
 * @param effectivePrice — 撤出时刻的真实 msUSD 价格（max 三源），用于精确计算 amountOutMin
 */
export function generateWithdrawalOrders(
  alert: Alert,
  cfg: AerodromeConfig,
  msUsdBalance: bigint,
  effectivePrice: number,
): ExecutionOrder[] {
  const groupId = crypto.randomUUID()
  const deadline = Math.floor(Date.now() / 1000) + cfg.execution.deadlineSeconds
  const now = new Date()
  const orders: ExecutionOrder[] = []
  let seq = 1

  // 第 1 步：从 gauge 中取消质押 LP NFT
  const unstakeParams: UnstakeParams = {
    gaugeAddress: cfg.gaugeAddress as `0x${string}`,
    tokenId: BigInt(cfg.lpTokenId),
  }
  orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.UNSTAKE, unstakeParams, deadline, now))

  // 第 2 步：移除全部流动性（liquidity=0 表示全部移除，执行器从 NFT 读取实际值）
  const removeParams: RemoveLiquidityParams = {
    positionManagerAddress: cfg.positionManagerAddress as `0x${string}`,
    tokenId: BigInt(cfg.lpTokenId),
    liquidity: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
    slippageBps: cfg.execution.swapSlippageBps,
    burnAfterRemove: true,
  }
  orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.REMOVE_LIQUIDITY, removeParams, deadline, now))

  // 第 3 步：分 N 批 swap，每批前先用链上 TWAP 做价格地板门控检查
  const batchCount = BigInt(cfg.execution.swapBatchCount)
  const batchAmount = msUsdBalance / batchCount
  // effectivePrice 量化为 6 位整数以确保 bigint 运算精度，循环外只算一次
  const priceE6 = BigInt(Math.floor(effectivePrice * 1_000_000))
  const guardParams: PriceFloorGuardParams = {
    poolAddress: cfg.poolAddress as `0x${string}`,
    token0Decimals: 18,
    token1Decimals: 6,
    twapWindowSeconds: 300,
    floor: cfg.execution.minPriceToSwap,
    failClosed: cfg.execution.priceFloorRequired,
  }
  for (let i = 0; i < cfg.execution.swapBatchCount; i++) {
    orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.PRICE_FLOOR_GUARD, guardParams, deadline, now))

    const amountIn = i === cfg.execution.swapBatchCount - 1
      ? msUsdBalance - batchAmount * (batchCount - 1n)
      : batchAmount
    const expectedUsdc = amountIn * priceE6 / 1_000_000n / 10n ** 12n
    const amountOutMin = expectedUsdc * BigInt(10000 - cfg.execution.swapSlippageBps) / 10000n
    const swapParams: SwapParams = {
      routerAddress: cfg.routerAddress as `0x${string}`,
      tokenIn: cfg.msUsdAddress as `0x${string}`,
      tokenOut: cfg.usdcAddress as `0x${string}`,
      amountIn,
      amountOutMin,
      poolParam: cfg.execution.swapPoolParam,
      batchIndex: i,
      totalBatches: cfg.execution.swapBatchCount,
    }
    orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.SWAP, swapParams, deadline, now))
  }

  return orders
}


function makeOrder(
  alert: Alert,
  cfg: AerodromeConfig,
  groupId: string,
  sequence: number,
  type: OrderType,
  params: UnstakeParams | RemoveLiquidityParams | SwapParams | PriceFloorGuardParams,
  deadline: number,
  createdAt: Date,
): ExecutionOrder {
  return {
    id: crypto.randomUUID(),
    alertId: alert.id,
    protocol: alert.protocol,
    type,
    sequence,
    groupId,
    params,
    maxGasGwei: cfg.execution.maxGasGwei,
    deadline,
    status: OrderStatus.PENDING,
    createdAt,
  }
}
