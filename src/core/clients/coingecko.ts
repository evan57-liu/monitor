// src/core/clients/coingecko.ts
import { withRetry } from '../retry.js'
import { RequestCache } from '../cache.js'
import type pino from 'pino'

export interface CoinGeckoConfig {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  retryAttempts: number
}

export interface TokenPrice {
  priceUsd: number
  fetchedAt: Date
}

export interface PoolData {
  reserveInUsd: number
  baseTokenPriceUsd: number   // msUSD price (USD) derived from pool AMM
  quotePriceUsd: number       // USDC price (USD) — should stay ≈1.0; deviation means USDC stress
  volume24h: number
  buys1h: number
  sells1h: number
  buys24h: number
  sells24h: number
  fetchedAt: Date
}

export class CoinGeckoClient {
  private readonly requestCache = new RequestCache(8_000)

  constructor(private readonly cfg: CoinGeckoConfig, private readonly logger?: pino.Logger) {}

  async getTokenPrice(tokenAddress: string): Promise<TokenPrice> {
    return this.requestCache.get(`token:${tokenAddress}`, async () => {
      const url = `${this.cfg.baseUrl}/onchain/simple/networks/base/token_price/${tokenAddress}`
      const raw = await this.fetch(url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokenPrices = (raw as any).data.attributes.token_prices as Record<string, string>
      const priceStr = tokenPrices[tokenAddress]
      if (!priceStr) throw new Error(`CoinGecko returned no price for token ${tokenAddress}`)
      return {
        priceUsd: parseFloat(priceStr),
        fetchedAt: new Date(),
      }
    })
  }

  async getPoolData(poolAddress: string): Promise<PoolData> {
    return this.requestCache.get(`pool:${poolAddress}`, async () => {
      const url = `${this.cfg.baseUrl}/onchain/networks/base/pools/${poolAddress}`
      const raw = await this.fetch(url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attrs = (raw as any).data.attributes
      return {
        reserveInUsd: parseFloat(attrs.reserve_in_usd as string),
        baseTokenPriceUsd: parseFloat(attrs.base_token_price_usd as string),
        quotePriceUsd: parseFloat(attrs.quote_token_price_usd as string),
        volume24h: parseFloat(attrs.volume_usd.h24 as string),
        buys1h: attrs.transactions.h1.buys as number,
        sells1h: attrs.transactions.h1.sells as number,
        buys24h: attrs.transactions.h24.buys as number,
        sells24h: attrs.transactions.h24.sells as number,
        fetchedAt: new Date(),
      }
    })
  }

  private async fetch(url: string): Promise<unknown> {
    return withRetry(
      async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
        const t0 = Date.now()
        this.logger?.debug({ url }, 'CoinGecko →')
        try {
          const res = await globalThis.fetch(url, {
            headers: { 'x-cg-pro-api-key': this.cfg.apiKey },
            signal: controller.signal,
          })
          this.logger?.debug({ url, status: res.status, durationMs: Date.now() - t0 }, 'CoinGecko ←')
          if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`)
          return res.json()
        } finally {
          clearTimeout(timeout)
        }
      },
      { maxAttempts: this.cfg.retryAttempts, baseDelayMs: 500, maxDelayMs: 5_000 },
    )
  }
}
