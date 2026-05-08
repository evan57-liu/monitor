// src/protocols/aerodrome/alerts.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { evaluateAlerts } from './alerts.js'
import { AlertLevel, AlertType } from '../../core/types.js'
import type { AllSignals, PoolSignal } from './types.js'
import type { AerodromeConfig } from '../../core/config.js'
import type { HistoryStore } from './history-store.js'

// Minimal config for tests
const cfg = {
  alerts: {
    depeg: { priceThreshold: 0.992, twapThreshold: 0.992, poolImbalancePct: 75, sustainedSeconds: 180, requiredConfirmations: 3 },
    hackMint: { supplyIncreasePct: 15, supplyWindowSeconds: 3600, priceDropPct: 2, sellsSpikeMultiplier: 5 },
    liquidityDrain: { tvlDropPct: 30, tvlWindowSeconds: 3600, poolMsUsdRatioPct: 70, sellsBuysRatio: 3 },
    insiderExit: { largeOutflowUsd: 50000, priceDropPct: 1 },
    positionDrop: { dropPct: 10, windowSeconds: 3600, sustainedSeconds: 300, requiredConfirmations: 1 },
    positionOutOfRange: { minTokenSharePct: 5, sustainedSeconds: 300, cooldownSeconds: 86400 },
  },
} as AerodromeConfig

const PROTOCOL_ID = 'aerodrome-msusd-usdc'
const WALLET = '0xself'

// ── HistoryStore stub ─────────────────────────────────────────────────────────

type HistoryPrefill = {
  supply?: Array<[Date, bigint]>
  tvl?: Array<[Date, number]>
  position?: Array<[Date, number]>
}

function makeHistoryStub(prefill: HistoryPrefill = {}): HistoryStore {
  const getAtOrBefore = <T>(entries: Array<[Date, T]> | undefined, before: Date): T | null => {
    if (!entries) return null
    const candidates = entries.filter(([d]) => d <= before)
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b[0].getTime() - a[0].getTime())
    return candidates[0]![1]
  }
  return {
    insertSupply: () => {},
    insertProtocolTvl: () => {},
    insertPosition: () => {},
    insertPrice: () => {},
    insertPool: () => {},
    getSupplyAtOrBefore: (_token, before) => getAtOrBefore(prefill.supply, before),
    getProtocolTvlAtOrBefore: (_protocol, before) => getAtOrBefore(prefill.tvl, before),
    getPositionAtOrBefore: (_protocol, _wallet, before) => getAtOrBefore(prefill.position, before),
  }
}

// ── Signal & state helpers ────────────────────────────────────────────────────

function makePool(overrides: Partial<PoolSignal> = {}): PoolSignal {
  return {
    reserveInUsd: 2_500_000, msUsdRatio: 0.5, poolPriceUsd: 1.0001,
    buys1h: 50, sells1h: 50, volume24h: 180_000,
    reserve0: 1_250_000n * 10n ** 18n, reserve1: 1_250_000n * 10n ** 6n,
    fetchedAt: new Date(), ...overrides,
  }
}

function makePosition(overrides: Partial<{ netUsdValue: number; rewardUsdValue: number; debankMsUsdPrice: number | null; supplyTokens: Array<{ id: string; symbol: string; amount: number; priceUsd: number; usdValue: number }> }> = {}) {
  return {
    netUsdValue: 18_000,
    rewardUsdValue: 100,
    debankMsUsdPrice: 1.0001 as number | null,
    supplyTokens: [] as Array<{ id: string; symbol: string; amount: number; priceUsd: number; usdValue: number }>,
    fetchedAt: new Date(),
    ...overrides,
  }
}

function makeSignals(overrides: Partial<AllSignals> = {}): AllSignals {
  return {
    price: { coingecko: 1.0001, twap: 1.0001, fetchedAt: new Date() },
    pool: makePool(),
    supply: { totalSupply: 1_000_000n * 10n ** 18n, fetchedAt: new Date() },
    position: makePosition(),
    protocol: { tvlUsd: 55_000_000, fetchedAt: new Date() },
    wallets: [],
    ...overrides,
  }
}

