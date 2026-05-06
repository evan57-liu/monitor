// src/protocols/aerodrome/price-floor.ts
import type { AllSignals } from './types.js'

export interface PriceFloorResult {
  ok: boolean
  effectivePrice: number | null
  sources: { coingecko: number | null; twap: number | null; debank: number | null }
  reason: 'ok' | 'below_floor' | 'all_sources_unavailable'
}

/**
 * 检查 max(coingecko, on-chain TWAP, debank) 是否 ≥ 价格地板。
 *
 * pool.poolPriceUsd 不纳入：它由 MarketMonitor 用 coingecko 数据推导，重复计入会双计数。
 *
 * fail-closed 语义：三源全部不可用时，若 failClosed=true 则返回 ok=false。
 * 这意味着"不知道价格就不撤"，是有意取舍——价格源全挂时运维应手动介入。
 */
export function checkPriceFloor(
  signals: AllSignals,
  floor: number,
  failClosed: boolean,
): PriceFloorResult {
  const sources = {
    coingecko: signals.price?.coingecko ?? null,
    twap: signals.price?.twap ?? null,
    debank: signals.position?.debankMsUsdPrice ?? null,
  }
  const available = Object.values(sources).filter((v): v is number => v !== null)
  if (available.length === 0) {
    return { ok: !failClosed, effectivePrice: null, sources, reason: 'all_sources_unavailable' }
  }
  const effectivePrice = Math.max(...available)
  return {
    ok: effectivePrice >= floor,
    effectivePrice,
    sources,
    reason: effectivePrice >= floor ? 'ok' : 'below_floor',
  }
}
