// src/protocols/aerodrome/monitors/price.ts
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { PriceSignal } from '../types.js'

interface PriceMonitorConfig {
  msUsdAddress: `0x${string}`
  poolAddress: `0x${string}`
}

export class PriceMonitor {
  constructor(
    private readonly cfg: PriceMonitorConfig,
    private readonly coinGecko: CoinGeckoClient,
    private readonly rpc: RpcClient,
  ) {}

  async check(): Promise<PriceSignal> {
    const [cgResult, twapResult] = await Promise.allSettled([
      this.coinGecko.getTokenPrice(this.cfg.msUsdAddress),
      this.rpc.getTwapPrice(this.cfg.poolAddress),
    ])

    return {
      coingecko: cgResult.status === 'fulfilled' ? cgResult.value.priceUsd : null,
      twap: twapResult.status === 'fulfilled' ? twapResult.value : null,
      fetchedAt: new Date(),
    }
  }
}