function stateWithAge(alertType: AlertType, ageMs: number, confirmationSources: string[]): Map<AlertType, { firstTriggered: Date; confirmations: Set<string>; lastData: Record<string, unknown> }> {
  const m = new Map()
  m.set(alertType, {
    firstTriggered: new Date(Date.now() - ageMs),
    confirmations: new Set(confirmationSources),
    lastData: {},
  })
  return m
}

function evaluate(state: ReturnType<typeof stateWithAge>, signals: AllSignals, historyStore: HistoryStore = makeHistoryStub()) {
  return evaluateAlerts(state, signals, cfg, PROTOCOL_ID, historyStore, WALLET)
}

// ── DEPEG ─────────────────────────────────────────────────────────────────────

describe('evaluateAlerts — depeg', () => {
  it('no alert when price is healthy', () => {
    const state = new Map()
    const alerts = evaluate(state, makeSignals())
    expect(alerts.find(a => a.type === AlertType.DEPEG)).toBeUndefined()
  })

  it('WARNING when condition just started (< sustainedSeconds)', () => {
    const state = stateWithAge(AlertType.DEPEG, 30_000, ['coingecko', 'twap', 'pool'])
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: 0.987, fetchedAt: new Date() },
      pool: makePool({ msUsdRatio: 0.78, poolPriceUsd: 0.985, buys1h: 20, sells1h: 100 }),
    })
    const alerts = evaluate(state, signals)
    const depeg = alerts.find(a => a.type === AlertType.DEPEG)
    expect(depeg?.level).toBe(AlertLevel.WARNING)
  })

  it('RED when condition sustained > 3 min and 3 of 4 sources confirm', () => {
    const state = stateWithAge(AlertType.DEPEG, 4 * 60 * 1000, ['coingecko', 'twap', 'pool'])
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: 0.987, fetchedAt: new Date() },
      pool: makePool({ msUsdRatio: 0.78, poolPriceUsd: 0.985, buys1h: 20, sells1h: 100 }),
    })
    const alerts = evaluate(state, signals)
    const depeg = alerts.find(a => a.type === AlertType.DEPEG)
    expect(depeg?.level).toBe(AlertLevel.RED)
    expect(depeg?.confirmations).toBe(3)
  })

  it('WARNING when sustained but only 2 of 4 sources confirm (twap null, debank unavailable)', () => {
    const state = stateWithAge(AlertType.DEPEG, 4 * 60 * 1000, ['coingecko', 'pool'])
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: null, fetchedAt: new Date() },
      pool: makePool({ msUsdRatio: 0.78, poolPriceUsd: 0.985, buys1h: 20, sells1h: 100 }),
      position: makePosition({ debankMsUsdPrice: null }),
    })
    const alerts = evaluate(state, signals)
    const depeg = alerts.find(a => a.type === AlertType.DEPEG)
    expect(depeg?.level).toBe(AlertLevel.WARNING)
  })

  it('clears state when condition resolves', () => {
    const state = stateWithAge(AlertType.DEPEG, 4 * 60 * 1000, ['coingecko', 'twap', 'pool'])
    evaluate(state, makeSignals())
    expect(state.has(AlertType.DEPEG)).toBe(false)
  })

  it('debank price below threshold adds debank confirmation source', () => {
    const state = new Map()
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: 0.987, fetchedAt: new Date() },
      pool: makePool({ msUsdRatio: 0.78, poolPriceUsd: 0.985, buys1h: 20, sells1h: 100 }),
      position: makePosition({ debankMsUsdPrice: 0.988 }),
    })
    evaluate(state, signals)
    expect(state.get(AlertType.DEPEG)?.confirmations.has('debank')).toBe(true)
  })

  it('RED when all 4 independent sources confirm', () => {
    const state = stateWithAge(AlertType.DEPEG, 4 * 60 * 1000, ['coingecko', 'twap', 'pool', 'debank'])
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: 0.987, fetchedAt: new Date() },
      pool: makePool({ msUsdRatio: 0.78, poolPriceUsd: 0.985, buys1h: 20, sells1h: 100 }),
      position: makePosition({ debankMsUsdPrice: 0.988 }),
    })
    const alerts = evaluate(state, signals)
    const depeg = alerts.find(a => a.type === AlertType.DEPEG)
    expect(depeg?.level).toBe(AlertLevel.RED)
    expect(depeg?.confirmations).toBe(4)
  })

  it('WARNING when only 2 of 4 sources confirm (twap null, debank healthy)', () => {
    const state = stateWithAge(AlertType.DEPEG, 4 * 60 * 1000, ['coingecko', 'pool'])
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: null, fetchedAt: new Date() },
      pool: makePool({ msUsdRatio: 0.78, poolPriceUsd: 0.985, buys1h: 20, sells1h: 100 }),
      position: makePosition({ debankMsUsdPrice: 1.001 }),
    })
    const alerts = evaluate(state, signals)
    const depeg = alerts.find(a => a.type === AlertType.DEPEG)
    expect(depeg?.level).toBe(AlertLevel.WARNING)
  })
})

