// src/core/clients/rpc.ts
import { createPublicClient, http, parseAbi } from 'viem'
import { base } from 'viem/chains'

export interface RpcConfig {
  url: string
  timeoutMs: number
}

// ERC-20 ABI subset — totalSupply + balanceOf
const ERC20_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

// Aerodrome CL pool ABI subset — for TWAP
const CL_POOL_ABI = parseAbi([
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
])

export class RpcClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly client: ReturnType<typeof createPublicClient<any, any>>

  constructor(cfg: RpcConfig) {
    this.client = createPublicClient({
      chain: base,
      transport: http(cfg.url, { timeout: cfg.timeoutMs }),
    })
  }

  async getTotalSupply(tokenAddress: `0x${string}`): Promise<bigint> {
    return this.client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'totalSupply',
    })
  }

  /**
   * Returns the 5-minute TWAP price of token0 in terms of token1.
   * Uses tick arithmetic: price = 1.0001^(avgTick).
   * Returns price as a plain number (e.g., 0.9985 for msUSD).
   */
  async getTwapPrice(poolAddress: `0x${string}`, twapWindowSeconds = 300): Promise<number> {
    const secondsAgos = [twapWindowSeconds, 0] as const
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
    return Math.pow(1.0001, avgTick)
  }
}
