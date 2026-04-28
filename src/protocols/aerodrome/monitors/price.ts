// src/protocols/aerodrome/monitors/price.ts
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { PriceSignal } from '../types.js'
import type pino from 'pino'

interface PriceMonitorConfig {
  msUsdAddress: `0x${string}`
  poolAddress: `0x${string}`
}

export class PriceMonitor {
  constructor(
    private readonly cfg: PriceMonitorConfig,
    private readonly coinGecko: CoinGeckoClient,
    private readonly rpc: RpcClient,
    private readonly logger: pino.Logger,
  ) {}

  async check(): Promise<PriceSignal> {
    const [cgResult, twapResult] = await Promise.allSettled([
      this.coinGecko.getTokenPrice(this.cfg.msUsdAddress),
      this.rpc.getTwapPrice(this.cfg.poolAddress),
    ])

    if (cgResult.status === 'rejected') {
      this.logger.warn({ err: cgResult.reason }, 'CoinGecko getTokenPrice failed')
    }
    if (twapResult.status === 'rejected') {
      this.logger.warn({ err: twapResult.reason }, 'RPC getTwapPrice failed')
    }

    const signal = {
      coingecko: cgResult.status === 'fulfilled' ? cgResult.value.priceUsd : null,
      twap: twapResult.status === 'fulfilled' ? twapResult.value : null,
      fetchedAt: new Date(),
    }
    this.logger.debug({ coingecko: signal.coingecko, twap: signal.twap }, 'PriceMonitor signal')
    return signal
  }
}