// ── HACK MINT ─────────────────────────────────────────────────────────────────

describe('evaluateAlerts — hack_mint', () => {
  const oneHourAgo = new Date(Date.now() - 3600 * 1000)

  it('RED when supply +16% over 1h window AND price dropping AND sells spike', () => {
    const state = stateWithAge(AlertType.HACK_MINT, 5 * 60 * 1000, ['supply', 'price', 'sells'])
    const store = makeHistoryStub({ supply: [[oneHourAgo, 1_000_000n * 10n ** 18n]] })
    const signals = makeSignals({
      supply: { totalSupply: 1_160_000n * 10n ** 18n, fetchedAt: new Date() },
      price: { coingecko: 0.974, twap: 0.976, fetchedAt: new Date() },
      pool: makePool({ msUsdRatio: 0.72, poolPriceUsd: 0.974, buys1h: 10, sells1h: 800 }),
    })
    const alerts = evaluate(state, signals, store)
    const alert = alerts.find(a => a.type === AlertType.HACK_MINT)
    expect(alert?.level).toBe(AlertLevel.RED)
  })

  it('no alert when supply change is normal over 1h window', () => {
    const state = new Map()
    const store = makeHistoryStub({ supply: [[oneHourAgo, 1_000_000n * 10n ** 18n]] })
    const signals = makeSignals({
      supply: { totalSupply: 1_005_000n * 10n ** 18n, fetchedAt: new Date() },
    })
    evaluate(state, signals, store)
    expect(state.has(AlertType.HACK_MINT)).toBe(false)
  })

  it('no supply confirmation when no baseline in window (first startup)', () => {
    const state = new Map()
    const store = makeHistoryStub({}) // 无历史
    const signals = makeSignals({
      supply: { totalSupply: 1_200_000n * 10n ** 18n, fetchedAt: new Date() },
    })
    evaluate(state, signals, store)
    expect(state.has(AlertType.HACK_MINT)).toBe(false) // 无价格/sells 确认
  })

  it('detects gradual mint that would be missed by adjacent-poll comparison', () => {
    // 核心动机：攻击者分 20 次、每次 +1%，单次 < 15%，相邻比对漏报；1 小时窗口累计 +21% 触发
    const state = stateWithAge(AlertType.HACK_MINT, 5 * 60 * 1000, ['supply', 'price', 'sells'])
    const baseline = 1_000_000n * 10n ** 18n
    const current = 1_210_000n * 10n ** 18n // +21%
    const store = makeHistoryStub({ supply: [[oneHourAgo, baseline]] })
    const signals = makeSignals({
      supply: { totalSupply: current, fetchedAt: new Date() },
      price: { coingecko: 0.974, twap: 0.976, fetchedAt: new Date() },
      pool: makePool({ msUsdRatio: 0.72, poolPriceUsd: 0.974, buys1h: 10, sells1h: 800 }),
    })
    const alerts = evaluate(state, signals, store)
    const alert = alerts.find(a => a.type === AlertType.HACK_MINT)
    expect(alert?.level).toBe(AlertLevel.RED)
  })

  it('adds sells confirmation when buys1h=0 (zero-buy extreme signal), but stays WARNING without other confirmations', () => {
    const state = new Map()
    const store = makeHistoryStub({ supply: [[oneHourAgo, 1_000_000n * 10n ** 18n]] })
    const signals = makeSignals({
      pool: makePool({ msUsdRatio: 0.5, poolPriceUsd: 1.0, buys1h: 0, sells1h: 5, volume24h: 1_000 }),
    })
    const alerts = evaluate(state, signals, store)
    const alert = alerts.find(a => a.type === AlertType.HACK_MINT)
    // 仅 sells 一个确认（共需 2 个）→ WARNING，不升 RED
    expect(alert?.level).toBe(AlertLevel.WARNING)
  })

  it('stale single-source confirmation does not persist to RED (accumulated state bug)', () => {
    const state = stateWithAge(AlertType.HACK_MINT, 2 * 60 * 1000, ['price'])
    const store = makeHistoryStub({ supply: [[oneHourAgo, 1_000_000n * 10n ** 18n]] })
    const signals = makeSignals({
      supply: { totalSupply: 1_000_000n * 10n ** 18n, fetchedAt: new Date() }, // 无变化
      pool: makePool({ msUsdRatio: 0.5, poolPriceUsd: 1.0, buys1h: 10, sells1h: 80, volume24h: 50_000 }),
      price: { coingecko: 0.999, twap: 0.999, fetchedAt: new Date() }, // dropPct=0.1 < 2
    })
    const alerts = evaluate(state, signals, store)
    const alert = alerts.find(a => a.type === AlertType.HACK_MINT)
    expect(alert?.level).toBe(AlertLevel.WARNING) // 仅 'sells' 当前活跃 → 1/2 → WARNING
    expect(alert?.confirmations).toBe(1)
  })
})

