// src/core/executor/index.ts
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  numberToHex,
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
  'function burn(uint256 tokenId) external',
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
])

const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
  // Permit2 errors (AllowanceExpired = 0xd81b2f2e)
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  // V3 swap errors
  'error V3InvalidSwap()',
  'error V3TooLittleReceived()',
  'error V3TooMuchRequested()',
  'error V3InvalidAmountOut()',
  'error V3InvalidCaller()',
  // Universal Router errors
  'error TransactionDeadlinePassed()',
  'error LengthMismatch()',
  'error InvalidEthSender()',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error BalanceTooLow()',
])

/** Universal Router command byte: V3_SWAP_EXACT_IN */
const CMD_V3_SWAP_EXACT_IN = '0x00' as const

/** ABI parameter types for V3_SWAP_EXACT_IN input encoding */
const SWAP_INPUT_PARAMS = parseAbiParameters('address, uint256, uint256, bytes, bool, bool')

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
    // 如果 params.liquidity === 0n，则从链上 position 读取实际流动性
    let liquidity = params.liquidity
    if (liquidity === 0n) {
      const position = await this.publicClient.readContract({
        address: params.positionManagerAddress,
        abi: POSITION_MANAGER_ABI,
        functionName: 'positions',
        args: [params.tokenId],
      })
      liquidity = position[7] // liquidity 是元组中索引为 7 的字段
    }

    const willDecrease = liquidity !== 0n
    const willBurn = params.burnAfterRemove ?? true

    if (!willDecrease) {
      this.logger.warn({ orderId: order.id }, 'No liquidity to remove, skipping decreaseLiquidity')
    }

    // 仅 collect（已无流动性且不 burn）时直接调用，节省 multicall 开销
    if (!willDecrease && !willBurn) {
      const collectTx = await this.walletClient.writeContract({
        address: params.positionManagerAddress,
        abi: POSITION_MANAGER_ABI,
        functionName: 'collect',
        args: [{ tokenId: params.tokenId, recipient: this.account.address, amount0Max: maxUint128, amount1Max: maxUint128 }],
      })
      return this.waitForReceipt(collectTx)
    }

    // 原子执行：decreaseLiquidity + collect + burn（可选）
    const calls: `0x${string}`[] = []
    if (willDecrease) {
      calls.push(encodeFunctionData({
        abi: POSITION_MANAGER_ABI,
        functionName: 'decreaseLiquidity',
        args: [{ tokenId: params.tokenId, liquidity, amount0Min: params.amount0Min, amount1Min: params.amount1Min, deadline: BigInt(order.deadline) }],
      }))
    }
    calls.push(encodeFunctionData({
      abi: POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [{ tokenId: params.tokenId, recipient: this.account.address, amount0Max: maxUint128, amount1Max: maxUint128 }],
    }))
    if (willBurn) {
      calls.push(encodeFunctionData({
        abi: POSITION_MANAGER_ABI,
        functionName: 'burn',
        args: [params.tokenId],
      }))
    }

    this.logger.info({ orderId: order.id, callCount: calls.length, willBurn }, 'Sending multicall for remove liquidity')
    const txHash = await this.walletClient.writeContract({
      address: params.positionManagerAddress,
      abi: POSITION_MANAGER_ABI,
      functionName: 'multicall',
      args: [calls],
    })
    return this.waitForReceipt(txHash)
  }

  private async executeSwap(order: ExecutionOrder, params: SwapParams): Promise<ExecutionResult> {
    // path: tokenIn(20 bytes) + poolParam(3 bytes) + tokenOut(20 bytes)
    const path = concat([
      params.tokenIn,
      numberToHex(params.poolParam, { size: 3 }),
      params.tokenOut,
    ])

    // payerIsUser=true: 通过 Permit2 从调用者钱包拉取代币
    // isUni=false: 使用 Aerodrome CL (Slipstream) 池，非 UniswapV3 池
    const input = encodeAbiParameters(
      SWAP_INPUT_PARAMS,
      [this.account.address, params.amountIn, params.amountOutMin, path, true, false],
    )

    const callArgs = {
      address: params.routerAddress as `0x${string}`,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute' as const,
      args: [CMD_V3_SWAP_EXACT_IN, [input], BigInt(order.deadline)] as const,
      account: this.account,
    }

    try {
      await this.publicClient.simulateContract(callArgs)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.logger.error(
        { orderId: order.id, error, routerAddress: params.routerAddress, path, amountIn: params.amountIn.toString(), amountOutMin: params.amountOutMin.toString() },
        'Swap simulation failed, aborting to avoid wasting gas',
      )
      return { status: OrderStatus.FAILED, error, executedAt: new Date() }
    }

    const txHash = await this.walletClient.writeContract(callArgs)
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
