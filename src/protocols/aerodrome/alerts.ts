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
  push(evaluateOutOfRange(state, signals, cfg, protocol, now))

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
  const detail = formatAlertDetail(type, data)
  return [
    `**持续时间：** ${mins} 分钟　｜　**确认数：** ${confirmations}`,
    '',
    detail,
    '',
    '---',
    '',
    '**原始数据**',
    '',
    `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
  ].join('\n')
}

function n(v: unknown, fn: (x: number) => string, fallback = '—'): string {
  return typeof v === 'number' ? fn(v) : fallback
}

function formatAlertDetail(type: AlertType, data: Record<string, unknown>): string {
  switch (type) {
    case AlertType.HACK_MINT: {
      const windowH = n(data.supplyWindowSeconds, v => `${v / 3600}小时`)
      return [
        `**供应量增幅（过去${windowH}）：** ${n(data.supplyIncreasePct, v => `+${v.toFixed(2)}%`)}`,
        `**当前总供应量：** ${n(data.totalSupply_msusd, v => v.toLocaleString('en-US'))} msUSD`,
        `**价格偏离锚定：** ${n(data.priceDropPct, v => `−${v.toFixed(3)}%（当前约 $${(1 - v / 100).toFixed(4)}）`)}`,
        `**卖出/买入比（1小时）：** ${data.sellsRatio === 'Infinity' ? '∞（无买单）' : n(data.sellsRatio, v => v.toFixed(2))}`,
      ].join('\n')
    }
    case AlertType.DEPEG: {
      const priceParts = [
        data.coingeckoPrice_usd !== undefined ? `CoinGecko $${n(data.coingeckoPrice_usd, v => v.toFixed(4))}` : null,
        data.twapPrice_usd !== undefined ? `TWAP $${n(data.twapPrice_usd, v => v.toFixed(4))}` : null,
        data.debankPrice_usd !== undefined ? `DeBank $${n(data.debankPrice_usd, v => v.toFixed(4))}` : null,
      ].filter((x): x is string => x !== null)
      return [
        `**当前价格：** ${priceParts.length > 0 ? priceParts.join('　/　') : '—'}`,
        `**池子 msUSD 占比：** ${n(data.msUsdRatio, v => `${(v * 100).toFixed(2)}%`)}`,
        `**池子价格：** ${data.poolPriceUsd !== undefined ? `$${n(data.poolPriceUsd, v => v.toFixed(4))}` : '—'}`,
      ].join('\n')
    }
    case AlertType.LIQUIDITY_DRAIN: {
      const windowH = n(data.tvlWindowSeconds, v => `${v / 3600}小时`)
      return [
        `**TVL 下降（过去${windowH}）：** ${n(data.tvlDropPct, v => `−${v.toFixed(2)}%`)}`,
        `**当前 TVL：** ${n(data.tvlUsd, v => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`)}`,
        `**池子 msUSD 占比：** ${n(data.msUsdRatio, v => `${(v * 100).toFixed(2)}%`)}`,
        `**卖出/买入比（1小时）：** ${data.sellsBuysRatio === 'Infinity' ? '∞（无买单）' : n(data.sellsBuysRatio, v => v.toFixed(2))}`,
      ].join('\n')
    }
    case AlertType.INSIDER_EXIT:
      return [
        `**钱包地址：** \`${String(data.wallet ?? '—')}\``,
        `**流出金额：** ${n(data.outflowUsd, v => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)}`,
        `**价格偏离锚定：** ${n(data.priceDropPct, v => `−${v.toFixed(3)}%（当前约 $${(1 - v / 100).toFixed(4)}）`)}`,
      ].join('\n')
    case AlertType.POSITION_DROP: {
      const windowH = n(data.windowSeconds, v => `${(v / 3600).toFixed(0)}小时`)
      return [
        `**仓位价值下跌（过去${windowH}）：** ${n(data.dropPct, v => `−${v.toFixed(2)}%`)}`,
        `**当前仓位价值：** ${n(data.currentValue_usd, v => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)}`,
        `**基准仓位价值：** ${n(data.baselineValue_usd, v => `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`)}`,
      ].join('\n')
    }
    default:
      return ''
  }
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
    `msUSD 价格脱钩：${price?.coingecko !== null && price?.coingecko !== undefined ? `$${price.coingecko.toFixed(4)}` : '价格数据不可用'}`, now)
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
    // 以距 $1 锚定价的偏差为度量（而非相对于历史价格的跌幅）：dropPct = (1 - price) * 100
    const dropPct = (1 - price.coingecko) * 100
    data.priceDropPct = dropPct
    if (dropPct >= t.priceDropPct) confirmations.add('price')
  }
  if (pool !== null) {
    const sellsRatio = pool.buys1h > 0 ? pool.sells1h / pool.buys1h : (pool.sells1h > 0 ? Infinity : 0)
    data.sellsRatio = isFinite(sellsRatio) ? sellsRatio : 'Infinity'
    if (sellsRatio >= t.sellsSpikeMultiplier) confirmations.add('sells')
  }

  const hackMintAlert = buildAlert(AlertType.HACK_MINT, state, confirmations, data, { sustainedSeconds: 60, requiredConfirmations: 2 }, protocol, 'msUSD 异常铸造检测', now)
  return hackMintAlert?.level === AlertLevel.RED ? hackMintAlert : null
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
    const sellsBuysRatio = pool.buys1h > 0 ? pool.sells1h / pool.buys1h : (pool.sells1h > 0 ? Infinity : 0)
    data.msUsdRatio = pool.msUsdRatio
    data.sellsBuysRatio = isFinite(sellsBuysRatio) ? sellsBuysRatio : 'Infinity'
    if (pool.msUsdRatio > t.poolMsUsdRatioPct / 100) confirmations.add('pool')
    if (sellsBuysRatio >= t.sellsBuysRatio) confirmations.add('sells')
  }

  const liquidityAlert = buildAlert(AlertType.LIQUIDITY_DRAIN, state, confirmations, data, { sustainedSeconds: 120, requiredConfirmations: 2 }, protocol, '流动性抽取告警', now)
  return liquidityAlert?.level === AlertLevel.RED ? liquidityAlert : null
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
    // 以距 $1 锚定价的偏差为度量（而非相对于历史价格的跌幅）：dropPct = (1 - price) * 100
    const dropPct = (1 - price.coingecko) * 100
    data.priceDropPct = dropPct
    if (dropPct >= t.priceDropPct) confirmations.add('price')
  }

  const insiderAlert = buildAlert(AlertType.INSIDER_EXIT, state, confirmations, data, { sustainedSeconds: 60, requiredConfirmations: 2 }, protocol, '内部套现信号', now)
  return insiderAlert?.level === AlertLevel.RED ? insiderAlert : null
}

