// src/protocols/aerodrome/orders.ts
import { OrderStatus, OrderType } from '../../core/types.js'
import type { Alert, ExecutionOrder, UnstakeParams, RemoveLiquidityParams, SwapParams } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'

/**
 * 生成 3 步撤出序列：
 * 1. 从 gauge 中取消质押 LP NFT
 * 2. 移除全部流动性（减少至 0）
 * 3. 分 N 批将 msUSD 换成 USDC
 *
 * 所有订单共享同一个 groupId。引擎按顺序执行，
 * 任意步骤失败则中止后续步骤。
 *
 * @param msUsdBalance — 移除流动性后估算的 msUSD 余额
 */
export function generateWithdrawalOrders(
  alert: Alert,
  cfg: AerodromeConfig,
  msUsdBalance: bigint,
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

  // 第 2 步：移除全部流动性
  // liquidity = 0 表示"全部移除"——执行器会从 NFT 读取实际流动性
  const removeParams: RemoveLiquidityParams = {
    positionManagerAddress: cfg.positionManagerAddress as `0x${string}`,
    tokenId: BigInt(cfg.lpTokenId),
    liquidity: 0n, // 执行器将调用 positions(tokenId) 获取实际流动性
    amount0Min: 0n,
    amount1Min: 0n,
    slippageBps: cfg.execution.swapSlippageBps,
  }
  orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.REMOVE_LIQUIDITY, removeParams, deadline, now))

  // 第 3 步：分 N 批将 msUSD 换成 USDC
  const batchCount = BigInt(cfg.execution.swapBatchCount)
  const batchAmount = msUsdBalance / batchCount
  for (let i = 0; i < cfg.execution.swapBatchCount; i++) {
    // 最后一批获取余量
    const amountIn = i === cfg.execution.swapBatchCount - 1
      ? msUsdBalance - batchAmount * (batchCount - 1n)
      : batchAmount
    // msUSD (18 位精度) → USDC (6 位精度)：除以 1e12 进行单位转换，再应用滑点
    const amountOutMin = amountIn / 10n ** 12n * BigInt(10000 - cfg.execution.swapSlippageBps) / 10000n
    const swapParams: SwapParams = {
      routerAddress: cfg.routerAddress as `0x${string}`,
      tokenIn: cfg.msUsdAddress as `0x${string}`,
      tokenOut: cfg.usdcAddress as `0x${string}`,
      amountIn,
      amountOutMin,
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
  params: UnstakeParams | RemoveLiquidityParams | SwapParams,
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
