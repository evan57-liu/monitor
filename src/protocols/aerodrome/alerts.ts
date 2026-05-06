// src/protocols/aerodrome/alerts.ts
import { AlertLevel, AlertType } from '../../core/types.js'
import type { PriceFloorResult } from './price-floor.js'

const MSUSD_UNIT = 10n ** 18n
import type { Alert } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'
import type { AllSignals } from './types.js'
import type { HistoryStore } from './history-store.js'

export type AlertStateEntry = {
  firstTriggered: Date
  confirmations: Set<string>
  lastData: Record<string, unknown>
}
export type AlertState = Map<AlertType, AlertStateEntry>

export function evaluateAlerts(
  state: AlertState,
  signals: AllSignals,
  cfg: AerodromeConfig,
  protocol: string,
  historyStore: HistoryStore,
  walletAddress: string,
): Alert[] {
  const now = new Date()
  const alerts: Alert[] = []

  const push = (result: Alert | null) => { if (result) alerts.push(result) }
  push(evaluateDepeg(state, signals, cfg, protocol, now))
  push(evaluateHackMint(state, signals, cfg, protocol, now, historyStore))
  push(evaluateLiquidityDrain(state, signals, cfg, protocol, now, historyStore))
  push(evaluateInsiderExit(state, signals, cfg, protocol, now))
  push(evaluatePositionDrop(state, signals, cfg, protocol, now, historyStore, walletAddress))

  return alerts
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function buildAlert(
  type: AlertType,
  state: AlertState,
  confirmations: Set<string>,
  data: Record<string, unknown>,
  cfg: { sustainedSeconds?: number; requiredConfirmations?: number },
  protocol: string,
  title: string,
  now: Date,
): Alert | null {
  if (confirmations.size === 0) { state.delete(type); return null }

  const existing = state.get(type)
  if (existing) {
    existing.confirmations = confirmations  // 替换而非累积：确认集合反映当前状态，避免过期信号污染
    existing.lastData = data
  } else {
    state.set(type, { firstTriggered: now, confirmations, lastData: data })
  }

  const entry = state.get(type)!
  const sustainedMs = now.getTime() - entry.firstTriggered.getTime()
  const requiredSustainedMs = (cfg.sustainedSeconds ?? 0) * 1000
  const requiredConfirmations = cfg.requiredConfirmations ?? 1
  const actualConfirmations = entry.confirmations.size

  const isRed = sustainedMs >= requiredSustainedMs && actualConfirmations >= requiredConfirmations
  return {
    id: crypto.randomUUID(),
    type,
    level: isRed ? AlertLevel.RED : AlertLevel.WARNING,
    protocol,
    title,
    message: formatMessage(type, data, sustainedMs, actualConfirmations),
    data,
    triggeredAt: now,
    confirmations: actualConfirmations,
    requiredConfirmations,
    sustainedMs,
    requiredSustainedMs,
  }
}

function formatMessage(type: AlertType, data: Record<string, unknown>, sustainedMs: number, confirmations: number): string {
  const mins = Math.round(sustainedMs / 60_000)
  return `**Type:** ${type}\n**Sustained:** ${mins}m\n**Confirmations:** ${confirmations}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``
}

// ── 告警规则 ──────────────────────────────────────────────────────────────────

function evaluateDepeg(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date): Alert | null {
  const { price, pool, position } = signals
  const t = cfg.alerts.depeg
  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  if (price?.coingecko !== null && price?.coingecko !== undefined) {
    data.coingeckoPrice_usd = price.coingecko
    if (price.coingecko < t.priceThreshold) confirmations.add('coingecko')
  }
  if (price?.twap !== null && price?.twap !== undefined) {
    data.twapPrice_usd = price.twap
    if (price.twap < t.twapThreshold) confirmations.add('twap')
  }
  if (pool !== null) {
    data.msUsdRatio = pool.msUsdRatio
    data.poolPriceUsd = pool.poolPriceUsd
    if (pool.msUsdRatio > t.poolImbalancePct / 100) confirmations.add('pool')
  }
  if (position?.debankMsUsdPrice !== null && position?.debankMsUsdPrice !== undefined) {
    data.debankPrice_usd = position.debankMsUsdPrice
    if (position.debankMsUsdPrice < t.priceThreshold) confirmations.add('debank')
  }

  return buildAlert(AlertType.DEPEG, state, confirmations, data, t, protocol,
    `msUSD Depeg: ${price?.coingecko !== null && price?.coingecko !== undefined ? `$${price.coingecko.toFixed(4)}` : 'price unavailable'}`, now)
}

function evaluateHackMint(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date, historyStore: HistoryStore): Alert | null {
  const { supply, price, pool } = signals
  const t = cfg.alerts.hackMint
  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  if (supply !== null) {
    const windowStart = new Date(now.getTime() - t.supplyWindowSeconds * 1000)
    const baseline = historyStore.getSupplyAtOrBefore(cfg.msUsdAddress, windowStart)
    if (baseline !== null && baseline > 0n) {
      const increasePct = Number((supply.totalSupply - baseline) * 10000n / baseline) / 100
      data.supplyIncreasePct = increasePct
      data.supplyWindowSeconds = t.supplyWindowSeconds
      data.totalSupply_msusd = Number(supply.totalSupply / MSUSD_UNIT)
      if (increasePct >= t.supplyIncreasePct) confirmations.add('supply')
    }
  }
  if (price?.coingecko !== null && price?.coingecko !== undefined) {
    const dropPct = (1 - price.coingecko) * 100
    data.priceDropPct = dropPct
    if (dropPct >= t.priceDropPct) confirmations.add('price')
  }
  if (pool !== null && pool.buys1h > 0) {
    const sellsRatio = pool.sells1h / pool.buys1h
    data.sellsRatio = sellsRatio
    if (sellsRatio >= t.sellsSpikeMultiplier) confirmations.add('sells')
  }

  return buildAlert(AlertType.HACK_MINT, state, confirmations, data, { sustainedSeconds: 60, requiredConfirmations: 2 }, protocol, 'msUSD Hack Mint Detected', now)
}

function evaluateLiquidityDrain(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date, historyStore: HistoryStore): Alert | null {
  const { protocol: proto, pool } = signals
  const t = cfg.alerts.liquidityDrain
  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  if (proto !== null) {
    const windowStart = new Date(now.getTime() - t.tvlWindowSeconds * 1000)
    const baseline = historyStore.getProtocolTvlAtOrBefore(protocol, windowStart)
    if (baseline !== null && baseline > 0) {
      const dropPct = ((baseline - proto.tvlUsd) / baseline) * 100
      data.tvlDropPct = dropPct
      data.tvlWindowSeconds = t.tvlWindowSeconds
      data.tvlUsd = proto.tvlUsd
      if (dropPct >= t.tvlDropPct) confirmations.add('tvl')
    }
  }
  if (pool !== null) {
    data.msUsdRatio = pool.msUsdRatio
    data.sellsBuysRatio = pool.buys1h > 0 ? pool.sells1h / pool.buys1h : pool.sells1h
    if (pool.msUsdRatio > t.poolMsUsdRatioPct / 100) confirmations.add('pool')
    if (pool.buys1h > 0 && pool.sells1h / pool.buys1h >= t.sellsBuysRatio) confirmations.add('sells')
  }

  return buildAlert(AlertType.LIQUIDITY_DRAIN, state, confirmations, data, { sustainedSeconds: 120, requiredConfirmations: 2 }, protocol, 'Liquidity Drain Detected', now)
}

function evaluateInsiderExit(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date): Alert | null {
  const { wallets, price } = signals
  const t = cfg.alerts.insiderExit
  if (!wallets || wallets.length === 0) { state.delete(AlertType.INSIDER_EXIT); return null }

  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  for (const wallet of wallets) {
    if (wallet.previousMsUsdAmount !== null) {
      const soldAmount = wallet.previousMsUsdAmount - wallet.msUsdAmount
      const pricePerToken = wallet.msUsdAmount > 0 ? wallet.msUsdUsdValue / wallet.msUsdAmount : 1
      const outflowUsd = soldAmount * pricePerToken
      if (outflowUsd >= t.largeOutflowUsd) {
        confirmations.add('wallet')
        data.wallet = wallet.walletAddress
        data.outflowUsd = outflowUsd
      }
    }
  }
  if (price?.coingecko !== null && price?.coingecko !== undefined) {
    const dropPct = (1 - price.coingecko) * 100
    data.priceDropPct = dropPct
    if (dropPct >= t.priceDropPct) confirmations.add('price')
  }

  return buildAlert(AlertType.INSIDER_EXIT, state, confirmations, data, { sustainedSeconds: 60, requiredConfirmations: 2 }, protocol, 'Insider Exit Signal', now)
}

// 用 WITHDRAWAL_ABORTED 而非 DATA_SOURCE_FAILURE，确保审计日志语义清晰。
export function buildPriceFloorAbortAlert(
  triggeringAlerts: Alert[],
  floor: PriceFloorResult,
  floorValue: number,
  protocol: string,
): Alert {
  const now = new Date()
  const priceStr = floor.effectivePrice !== null ? `$${floor.effectivePrice.toFixed(4)}` : 'unavailable'
  const floorStr = `$${floorValue.toFixed(2)}`
  const title = floor.reason === 'all_sources_unavailable'
    ? '⚠️ ALL PRICE SOURCES DOWN — Withdrawal aborted, MANUAL ACTION MAY BE REQUIRED'
    : `Withdrawal aborted: price floor breach (${priceStr} < ${floorStr})`
  return {
    id: crypto.randomUUID(),
    type: AlertType.WITHDRAWAL_ABORTED,
    level: AlertLevel.WARNING,
    protocol,
    title,
    message: `**Reason:** ${floor.reason}\n**Effective price:** ${priceStr}\n**Floor:** ${floorStr}\n**Sources:** ${JSON.stringify(floor.sources)}\n**Suppressed alerts:** ${triggeringAlerts.map(a => a.type).join(', ')}`,
    data: { reason: floor.reason, effectivePrice: floor.effectivePrice, floorValue, sources: floor.sources, triggeringTypes: triggeringAlerts.map(a => a.type) },
    triggeredAt: now,
    confirmations: 0,
    requiredConfirmations: 0,
    sustainedMs: 0,
    requiredSustainedMs: 0,
  }
}

function evaluatePositionDrop(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date, historyStore: HistoryStore, walletAddress: string): Alert | null {
  const { position } = signals
  const t = cfg.alerts.positionDrop
  if (!position) { state.delete(AlertType.POSITION_DROP); return null }

  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  const windowStart = new Date(now.getTime() - t.windowSeconds * 1000)
  const baseline = historyStore.getPositionAtOrBefore(protocol, walletAddress, windowStart)
  if (baseline !== null && baseline > 0) {
    const dropPct = ((baseline - position.netUsdValue) / baseline) * 100
    data.dropPct = dropPct
    data.windowSeconds = t.windowSeconds
    data.currentValue_usd = position.netUsdValue
    data.baselineValue_usd = baseline
    if (dropPct >= t.dropPct) confirmations.add('position')
  }

  const dropStr = typeof data.dropPct === 'number' ? (data.dropPct as number).toFixed(1) : '?'
  return buildAlert(AlertType.POSITION_DROP, state, confirmations, data,
    { sustainedSeconds: t.sustainedSeconds, requiredConfirmations: t.requiredConfirmations },
    protocol, `Position Value Drop: -${dropStr}%`, now)
}