function evaluateOutOfRange(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date): Alert | null {
  const t = cfg.alerts.positionOutOfRange
  const position = signals.position
  if (!position || position.supplyTokens.length < 2) {
    state.delete(AlertType.POSITION_OUT_OF_RANGE)
    return null
  }

  const totalUsd = position.supplyTokens.reduce((s, x) => s + x.usdValue, 0)
  if (totalUsd <= 0) {
    state.delete(AlertType.POSITION_OUT_OF_RANGE)
    return null
  }

  const shares = position.supplyTokens.map(x => ({ ...x, sharePct: (x.usdValue / totalUsd) * 100 }))
  const minShare = Math.min(...shares.map(x => x.sharePct))
  const isOutOfRange = minShare < t.minTokenSharePct

  if (!isOutOfRange) {
    state.delete(AlertType.POSITION_OUT_OF_RANGE)
    return null
  }

  const entry = state.get(AlertType.POSITION_OUT_OF_RANGE)
  if (!entry) {
    state.set(AlertType.POSITION_OUT_OF_RANGE, {
      firstTriggered: now,
      confirmations: new Set(['range']),
      lastData: { minShare, shares, lastNotifiedAt: 0 },
    })
    return null
  }

  const sustainedMs = now.getTime() - entry.firstTriggered.getTime()
  if (sustainedMs < t.sustainedSeconds * 1000) {
    entry.lastData = { ...entry.lastData, minShare, shares }
    return null
  }

  const rawNotified = entry.lastData['lastNotifiedAt']
  const lastNotifiedAt = typeof rawNotified === 'number' ? rawNotified : 0
  if (lastNotifiedAt > 0 && now.getTime() - lastNotifiedAt < t.cooldownSeconds * 1000) {
    return null
  }

  entry.lastData = { ...entry.lastData, minShare, shares, lastNotifiedAt: now.getTime() }

  const [dominantToken, minorityToken] = shares.reduce<[typeof shares[0], typeof shares[0]]>(
    ([dom, min], x) => [x.sharePct > dom.sharePct ? x : dom, x.sharePct < min.sharePct ? x : min],
    [shares[0]!, shares[0]!],
  )

  return {
    id: crypto.randomUUID(),
    type: AlertType.POSITION_OUT_OF_RANGE,
    level: AlertLevel.WARNING,
    protocol,
    title: `LP 超出价格区间 — 需手动再平衡（${minorityToken.symbol} ${minShare.toFixed(2)}%）`,
    message: [
      `**持续时间：** ${Math.round(sustainedMs / 60_000)} 分钟`,
      '',
      `**主导代币：** ${dominantToken.symbol}（占比 ${dominantToken.sharePct.toFixed(2)}%）`,
      `**少数代币：** ${minorityToken.symbol}（占比 ${minorityToken.sharePct.toFixed(2)}%）`,
      `**仓位净值：** $${position.netUsdValue.toFixed(2)}`,
      '',
      '---',
      '',
      '**原始数据**',
      '',
      `\`\`\`json\n${JSON.stringify({ shares, threshold: t.minTokenSharePct }, null, 2)}\n\`\`\``,
    ].join('\n'),
    data: { minSharePct: minShare, shares, totalUsd, threshold: t.minTokenSharePct },
    triggeredAt: now,
    confirmations: 1,
    requiredConfirmations: 1,
    sustainedMs,
    requiredSustainedMs: t.sustainedSeconds * 1000,
  }
}

