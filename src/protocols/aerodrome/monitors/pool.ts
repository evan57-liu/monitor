// src/protocols/aerodrome/monitors/pool.ts
import { formatUnits } from 'viem'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { PoolSignal } from '../types.js'
import type pino from 'pino'

interface PoolMonitorConfig {
  poolAddress: `0x${string}`
  msUsdAddress: `0x${string}`
  usdcAddress: `0x${string}`
}

export class PoolMonitor {
  constructor(
    private readonly cfg: PoolMonitorConfig,
    private readonly coinGecko: CoinGeckoClient,
    private readonly rpc: RpcClient,
    private readonly logger: pino.Logger,
  ) {}

  async check(): Promise<PoolSignal | null> {
    try {
      const [pool, msUsdBalance, usdcBalance] = await Promise.all([
        this.coinGecko.getPoolData(this.cfg.poolAddress),
        this.rpc.getTokenBalance(this.cfg.msUsdAddress, this.cfg.poolAddress),
        this.rpc.getTokenBalance(this.cfg.usdcAddress, this.cfg.poolAddress),
      ])

      // msUSD = 18 decimals, USDC = 6 decimals
      const msUsdUnits = parseFloat(formatUnits(msUsdBalance, 18))
      const usdcUnits = parseFloat(formatUnits(usdcBalance, 6))
      const msUsdUsdValue = msUsdUnits * pool.baseTokenPriceUsd
      const usdcUsdValue = usdcUnits
      const totalUsdValue = msUsdUsdValue + usdcUsdValue
      const msUsdRatio = totalUsdValue > 0 ? msUsdUsdValue / totalUsdValue : 0

      this.logger.debug({
        msUsdBalance: msUsdUnits.toFixed(2),
        usdcBalance: usdcUnits.toFixed(2),
        msUsdRatio: msUsdRatio.toFixed(4),
        poolPriceUsd: pool.baseTokenPriceUsd,
        quotePriceUsd: pool.quotePriceUsd,
        reserveInUsd: pool.reserveInUsd,
        buys1h: pool.buys1h,
        sells1h: pool.sells1h,
      }, 'PoolMonitor signal')

      return {
        reserveInUsd: pool.reserveInUsd,
        msUsdRatio,
        poolPriceUsd: pool.baseTokenPriceUsd,
        buys1h: pool.buys1h,
        sells1h: pool.sells1h,
        volume24h: pool.volume24h,
        fetchedAt: new Date(),
      }
    } catch (err) {
      this.logger.warn({ err }, 'PoolMonitor check failed')
      return null
    }
  }
}
