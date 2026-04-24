// src/protocols/aerodrome/alerts.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { evaluateAlerts } from './alerts.js'
import { AlertLevel, AlertType } from '../../core/types.js'
import type { AllSignals } from './types.js'
import type { AerodromeConfig } from '../../core/config.js'

// Minimal config for tests
const cfg = {
  alerts: {
    depeg: { priceThreshold: 0.992, twapThreshold: 0.992, poolImbalancePct: 75, sustainedSeconds: 180, requiredConfirmations: 3 },
    hackMint: { supplyIncreasePct: 15, supplyWindowSeconds: 3600, priceDropPct: 2, sellsSpikeMultiplier: 5 },
    liquidityDrain: { tvlDropPct: 30, tvlWindowSeconds: 3600, poolMsUsdRatioPct: 70, sellsBuysRatio: 3 },
    insiderExit: { largeOutflowUsd: 50000, priceDropPct: 1 },
    positionDrop: { dropPct: 10, windowSeconds: 3600 },
  },
} as AerodromeConfig

const PROTOCOL_ID = 'aerodrome-msusd-usdc'

function makeSignals(overrides: Partial<AllSignals> = {}): AllSignals {
  return {
    price: { coingecko: 1.0001, twap: 1.0001, fetchedAt: new Date() },
    pool: { reserveInUsd: 2_500_000, msUsdRatio: 0.5, buys1h: 50, sells1h: 50, volume24h: 180_000, fetchedAt: new Date() },
    supply: { totalSupply: 1_000_000n * 10n ** 18n, previousSupply: 1_000_000n * 10n ** 18n, fetchedAt: new Date() },
    position: { netUsdValue: 18_000, previousNetUsdValue: 18_000, fetchedAt: new Date() },
    protocol: { tvlUsd: 55_000_000, previousTvlUsd: 55_000_000, fetchedAt: new Date() },
    wallets: [],
    ...overrides,
  }
}

// Helper to simulate "condition has been present for N milliseconds"
function stateWithAge(alertType: AlertType, ageMs: number, confirmationSources: string[]): Map<AlertType, { firstTriggered: Date; confirmations: Set<string>; lastData: Record<string, unknown> }> {
  const m = new Map()
  m.set(alertType, {
    firstTriggered: new Date(Date.now() - ageMs),
    confirmations: new Set(confirmationSources),
    lastData: {},
  })
  return m
}

// ── DEPEG ─────────────────────────────────────────────────────────────────────

describe('evaluateAlerts — depeg', () => {
  it('no alert when price is healthy', () => {
    const state = new Map()
    const alerts = evaluateAlerts(state, makeSignals(), cfg, PROTOCOL_ID)
    expect(alerts.find(a => a.type === AlertType.DEPEG)).toBeUndefined()
  })

  it('WARNING when condition just started (< sustainedSeconds)', () => {
    const state = stateWithAge(AlertType.DEPEG, 30_000, ['coingecko', 'twap', 'pool']) // 30s ago
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: 0.987, fetchedAt: new Date() },
      pool: { reserveInUsd: 2_500_000, msUsdRatio: 0.78, buys1h: 20, sells1h: 100, volume24h: 180_000, fetchedAt: new Date() },
    })
    const alerts = evaluateAlerts(state, signals, cfg, PROTOCOL_ID)
    const depeg = alerts.find(a => a.type === AlertType.DEPEG)
    expect(depeg?.level).toBe(AlertLevel.WARNING)
  })

  it('RED when condition sustained > 3 min and 3 sources confirm', () => {
    const state = stateWithAge(AlertType.DEPEG, 4 * 60 * 1000, ['coingecko', 'twap', 'pool']) // 4 min ago
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: 0.987, fetchedAt: new Date() },
      pool: { reserveInUsd: 2_500_000, msUsdRatio: 0.78, buys1h: 20, sells1h: 100, volume24h: 180_000, fetchedAt: new Date() },
    })
    const alerts = evaluateAlerts(state, signals, cfg, PROTOCOL_ID)
    const depeg = alerts.find(a => a.type === AlertType.DEPEG)
    expect(depeg?.level).toBe(AlertLevel.RED)
    expect(depeg?.confirmations).toBe(3)
  })

  it('WARNING when sustained but only 2 of 3 sources confirm (twap null)', () => {
    const state = stateWithAge(AlertType.DEPEG, 4 * 60 * 1000, ['coingecko', 'pool'])
    const signals = makeSignals({
      price: { coingecko: 0.985, twap: null, fetchedAt: new Date() }, // twap unavailable
      pool: { reserveInUsd: 2_500_000, msUsdRatio: 0.78, buys1h: 20, sells1h: 100, volume24h: 180_000, fetchedAt: new Date() },
    })
    const alerts = evaluateAlerts(state, signals, cfg, PROTOCOL_ID)
    const depeg = alerts.find(a => a.type === AlertType.DEPEG)
    // sustained but < requiredConfirmations → stays WARNING
    expect(depeg?.level).toBe(AlertLevel.WARNING)
  })

  it('clears state when condition resolves', () => {
    const state = stateWithAge(AlertType.DEPEG, 4 * 60 * 1000, ['coingecko', 'twap', 'pool'])
    const healthySignals = makeSignals() // price back to 1.0001
    evaluateAlerts(state, healthySignals, cfg, PROTOCOL_ID)
    expect(state.has(AlertType.DEPEG)).toBe(false)
  })
})