// ── LIQUIDITY DRAIN ───────────────────────────────────────────────────────────

describe('evaluateAlerts — liquidity_drain', () => {
  const oneHourAgo = new Date(Date.now() - 3600 * 1000)

  it('RED when TVL drops >30% over 1h window AND pool imbalanced AND sells dominant', () => {
    const state = stateWithAge(AlertType.LIQUIDITY_DRAIN, 5 * 60 * 1000, ['tvl', 'pool', 'sells'])
    const store = makeHistoryStub({ tvl: [[oneHourAgo, 55_000_000]] })
    const signals = makeSignals({
      protocol: { tvlUsd: 37_000_000, fetchedAt: new Date() }, // -32.7%
      pool: makePool({ reserveInUsd: 1_500_000, msUsdRatio: 0.74, poolPriceUsd: 0.991, buys1h: 10, sells1h: 60, volume24h: 50_000 }),
    })
    const alerts = evaluate(state, signals, store)
    const alert = alerts.find(a => a.type === AlertType.LIQUIDITY_DRAIN)
    expect(alert?.level).toBe(AlertLevel.RED)
  })

  it('no tvl confirmation when no baseline in window', () => {
    const state = new Map()
    const store = makeHistoryStub({}) // 无 TVL 历史
    const signals = makeSignals({
      protocol: { tvlUsd: 10_000_000, fetchedAt: new Date() },
    })
    evaluate(state, signals, store)
    const entry = state.get(AlertType.LIQUIDITY_DRAIN)
    expect(entry?.confirmations.has('tvl')).toBeFalsy()
  })

  it('detects gradual drain across 1h window', () => {
    const state = stateWithAge(AlertType.LIQUIDITY_DRAIN, 5 * 60 * 1000, ['tvl', 'pool', 'sells'])
    const store = makeHistoryStub({ tvl: [[oneHourAgo, 55_000_000]] })
    const signals = makeSignals({
      protocol: { tvlUsd: 35_000_000, fetchedAt: new Date() }, // -36.4%
      pool: makePool({ reserveInUsd: 1_500_000, msUsdRatio: 0.74, poolPriceUsd: 0.991, buys1h: 10, sells1h: 60, volume24h: 50_000 }),
    })
    const alerts = evaluate(state, signals, store)
    expect(alerts.find(a => a.type === AlertType.LIQUIDITY_DRAIN)?.level).toBe(AlertLevel.RED)
  })
})

