// src/core/clients/coingecko.ts
import { withRetry } from '../retry.js'

export interface CoinGeckoConfig {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  retryAttempts: number
}

export interface TokenPrice {
  priceUsd: number
  priceChange24hPct: number
  fetchedAt: Date
}

export interface PoolData {
  reserveInUsd: number
  baseTokenPriceUsd: number
  volume24h: number
  buys1h: number
  sells1h: number
  buys24h: number
  sells24h: number
  reserve0Raw: string
  reserve1Raw: string
  fetchedAt: Date
}

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

export class CoinGeckoClient {
  private cache = new Map<string, CacheEntry<unknown>>()
  private readonly ttlMs = 8_000 // 8s — safe for 10s polling interval

  constructor(private readonly cfg: CoinGeckoConfig) {}

  async getTokenPrice(tokenAddress: string): Promise<TokenPrice> {
    return this.cached(`token:${tokenAddress}`, async () => {
      const url = `${this.cfg.baseUrl}/onchain/networks/base/tokens/${tokenAddress}`
      const raw = await this.fetch(url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attrs = (raw as any).data.attributes
      return {
        priceUsd: parseFloat(attrs.price_usd as string),
        priceChange24hPct: parseFloat(attrs.price_change_percentage.h24 as string),
        fetchedAt: new Date(),
      }
    })
  }

  async getPoolData(poolAddress: string): Promise<PoolData> {
    return this.cached(`pool:${poolAddress}`, async () => {
      const url = `${this.cfg.baseUrl}/onchain/networks/base/pools/${poolAddress}`
      const raw = await this.fetch(url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attrs = (raw as any).data.attributes
      return {
        reserveInUsd: parseFloat(attrs.reserve_in_usd as string),
        baseTokenPriceUsd: parseFloat(attrs.base_token_price_usd as string),
        volume24h: parseFloat(attrs.volume_usd.h24 as string),
        buys1h: attrs.transactions.h1.buys as number,
        sells1h: attrs.transactions.h1.sells as number,
        buys24h: attrs.transactions.h24.buys as number,
        sells24h: attrs.transactions.h24.sells as number,
        reserve0Raw: attrs.reserve0 as string,
        reserve1Raw: attrs.reserve1 as string,
        fetchedAt: new Date(),
      }
    })
  }

  private async fetch(url: string): Promise<unknown> {
    return withRetry(
      async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
        try {
          const res = await globalThis.fetch(url, {
            headers: { 'x-cg-pro-api-key': this.cfg.apiKey },
            signal: controller.signal,
          })
          if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`)
          return res.json()
        } finally {
          clearTimeout(timeout)
        }
      },
      { maxAttempts: this.cfg.retryAttempts, baseDelayMs: 500, maxDelayMs: 5_000 },
    )
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.data as T
    const data = await fn()
    this.cache.set(key, { data, expiresAt: Date.now() + this.ttlMs })
    return data
  }
}
