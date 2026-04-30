// src/protocols/aerodrome/alerts.ts
import { AlertLevel, AlertType } from '../../core/types.js'

const MSUSD_UNIT = 10n ** 18n
import type { Alert } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'
import type { AllSignals } from './types.js'

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
): Alert[] {
  const now = new Date()
  const alerts: Alert[] = []

  const push = (result: Alert | null) => { if (result) alerts.push(result) }
  push(evaluateDepeg(state, signals, cfg, protocol, now))
  push(evaluateHackMint(state, signals, cfg, protocol, now))
  push(evaluateLiquidityDrain(state, signals, cfg, protocol, now))
  push(evaluateInsiderExit(state, signals, cfg, protocol, now))
  push(evaluatePositionDrop(state, signals, cfg, protocol, now))

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
    if (pool.poolPriceUsd < t.priceThreshold) confirmations.add('poolPrice')
  }
  if (position?.debankMsUsdPrice !== null && position?.debankMsUsdPrice !== undefined) {
    data.debankPrice_usd = position.debankMsUsdPrice
    if (position.debankMsUsdPrice < t.priceThreshold) confirmations.add('debank')
  }

  return buildAlert(AlertType.DEPEG, state, confirmations, data, t, protocol,
    `msUSD Depeg: ${price?.coingecko !== null && price?.coingecko !== undefined ? `$${price.coingecko.toFixed(4)}` : 'price unavailable'}`, now)
}

function evaluateHackMint(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date): Alert | null {
  const { supply, price, pool } = signals
  const t = cfg.alerts.hackMint
  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  if (supply !== null && supply.previousSupply !== null) {
    const prev = supply.previousSupply
    const increasePct = prev > 0n ? Number((supply.totalSupply - prev) * 10000n / prev) / 100 : 0
    data.supplyIncreasePct = increasePct
    data.totalSupply_msusd = Number(supply.totalSupply / MSUSD_UNIT)
    if (increasePct >= t.supplyIncreasePct) confirmations.add('supply')
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

function evaluateLiquidityDrain(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date): Alert | null {
  const { protocol: proto, pool } = signals
  const t = cfg.alerts.liquidityDrain
  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  if (proto !== null && proto.previousTvlUsd !== null) {
    const dropPct = ((proto.previousTvlUsd - proto.tvlUsd) / proto.previousTvlUsd) * 100
    data.tvlDropPct = dropPct
    data.tvlUsd = proto.tvlUsd
    if (dropPct >= t.tvlDropPct) confirmations.add('tvl')
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

function evaluatePositionDrop(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date): Alert | null {
  const { position } = signals
  const t = cfg.alerts.positionDrop
  if (!position) { state.delete(AlertType.POSITION_DROP); return null }

  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  if (position.previousNetUsdValue !== null && position.previousNetUsdValue > 0) {
    const dropPct = ((position.previousNetUsdValue - position.netUsdValue) / position.previousNetUsdValue) * 100
    data.dropPct = dropPct
    data.currentValue_usd = position.netUsdValue
    data.previousValue_usd = position.previousNetUsdValue
    if (dropPct >= t.dropPct) confirmations.add('position')
  }

  const dropStr = typeof data.dropPct === 'number' ? data.dropPct.toFixed(1) : '?'
  return buildAlert(AlertType.POSITION_DROP, state, confirmations, data, { sustainedSeconds: 0, requiredConfirmations: 1 }, protocol, `Position Value Drop: -${dropStr}%`, now)
}