// ── INSIDER EXIT ──────────────────────────────────────────────────────────────

describe('evaluateAlerts — insider_exit', () => {
  it('RED when team wallet large outflow AND price dropping', () => {
    const state = stateWithAge(AlertType.INSIDER_EXIT, 5 * 60 * 1000, ['wallet', 'price'])
    const signals = makeSignals({
      wallets: [{
        walletAddress: '0xteam',
        msUsdAmount: 100_000,
        msUsdUsdValue: 99_000,
        previousMsUsdAmount: 200_000,
        fetchedAt: new Date(),
      }],
      price: { coingecko: 0.988, twap: 0.989, fetchedAt: new Date() },
    })
    const alerts = evaluate(state, signals)
    const alert = alerts.find(a => a.type === AlertType.INSIDER_EXIT)
    expect(alert?.level).toBe(AlertLevel.RED)
  })

  it('no alert when team wallets array is empty', () => {
    const state = new Map()
    evaluate(state, makeSignals({ wallets: [] }))
    expect(state.has(AlertType.INSIDER_EXIT)).toBe(false)
  })
})

// ── POSITION DROP ─────────────────────────────────────────────────────────────

describe('evaluateAlerts — position_drop', () => {
  const oneHourAgo = new Date(Date.now() - 3600 * 1000)

  it('RED when position drops >10% over 1h window AND sustained ≥ 300s', () => {
    const state = stateWithAge(AlertType.POSITION_DROP, 6 * 60 * 1000, ['position'])
    const store = makeHistoryStub({ position: [[oneHourAgo, 18_000]] })
    const signals = makeSignals({
      position: makePosition({ netUsdValue: 15_000 }), // -16.7%
    })
    const alerts = evaluate(state, signals, store)
    const alert = alerts.find(a => a.type === AlertType.POSITION_DROP)
    expect(alert?.level).toBe(AlertLevel.RED)
  })

  it('WARNING when position drops >10% over 1h window but sustained < 300s', () => {
    const state = stateWithAge(AlertType.POSITION_DROP, 60 * 1000, ['position'])
    const store = makeHistoryStub({ position: [[oneHourAgo, 18_000]] })
    const signals = makeSignals({
      position: makePosition({ netUsdValue: 15_000 }),
    })
    const alerts = evaluate(state, signals, store)
    const alert = alerts.find(a => a.type === AlertType.POSITION_DROP)
    expect(alert?.level).toBe(AlertLevel.WARNING)
  })

  it('no position confirmation when no baseline in window (first startup)', () => {
    const state = new Map()
    const store = makeHistoryStub({})
    const signals = makeSignals({
      position: makePosition({ netUsdValue: 10_000 }),
    })
    evaluate(state, signals, store)
    expect(state.has(AlertType.POSITION_DROP)).toBe(false)
  })

  it('no alert when position is null (data unavailable)', () => {
    const state = new Map()
    evaluate(state, makeSignals({ position: null }))
    expect(state.has(AlertType.POSITION_DROP)).toBe(false)
  })

  it('data includes windowSeconds and baselineValue for audit', () => {
    const state = stateWithAge(AlertType.POSITION_DROP, 6 * 60 * 1000, ['position'])
    const store = makeHistoryStub({ position: [[oneHourAgo, 18_000]] })
    const signals = makeSignals({
      position: makePosition({ netUsdValue: 15_000 }),
    })
    const alerts = evaluate(state, signals, store)
    const alert = alerts.find(a => a.type === AlertType.POSITION_DROP)
    expect(alert?.data['windowSeconds']).toBe(3600)
    expect(alert?.data['baselineValue_usd']).toBe(18_000)
  })
})

// ── POSITION OUT OF RANGE ─────────────────────────────────────────────────────

