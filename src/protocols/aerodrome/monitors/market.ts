// src/protocols/aerodrome/monitors/market.ts
// 合并了原 PriceMonitor 和 PoolMonitor：共享一次 getPoolData 调用，同时产出价格信号和池子信号。
import { formatUnits } from 'viem'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { PriceSignal, PoolSignal } from '../types.js'
import type pino from 'pino'

export interface MarketSignal {
  price: PriceSignal
  pool: PoolSignal | null
}

interface MarketMonitorConfig {
  poolAddress: `0x${string}`
  msUsdAddress: `0x${string}`
  usdcAddress: `0x${string}`
  token0Decimals: number
  token1Decimals: number
}

export class MarketMonitor {
  constructor(
    private readonly cfg: MarketMonitorConfig,
    private readonly coinGecko: CoinGeckoClient,
    private readonly rpc: RpcClient,
    private readonly logger: pino.Logger,
  ) {}

  async check(): Promise<MarketSignal> {
    const [poolResult, twapResult, msUsdBalResult, usdcBalResult] = await Promise.allSettled([
      this.coinGecko.getPoolData(this.cfg.poolAddress),
      this.rpc.getTwapPrice(this.cfg.poolAddress, this.cfg.token0Decimals, this.cfg.token1Decimals),
      this.rpc.getTokenBalance(this.cfg.msUsdAddress, this.cfg.poolAddress),
      this.rpc.getTokenBalance(this.cfg.usdcAddress, this.cfg.poolAddress),
    ])

    if (poolResult.status === 'rejected')
      this.logger.warn({ err: poolResult.reason }, 'CoinGecko getPoolData failed')
    if (twapResult.status === 'rejected')
      this.logger.warn({ err: twapResult.reason }, 'RPC getTwapPrice failed')
    if (msUsdBalResult.status === 'rejected')
      this.logger.warn({ err: msUsdBalResult.reason }, 'RPC getTokenBalance (msUSD) failed')
    if (usdcBalResult.status === 'rejected')
      this.logger.warn({ err: usdcBalResult.reason }, 'RPC getTokenBalance (USDC) failed')

    const price: PriceSignal = {
      coingecko: poolResult.status === 'fulfilled' ? poolResult.value.baseTokenPriceUsd : null,
      twap: twapResult.status === 'fulfilled' ? twapResult.value : null,
      fetchedAt: new Date(),
    }

    let pool: PoolSignal | null = null
    if (
      poolResult.status === 'fulfilled' &&
      msUsdBalResult.status === 'fulfilled' &&
      usdcBalResult.status === 'fulfilled'
    ) {
      const poolData = poolResult.value
      const msUsdUnits = parseFloat(formatUnits(msUsdBalResult.value, 18))
      const usdcUnits = parseFloat(formatUnits(usdcBalResult.value, 6))
      const msUsdUsdValue = msUsdUnits * poolData.baseTokenPriceUsd
      const totalUsdValue = msUsdUsdValue + usdcUnits
      const msUsdRatio = totalUsdValue > 0 ? msUsdUsdValue / totalUsdValue : 0

      pool = {
        reserveInUsd: poolData.reserveInUsd,
        msUsdRatio,
        poolPriceUsd: poolData.baseTokenPriceUsd,
        buys1h: poolData.buys1h,
        sells1h: poolData.sells1h,
        volume24h: poolData.volume24h,
        fetchedAt: new Date(),
      }
    }

    this.logger.debug({
      coingecko: price.coingecko,
      twap: price.twap,
      msUsdRatio: pool?.msUsdRatio,
      poolPriceUsd: pool?.poolPriceUsd,
      buys1h: pool?.buys1h,
      sells1h: pool?.sells1h,
    }, 'MarketMonitor signal')

    return { price, pool }
  }
}
