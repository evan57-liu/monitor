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
  nonceManager,
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
  PriceFloorGuardParams,
} from '../types.js'
import type pino from 'pino'

const GAUGE_ABI = parseAbi([
  'function withdraw(uint256 tokenId) external',
])

const POSITION_MANAGER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) external view returns (address)',
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

const CL_POOL_OBSERVE_ABI = parseAbi([
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
])

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) external view returns (uint256)',
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
    this.account = privateKeyToAccount(cfg.privateKey as `0x${string}`, { nonceManager })
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
        case OrderType.PRICE_FLOOR_GUARD:
          return await this.executeGuard(order, order.params as PriceFloorGuardParams)
        default:
          throw new Error(`Unknown order type: ${order.type as string}`)
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.logger.error({ orderId: order.id, error }, `Execution failed: ${order.type}`)
      return { status: OrderStatus.FAILED, error, executedAt: new Date() }
    }
  }

  private async executeUnstake(order: ExecutionOrder, params: UnstakeParams): Promise<ExecutionResult> {
    // Pre-flight ownerOf check avoids sending a tx we know will revert and gives a clear diagnostic
    let nftOwner: string | null = null
    try {
      nftOwner = await this.publicClient.readContract({
        address: params.positionManagerAddress,
        abi: POSITION_MANAGER_ABI,
        functionName: 'ownerOf',
        args: [params.tokenId],
      })
    } catch {
      // ownerOf reverted — NFT is burned (position fully removed), nothing to unstake
      this.logger.warn(
        { orderId: order.id, tokenId: params.tokenId.toString() },
        'Unstake skipped: NFT does not exist (already burned) — position fully removed',
      )
      return { status: OrderStatus.CONFIRMED, executedAt: new Date() }
    }

    const nftOwnerLower = nftOwner.toLowerCase()
    const gaugeLower = params.gaugeAddress.toLowerCase()
    const walletLower = this.account.address.toLowerCase()

    if (nftOwnerLower === walletLower) {
      // NFT is already in the wallet — unstake was done in a previous run, skip
      this.logger.warn(
        { orderId: order.id, tokenId: params.tokenId.toString() },
        'Unstake skipped: NFT already in wallet (not staked) — proceeding to remove liquidity directly',
      )
      return { status: OrderStatus.CONFIRMED, executedAt: new Date() }
    }

    if (nftOwnerLower !== gaugeLower) {
      const error = `unstake_preflight: nft.ownerOf(${params.tokenId})=${nftOwner} — not our wallet or gauge, cannot unstake`
      this.logger.error(
        { orderId: order.id, tokenId: params.tokenId.toString(), nftOwner, gauge: params.gaugeAddress, wallet: this.account.address },
        'Unstake pre-flight failed: NFT owned by unexpected address',
      )
      return { status: OrderStatus.FAILED, error, executedAt: new Date() }
    }

    // nftOwner == gauge — normal path
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
    // 读钱包当前 tokenIn 实际余额（真值），避免依赖上游估算导致 amountIn > 余额。
    // batchIndex=0 时紧跟 remove_liquidity，公共 RPC 节点可能缓存旧 block 的 eth_call 状态，
    // 导致 balanceOf 返回移除前的余额（通常为 0）。轮询直到余额非零或超时，再继续执行。
    const POLL_RETRIES = params.batchIndex === 0 ? 5 : 0
    const POLL_INTERVAL_MS = 3_000

    let balance = 0n
    for (let attempt = 0; attempt <= POLL_RETRIES; attempt++) {
      balance = await this.publicClient.readContract({
        address: params.tokenIn,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [this.account.address],
      })
      if (balance > 0n) break
      if (attempt < POLL_RETRIES) {
        this.logger.warn(
          { orderId: order.id, batch: `${params.batchIndex + 1}/${params.totalBatches}`, attempt },
          'balanceOf returned 0, RPC may be stale — retrying after 3s',
        )
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      }
    }

    const remaining = BigInt(params.totalBatches - params.batchIndex)
    const isLastBatch = params.batchIndex === params.totalBatches - 1
    const actualAmountIn = isLastBatch ? balance : balance / remaining

    if (actualAmountIn === 0n) {
      this.logger.warn(
        { orderId: order.id, batch: `${params.batchIndex + 1}/${params.totalBatches}`, pollRetries: POLL_RETRIES },
        'Swap skipped: no tokenIn in wallet after polling — position likely had 0 liquidity',
      )
      return { status: OrderStatus.CONFIRMED, executedAt: new Date() }
    }

    const actualAmountOutMin = params.amountIn > 0n
      ? (params.amountOutMin * actualAmountIn) / params.amountIn
      : 0n

    this.logger.info({
      orderId: order.id,
      batch: `${params.batchIndex + 1}/${params.totalBatches}`,
      walletBalance: balance.toString(),
      actualAmountIn: actualAmountIn.toString(),
      estimatedAmountIn: params.amountIn.toString(),
      actualAmountOutMin: actualAmountOutMin.toString(),
    }, 'Swap recalculated from live wallet balance')

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
      [this.account.address, actualAmountIn, actualAmountOutMin, path, true, false],
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
        { orderId: order.id, error, routerAddress: params.routerAddress, path, actualAmountIn: actualAmountIn.toString(), actualAmountOutMin: actualAmountOutMin.toString() },
        'Swap simulation failed, aborting to avoid wasting gas',
      )
      return { status: OrderStatus.FAILED, error, executedAt: new Date() }
    }

    const txHash = await this.walletClient.writeContract(callArgs)
    return this.waitForReceipt(txHash)
  }

  private async executeGuard(order: ExecutionOrder, params: PriceFloorGuardParams): Promise<ExecutionResult> {
    let twapPrice: number | null = null
    try {
      const [prevCum, currCum] = await this.publicClient.readContract({
        address: params.poolAddress,
        abi: CL_POOL_OBSERVE_ABI,
        functionName: 'observe',
        args: [[params.twapWindowSeconds, 0]],
      }).then(r => [r[0][0]!, r[0][1]!] as [bigint, bigint])
      const avgTick = Number(currCum - prevCum) / params.twapWindowSeconds
      // price = 1.0001^avgTick × 10^(token0Dec - token1Dec)
      twapPrice = Math.pow(1.0001, avgTick) * Math.pow(10, params.token0Decimals - params.token1Decimals)
      this.logger.debug({ orderId: order.id, twapPrice, floor: params.floor }, 'Price floor guard TWAP check')
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.logger.error({ orderId: order.id, error }, 'Price floor guard TWAP fetch failed')
      if (params.failClosed) {
        return { status: OrderStatus.FAILED, error: `price_floor_guard_twap_unavailable: ${error}`, executedAt: new Date() }
      }
      // failClosed=false：抓不到价格时放行（有意取舍，默认不启用）
      return { status: OrderStatus.CONFIRMED, executedAt: new Date() }
    }
    if (twapPrice < params.floor) {
      const error = `price_floor_breach: twap=${twapPrice.toFixed(4)} < floor=${params.floor}`
      this.logger.error({ orderId: order.id, twapPrice, floor: params.floor }, 'Price floor guard triggered — aborting remaining swaps')
      return { status: OrderStatus.FAILED, error, executedAt: new Date() }
    }
    return { status: OrderStatus.CONFIRMED, executedAt: new Date() }
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