describe('evaluateAlerts — position_out_of_range', () => {
  const msUSD = (amount: number, price = 0.998) => ({
    id: '0x526728dbc96689597f85ae4cd716d4f7fccbae9d',
    symbol: 'msUSD',
    amount,
    priceUsd: price,
    usdValue: amount * price,
  })
  const usdc = (amount: number) => ({
    id: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    symbol: 'USDC',
    amount,
    priceUsd: 1.0,
    usdValue: amount,
  })

  it('no alert when tokens are balanced (50/50)', () => {
    const state = new Map()
    const signals = makeSignals({ position: makePosition({ supplyTokens: [msUSD(10_000), usdc(10_000)] }) })
    const alerts = evaluate(state, signals)
    expect(alerts.find(a => a.type === AlertType.POSITION_OUT_OF_RANGE)).toBeUndefined()
    expect(state.has(AlertType.POSITION_OUT_OF_RANGE)).toBe(false)
  })

  it('no alert when minority share is above threshold (32/68)', () => {
    const state = new Map()
    const signals = makeSignals({ position: makePosition({ supplyTokens: [msUSD(5924, 0.998), usdc(12603)] }) })
    const alerts = evaluate(state, signals)
    expect(alerts.find(a => a.type === AlertType.POSITION_OUT_OF_RANGE)).toBeUndefined()
  })

  it('starts timer but returns no alert on first detection (below sustainedSeconds)', () => {
    const state = new Map()
    const signals = makeSignals({ position: makePosition({ supplyTokens: [msUSD(300, 0.998), usdc(10_000)] }) })
    const alerts = evaluate(state, signals)
    expect(alerts.find(a => a.type === AlertType.POSITION_OUT_OF_RANGE)).toBeUndefined()
    expect(state.has(AlertType.POSITION_OUT_OF_RANGE)).toBe(true)
  })

  it('returns WARNING after sustained > 300s', () => {
    const state = new Map()
    state.set(AlertType.POSITION_OUT_OF_RANGE, {
      firstTriggered: new Date(Date.now() - 310_000),
      confirmations: new Set(['range']),
      lastData: { minShare: 3, shares: [], lastNotifiedAt: 0 },
    })
    const signals = makeSignals({ position: makePosition({ supplyTokens: [msUSD(300, 0.998), usdc(10_000)] }) })
    const alerts = evaluate(state, signals)
    const alert = alerts.find(a => a.type === AlertType.POSITION_OUT_OF_RANGE)
    expect(alert?.level).toBe(AlertLevel.WARNING)
    expect(alert?.title).toContain('Manual Rebalance Required')
  })

  it('suppresses repeated alerts within cooldown window (24h)', () => {
    const lastNotifiedAt = Date.now() - 1000  // notified 1 second ago
    const state = new Map()
    state.set(AlertType.POSITION_OUT_OF_RANGE, {
      firstTriggered: new Date(Date.now() - 310_000),
      confirmations: new Set(['range']),
      lastData: { minShare: 3, shares: [], lastNotifiedAt },
    })
    const signals = makeSignals({ position: makePosition({ supplyTokens: [msUSD(300, 0.998), usdc(10_000)] }) })
    const alerts = evaluate(state, signals)
    expect(alerts.find(a => a.type === AlertType.POSITION_OUT_OF_RANGE)).toBeUndefined()
  })

  it('clears state when position returns in-range', () => {
    const state = new Map()
    state.set(AlertType.POSITION_OUT_OF_RANGE, {
      firstTriggered: new Date(Date.now() - 310_000),
      confirmations: new Set(['range']),
      lastData: { minShare: 3, shares: [], lastNotifiedAt: 0 },
    })
    const signals = makeSignals({ position: makePosition({ supplyTokens: [msUSD(10_000), usdc(10_000)] }) })
    evaluate(state, signals)
    expect(state.has(AlertType.POSITION_OUT_OF_RANGE)).toBe(false)
  })

  it('no alert when position is null', () => {
    const state = new Map()
    evaluate(state, makeSignals({ position: null }))
    expect(state.has(AlertType.POSITION_OUT_OF_RANGE)).toBe(false)
  })

  it('no alert when supplyTokens has fewer than 2 tokens', () => {
    const state = new Map()
    const signals = makeSignals({ position: makePosition({ supplyTokens: [usdc(10_000)] }) })
    evaluate(state, signals)
    expect(state.has(AlertType.POSITION_OUT_OF_RANGE)).toBe(false)
  })
})
