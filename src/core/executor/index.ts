// src/core/executor/index.ts
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  maxUint128,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { OrderStatus, OrderType } from '../types.js'
import type {
  Executor,
  ExecutionOrder,
  ExecutionResult,
  UnstakeParams,
  RemoveLiquidityParams,
  SwapParams,
} from '../types.js'
import type pino from 'pino'

const GAUGE_ABI = parseAbi([
  'function withdraw(uint256 tokenId) external',
])

const POSITION_MANAGER_ABI = parseAbi([
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external returns (uint256 amount0, uint256 amount1)',
])

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut)',
])

export interface LiveExecutorConfig {
  privateKey: string
  rpcUrl: string
  rpcTimeoutMs: number
  gasMultiplier: number
}

function makeClients(cfg: LiveExecutorConfig, account: ReturnType<typeof privateKeyToAccount>) {
  const transport = http(cfg.rpcUrl, { timeout: cfg.rpcTimeoutMs })
  const walletClient = createWalletClient({ account, chain: base, transport })
  const publicClient = createPublicClient({ chain: base, transport })
  return { walletClient, publicClient }
}

type Clients = ReturnType<typeof makeClients>

export class LiveExecutor implements Executor {
  private readonly walletClient: Clients['walletClient']
  private readonly publicClient: Clients['publicClient']
  private readonly account: ReturnType<typeof privateKeyToAccount>

  constructor(
    private readonly cfg: LiveExecutorConfig,
    private readonly logger: pino.Logger,
  ) {
    this.account = privateKeyToAccount(cfg.privateKey as `0x${string}`)
    const clients = makeClients(cfg, this.account)
    this.walletClient = clients.walletClient
    this.publicClient = clients.publicClient
  }

  async execute(order: ExecutionOrder): Promise<ExecutionResult> {
    this.logger.info({ orderId: order.id, type: order.type }, `Executing ${order.type}`)
    try {
      switch (order.type) {
        case OrderType.UNSTAKE:
          return await this.executeUnstake(order, order.params as UnstakeParams)
        case OrderType.REMOVE_LIQUIDITY:
          return await this.executeRemoveLiquidity(order, order.params as RemoveLiquidityParams)
        case OrderType.SWAP:
          return await this.executeSwap(order, order.params as SwapParams)
        default:
          throw new Error(`Unknown order type: ${order.type as string}`)
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.logger.error({ orderId: order.id, error }, `Execution failed: ${order.type}`)
      return { status: OrderStatus.FAILED, error, executedAt: new Date() }
    }
  }

  private async executeUnstake(_order: ExecutionOrder, params: UnstakeParams): Promise<ExecutionResult> {
    const txHash = await this.walletClient.writeContract({
      address: params.gaugeAddress,
      abi: GAUGE_ABI,
      functionName: 'withdraw',
      args: [params.tokenId],
    })
    return this.waitForReceipt(txHash)
  }

  private async executeRemoveLiquidity(order: ExecutionOrder, params: RemoveLiquidityParams): Promise<ExecutionResult> {
    // Read actual liquidity from position if params.liquidity === 0n
    let liquidity = params.liquidity
    if (liquidity === 0n) {
      const position = await this.publicClient.readContract({
        address: params.positionManagerAddress,
        abi: POSITION_MANAGER_ABI,
        functionName: 'positions',
        args: [params.tokenId],
      })
      liquidity = position[7] // liquidity is index 7 in the tuple
    }
    if (liquidity === 0n) {
      this.logger.warn({ orderId: order.id }, 'No liquidity to remove, skipping decreaseLiquidity')
    } else {
      const decreaseTx = await this.walletClient.writeContract({
        address: params.positionManagerAddress,
        abi: POSITION_MANAGER_ABI,
        functionName: 'decreaseLiquidity',
        args: [{ tokenId: params.tokenId, liquidity, amount0Min: params.amount0Min, amount1Min: params.amount1Min, deadline: BigInt(order.deadline) }],
      })
      await this.waitForReceipt(decreaseTx)
    }

    // Collect all tokens (including owed fees)
    const collectTx = await this.walletClient.writeContract({
      address: params.positionManagerAddress,
      abi: POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{ tokenId: params.tokenId, recipient: this.account.address, amount0Max: maxUint128, amount1Max: maxUint128 }],
    })
    return this.waitForReceipt(collectTx)
  }

  private async executeSwap(order: ExecutionOrder, params: SwapParams): Promise<ExecutionResult> {
    const txHash = await this.walletClient.writeContract({
      address: params.routerAddress,
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        tickSpacing: 1, // Aerodrome CL stable pools use tickSpacing=1
        recipient: this.account.address,
        deadline: BigInt(order.deadline),
        amountIn: params.amountIn,
        amountOutMinimum: params.amountOutMin,
        sqrtPriceLimitX96: 0n,
      }],
    })
    return this.waitForReceipt(txHash)
  }

  private async waitForReceipt(txHash: `0x${string}`): Promise<ExecutionResult> {
    this.logger.info({ txHash }, 'Transaction submitted, waiting for receipt')
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
    const status = receipt.status === 'success' ? OrderStatus.CONFIRMED : OrderStatus.FAILED
    return {
      status,
      txHash,
      gasUsed: receipt.gasUsed,
      executedAt: new Date(),
      ...(status === OrderStatus.FAILED && { error: 'Transaction reverted' }),
    }
  }
}
