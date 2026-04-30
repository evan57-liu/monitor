// src/core/clients/rpc.ts
import { createPublicClient, http, parseAbi } from 'viem'
import { base } from 'viem/chains'
import type pino from 'pino'

export interface RpcConfig {
  url: string
  timeoutMs: number
}

// ERC-20 ABI 子集 — totalSupply + balanceOf
const ERC20_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

// Aerodrome CL 池 ABI 子集 — 用于 TWAP 计算
const CL_POOL_ABI = parseAbi([
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
])

export class RpcClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly client: ReturnType<typeof createPublicClient<any, any>>
  private readonly balanceCache = new Map<string, { value: bigint; expiresAt: number }>()
  private static readonly BALANCE_TTL_MS = 20_000

  constructor(cfg: RpcConfig, private readonly logger?: pino.Logger) {
    this.client = createPublicClient({
      chain: base,
      transport: http(cfg.url, { timeout: cfg.timeoutMs }),
    })
  }

  async getTotalSupply(tokenAddress: `0x${string}`): Promise<bigint> {
    return this.timed(
      'totalSupply', { token: tokenAddress },
      () => this.client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'totalSupply' }),
      v => ({ result: v.toString() }),
    )
  }

  async getTokenBalance(tokenAddress: `0x${string}`, holderAddress: `0x${string}`): Promise<bigint> {
    const key = `${tokenAddress}:${holderAddress}`
    const cached = this.balanceCache.get(key)
    if (cached !== undefined && Date.now() < cached.expiresAt) {
      this.logger?.debug({ token: tokenAddress, holder: holderAddress, balance: cached.value.toString() }, 'RPC balance cache hit')
      return cached.value
    }

    const value = await this.timed(
      'balanceOf', { token: tokenAddress, holder: holderAddress },
      () => this.client.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [holderAddress] }),
      v => ({ balance: v.toString() }),
    )
    this.balanceCache.set(key, { value, expiresAt: Date.now() + RpcClient.BALANCE_TTL_MS })
    return value
  }

  /**
   * 返回 token0 的人类可读 TWAP 价格（以 token1 计价）。
   * tick 原始价格不含小数位差异，需乘以 10^(token0Decimals - token1Decimals) 修正。
   */
  async getTwapPrice(
    poolAddress: `0x${string}`,
    token0Decimals: number,
    token1Decimals: number,
    twapWindowSeconds = 300,
  ): Promise<number> {
    const secondsAgos = [twapWindowSeconds, 0] as const
    const { price } = await this.timed(
      'twap', { pool: poolAddress, windowSec: twapWindowSeconds },
      async () => {
        const [tickCumulatives] = await this.client.readContract({
          address: poolAddress,
          abi: CL_POOL_ABI,
          functionName: 'observe',
          args: [Array.from(secondsAgos) as [number, number]],
        })
        const tick0 = tickCumulatives[0]
        const tick1 = tickCumulatives[1]
        if (tick0 === undefined || tick1 === undefined) throw new Error('observe returned empty')
        const avgTick = Number(tick1 - tick0) / twapWindowSeconds
        const rawPrice = Math.pow(1.0001, avgTick)
        const price = rawPrice * Math.pow(10, token0Decimals - token1Decimals)
        return { avgTick, price }
      },
      ({ avgTick, price }) => ({ avgTick, price }),
    )
    return price
  }

  private async timed<T>(
    label: string,
    ctx: Record<string, unknown>,
    fn: () => Promise<T>,
    resultCtx: (v: T) => Record<string, unknown> = () => ({}),
  ): Promise<T> {
    this.logger?.debug(ctx, `RPC ${label} →`)
    const t0 = Date.now()
    const result = await fn()
    this.logger?.debug({ ...ctx, ...resultCtx(result), durationMs: Date.now() - t0 }, `RPC ${label} ←`)
    return result
  }
}