// 用 WITHDRAWAL_ABORTED 而非 DATA_SOURCE_FAILURE，确保审计日志语义清晰。
export function buildPriceFloorAbortAlert(
  triggeringAlerts: Alert[],
  floor: PriceFloorResult,
  floorValue: number,
  protocol: string,
): Alert {
  const now = new Date()
  const priceStr = floor.effectivePrice !== null ? `$${floor.effectivePrice.toFixed(4)}` : '不可用'
  const floorStr = `$${floorValue.toFixed(2)}`
  const srcFmt = (v: number | null) => v !== null ? `$${v.toFixed(4)}` : '不可用'
  const title = floor.reason === 'all_sources_unavailable'
    ? '⚠️ 全部价格来源不可用 — 撤出已中止，请人工介入'
    : `撤出已中止：价格低于地板价（${priceStr} < ${floorStr}）`
  const triggeringTypes = triggeringAlerts.map(a => a.type)
  const data = { reason: floor.reason, effectivePrice: floor.effectivePrice, floorValue, sources: floor.sources, triggeringTypes }
  const message = [
    `**原因：** ${{ ok: '价格正常', below_floor: '价格低于地板价', all_sources_unavailable: '全部价格来源不可用' }[floor.reason] ?? floor.reason}`,
    `**有效价格：** ${priceStr}`,
    `**价格地板：** ${floorStr}`,
    `**价格来源：** CoinGecko ${srcFmt(floor.sources.coingecko)}　TWAP ${srcFmt(floor.sources.twap)}　DeBank ${srcFmt(floor.sources.debank)}`,
    `**被抑制告警：** ${triggeringTypes.join('、')}`,
    '',
    '---',
    '',
    '**原始数据**',
    '',
    `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
  ].join('\n')
  return {
    id: crypto.randomUUID(),
    type: AlertType.WITHDRAWAL_ABORTED,
    level: AlertLevel.WARNING,
    protocol,
    title,
    message,
    data,
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
    protocol, `仓位价值下跌 −${dropStr}%`, now)
}