// ── HACK MINT ─────────────────────────────────────────────────────────────────

describe('evaluateAlerts — hack_mint', () => {
  it('RED when supply +16% in window AND price dropping AND sells spike', () => {
    const state = stateWithAge(AlertType.HACK_MINT, 5 * 60 * 1000, ['supply', 'price', 'sells'])
    const signals = makeSignals({
      supply: {
        totalSupply: 1_160_000n * 10n ** 18n,        // +16% vs previous
        previousSupply: 1_000_000n * 10n ** 18n,
        fetchedAt: new Date(),
      },
      price: { coingecko: 0.974, twap: 0.976, fetchedAt: new Date() }, // -2.6%
      pool: { reserveInUsd: 2_500_000, msUsdRatio: 0.72, buys1h: 10, sells1h: 800, volume24h: 180_000, fetchedAt: new Date() }, // sells spike
    })
    const alerts = evaluateAlerts(state, signals, cfg, PROTOCOL_ID)
    const alert = alerts.find(a => a.type === AlertType.HACK_MINT)
    expect(alert?.level).toBe(AlertLevel.RED)
  })

  it('no alert when supply change is normal', () => {
    const state = new Map()
    const signals = makeSignals({
      supply: { totalSupply: 1_005_000n * 10n ** 18n, previousSupply: 1_000_000n * 10n ** 18n, fetchedAt: new Date() },
    })
    evaluateAlerts(state, signals, cfg, PROTOCOL_ID)
    expect(state.has(AlertType.HACK_MINT)).toBe(false)
  })
})

// ── LIQUIDITY DRAIN ───────────────────────────────────────────────────────────

describe('evaluateAlerts — liquidity_drain', () => {
  it('RED when TVL drops >30% AND pool imbalanced AND sells dominant', () => {
    const state = stateWithAge(AlertType.LIQUIDITY_DRAIN, 5 * 60 * 1000, ['tvl', 'pool', 'sells'])
    const signals = makeSignals({
      protocol: { tvlUsd: 37_000_000, previousTvlUsd: 55_000_000, fetchedAt: new Date() }, // -32.7%
      pool: { reserveInUsd: 1_500_000, msUsdRatio: 0.74, buys1h: 10, sells1h: 60, volume24h: 50_000, fetchedAt: new Date() },
    })
    const alerts = evaluateAlerts(state, signals, cfg, PROTOCOL_ID)
    const alert = alerts.find(a => a.type === AlertType.LIQUIDITY_DRAIN)
    expect(alert?.level).toBe(AlertLevel.RED)
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
        previousMsUsdAmount: 200_000, // sold 100k msUSD (~$100k outflow)
        fetchedAt: new Date(),
      }],
      price: { coingecko: 0.988, twap: 0.989, fetchedAt: new Date() }, // -1.2%
    })
    const alerts = evaluateAlerts(state, signals, cfg, PROTOCOL_ID)
    const alert = alerts.find(a => a.type === AlertType.INSIDER_EXIT)
    expect(alert?.level).toBe(AlertLevel.RED)
  })

  it('no alert when team wallets array is empty', () => {
    const state = new Map()
    evaluateAlerts(state, makeSignals({ wallets: [] }), cfg, PROTOCOL_ID)
    expect(state.has(AlertType.INSIDER_EXIT)).toBe(false)
  })
})

// ── POSITION DROP ─────────────────────────────────────────────────────────────

describe('evaluateAlerts — position_drop', () => {
  it('RED when position value drops >10% in window', () => {
    const state = stateWithAge(AlertType.POSITION_DROP, 30 * 60 * 1000, ['position'])
    const signals = makeSignals({
      position: { netUsdValue: 15_000, previousNetUsdValue: 18_000, fetchedAt: new Date() }, // -16.7%
    })
    const alerts = evaluateAlerts(state, signals, cfg, PROTOCOL_ID)
    const alert = alerts.find(a => a.type === AlertType.POSITION_DROP)
    expect(alert?.level).toBe(AlertLevel.RED)
  })

  it('no alert when position is null (data unavailable)', () => {
    const state = new Map()
    evaluateAlerts(state, makeSignals({ position: null }), cfg, PROTOCOL_ID)
    expect(state.has(AlertType.POSITION_DROP)).toBe(false)
  })
})
