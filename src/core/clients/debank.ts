// src/core/clients/debank.ts
import { withRetry } from '../retry.js'
import { RequestCache } from '../cache.js'
import type pino from 'pino'

export interface DeBankConfig {
  baseUrl: string
  accessKey: string
  timeoutMs: number
  retryAttempts: number
}

export interface UserProtocolPosition {
  netUsdValue: number
  assetUsdValue: number
  debtUsdValue: number
  rewardUsdValue: number
  supplyTokenPrices: Record<string, number>
  fetchedAt: Date
}

export interface ProtocolTvl {
  tvlUsd: number
  fetchedAt: Date
}

export interface WalletToken {
  id: string
  symbol: string
  amount: number
  priceUsd: number
  usdValue: number
  chain: string
}

export class DeBankClient {
  private readonly requestCache = new RequestCache(50_000)

  constructor(private readonly cfg: DeBankConfig, private readonly logger?: pino.Logger) {}

  async getUserProtocolPosition(walletAddress: string, protocolId: string, poolId?: string): Promise<UserProtocolPosition> {
    return this.requestCache.get(`position:${walletAddress}:${protocolId}:${poolId ?? ''}`, async () => {
      const url = `${this.cfg.baseUrl}/user/protocol?id=${walletAddress}&protocol_id=${protocolId}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await this.fetch(url) as any
      const allItems = (raw.portfolio_item_list ?? []) as Array<{
        pool?: { id?: string }
        stats: { net_usd_value: number; asset_usd_value: number; debt_usd_value: number }
        detail?: {
          supply_token_list?: Array<{ id: string; price: number }>
          reward_token_list?: Array<{ amount: number; price: number }>
        }
      }>
      const items = poolId
        ? allItems.filter(item => item.pool?.id?.toLowerCase() === poolId.toLowerCase())
        : allItems
      const total = items.reduce((acc, item) => {
        const rewardUsdValue = item.detail?.reward_token_list?.reduce(
          (s, t) => s + t.amount * t.price, 0,
        ) ?? 0
        const supplyTokenPrices = Object.fromEntries(
          item.detail?.supply_token_list?.map(t => [t.id.toLowerCase(), t.price]) ?? [],
        )
        return {
          netUsdValue: acc.netUsdValue + (item.stats.net_usd_value ?? 0),
          assetUsdValue: acc.assetUsdValue + (item.stats.asset_usd_value ?? 0),
          debtUsdValue: acc.debtUsdValue + (item.stats.debt_usd_value ?? 0),
          rewardUsdValue: acc.rewardUsdValue + rewardUsdValue,
          supplyTokenPrices: { ...acc.supplyTokenPrices, ...supplyTokenPrices },
        }
      }, { netUsdValue: 0, assetUsdValue: 0, debtUsdValue: 0, rewardUsdValue: 0, supplyTokenPrices: {} as Record<string, number> })
      return { ...total, fetchedAt: new Date() }
    })
  }

  async getProtocolTvl(protocolId: string): Promise<ProtocolTvl> {
    return this.requestCache.get(`protocol:${protocolId}`, async () => {
      const url = `${this.cfg.baseUrl}/protocol?id=${protocolId}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await this.fetch(url) as any
      return {
        tvlUsd: raw.tvl as number,
        fetchedAt: new Date(),
      }
    })
  }

  async getWalletTokens(walletAddress: string, chain: string): Promise<WalletToken[]> {
    return this.requestCache.get(`tokens:${walletAddress}:${chain}`, async () => {
      const url = `${this.cfg.baseUrl}/user/token_list?id=${walletAddress}&chain_id=${chain}&is_all=false`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await this.fetch(url) as any[]
      return raw.map(t => ({
        id: t.id as string,
        symbol: t.symbol as string,
        amount: t.amount as number,
        priceUsd: t.price as number,
        usdValue: (t.amount as number) * (t.price as number),
        chain: t.chain as string,
      }))
    })
  }

  private async fetch(url: string): Promise<unknown> {
    return withRetry(
      async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
        const t0 = Date.now()
        this.logger?.debug({ url }, 'DeBank →')
        try {
          const res = await globalThis.fetch(url, {
            headers: { AccessKey: this.cfg.accessKey },
            signal: controller.signal,
          })
          this.logger?.debug({ url, status: res.status, durationMs: Date.now() - t0 }, 'DeBank ←')
          if (!res.ok) throw new Error(`DeBank API error: ${res.status}`)
          return res.json()
        } finally {
          clearTimeout(timeout)
        }
      },
      { maxAttempts: this.cfg.retryAttempts, baseDelayMs: 500, maxDelayMs: 5_000 },
    )
  }

}
