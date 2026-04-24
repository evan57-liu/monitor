// src/protocols/aerodrome/orders.ts
import { OrderStatus, OrderType } from '../../core/types.js'
import type { Alert, ExecutionOrder, UnstakeParams, RemoveLiquidityParams, SwapParams } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'

/**
 * Generates a 3-step withdrawal sequence:
 * 1. Unstake LP NFT from gauge
 * 2. Remove all liquidity (decrease to 0)
 * 3. Swap msUSD → USDC in N batches
 *
 * All orders share a groupId. The engine executes them in sequence,
 * aborting on any failure.
 *
 * @param msUsdBalance — estimated msUSD balance after removing liquidity
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

  // Step 1: Unstake LP NFT from gauge
  const unstakeParams: UnstakeParams = {
    gaugeAddress: cfg.gaugeAddress as `0x${string}`,
    tokenId: BigInt(cfg.lpTokenId),
  }
  orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.UNSTAKE, unstakeParams, deadline, now))

  // Step 2: Remove all liquidity
  // liquidity = 0 signals "remove all" — the executor reads actual liquidity from the NFT
  const removeParams: RemoveLiquidityParams = {
    positionManagerAddress: cfg.positionManagerAddress as `0x${string}`,
    tokenId: BigInt(cfg.lpTokenId),
    liquidity: 0n, // executor will call positions(tokenId) to get actual liquidity
    amount0Min: 0n,
    amount1Min: 0n,
    slippageBps: cfg.execution.swapSlippageBps,
  }
  orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.REMOVE_LIQUIDITY, removeParams, deadline, now))

  // Step 3: Swap msUSD → USDC in N batches
  const batchCount = BigInt(cfg.execution.swapBatchCount)
  const batchAmount = msUsdBalance / batchCount
  for (let i = 0; i < cfg.execution.swapBatchCount; i++) {
    // Last batch gets the remainder
    const amountIn = i === cfg.execution.swapBatchCount - 1
      ? msUsdBalance - batchAmount * (batchCount - 1n)
      : batchAmount
    // msUSD (18 dec) → USDC (6 dec): divide by 1e12 for unit conversion, then apply slippage
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
