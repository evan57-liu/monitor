// src/protocols/aerodrome/monitors/price.ts
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { PriceSignal } from '../types.js'
import type pino from 'pino'

interface PriceMonitorConfig {
  poolAddress: `0x${string}`
  token0Decimals: number
  token1Decimals: number
}

export class PriceMonitor {
  constructor(
    private readonly cfg: PriceMonitorConfig,
    private readonly coinGecko: CoinGeckoClient,
    private readonly rpc: RpcClient,
    private readonly logger: pino.Logger,
  ) {}

  async check(): Promise<PriceSignal> {
    const [poolResult, twapResult] = await Promise.allSettled([
      this.coinGecko.getPoolData(this.cfg.poolAddress),
      this.rpc.getTwapPrice(this.cfg.poolAddress, this.cfg.token0Decimals, this.cfg.token1Decimals),
    ])

    if (poolResult.status === 'rejected') {
      this.logger.warn({ err: poolResult.reason }, 'CoinGecko getPoolData (price) failed')
    }
    if (twapResult.status === 'rejected') {
      this.logger.warn({ err: twapResult.reason }, 'RPC getTwapPrice failed')
    }

    const signal = {
      coingecko: poolResult.status === 'fulfilled' ? poolResult.value.baseTokenPriceUsd : null,
      twap: twapResult.status === 'fulfilled' ? twapResult.value : null,
      fetchedAt: new Date(),
    }
    this.logger.debug({ coingecko: signal.coingecko, twap: signal.twap }, 'PriceMonitor signal')
    return signal
  }
}
