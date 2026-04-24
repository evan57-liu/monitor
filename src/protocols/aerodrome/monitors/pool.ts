// src/protocols/aerodrome/monitors/pool.ts
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { PoolSignal } from '../types.js'

interface PoolMonitorConfig { poolAddress: string }

export class PoolMonitor {
  constructor(
    private readonly cfg: PoolMonitorConfig,
    private readonly coinGecko: CoinGeckoClient,
  ) {}

  async check(): Promise<PoolSignal | null> {
    try {
      const pool = await this.coinGecko.getPoolData(this.cfg.poolAddress)
      // Compute msUSD ratio: msUSD side of pool / total reserve (by USD value)
      // reserve0 = msUSD (18 decimals), reserve1 = USDC (6 decimals)
      const msUsdAmount = Number(BigInt(pool.reserve0Raw)) / 1e18
      const usdcAmount = Number(BigInt(pool.reserve1Raw)) / 1e6
      const msUsdUsdValue = msUsdAmount * pool.baseTokenPriceUsd
      const totalUsdValue = msUsdUsdValue + usdcAmount
      const msUsdRatio = totalUsdValue > 0 ? msUsdUsdValue / totalUsdValue : 0

      return {
        reserveInUsd: pool.reserveInUsd,
        msUsdRatio,
        buys1h: pool.buys1h,
        sells1h: pool.sells1h,
        volume24h: pool.volume24h,
        fetchedAt: new Date(),
      }
    } catch {
      return null
    }
  }
}
