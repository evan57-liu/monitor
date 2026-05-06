// src/protocols/aerodrome/price-floor.test.ts
import { describe, it, expect } from 'vitest'
import { checkPriceFloor } from './price-floor.js'
import type { AllSignals } from './types.js'

const NOW = new Date()

function makeSignals(coingecko: number | null, twap: number | null, debank: number | null): AllSignals {
  return {
    price: (coingecko !== null || twap !== null) ? { coingecko, twap, fetchedAt: NOW } : null,
    pool: null,
    supply: null,
    position: debank !== null
      ? { debankMsUsdPrice: debank, netUsdValue: 100, rewardUsdValue: 0, fetchedAt: NOW }
      : null,
    protocol: null,
    wallets: null,
  }
}

describe('checkPriceFloor', () => {
  const floor = 0.92

  it('three healthy sources above floor → ok=true, effectivePrice=max', () => {
    const result = checkPriceFloor(makeSignals(0.97, 0.95, 0.93), floor, true)
    expect(result.ok).toBe(true)
    expect(result.effectivePrice).toBeCloseTo(0.97)
    expect(result.reason).toBe('ok')
  })

  it('takes max of available sources', () => {
    const result = checkPriceFloor(makeSignals(0.85, 0.95, 0.93), floor, true)
    expect(result.ok).toBe(true)
    expect(result.effectivePrice).toBeCloseTo(0.95)
  })

  it('all sources below floor → ok=false', () => {
    const result = checkPriceFloor(makeSignals(0.85, 0.88, 0.87), floor, true)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('below_floor')
    expect(result.effectivePrice).toBeCloseTo(0.88)
  })

  it('three sources all null + failClosed=true → ok=false, effectivePrice=null', () => {
    const result = checkPriceFloor(makeSignals(null, null, null), floor, true)
    expect(result.ok).toBe(false)
    expect(result.effectivePrice).toBeNull()
    expect(result.reason).toBe('all_sources_unavailable')
  })

  it('three sources all null + failClosed=false → ok=true', () => {
    const result = checkPriceFloor(makeSignals(null, null, null), floor, false)
    expect(result.ok).toBe(true)
    expect(result.effectivePrice).toBeNull()
    expect(result.reason).toBe('all_sources_unavailable')
  })

  it('one source available above floor → ok=true', () => {
    const result = checkPriceFloor(makeSignals(null, 0.95, null), floor, true)
    expect(result.ok).toBe(true)
    expect(result.effectivePrice).toBeCloseTo(0.95)
  })

  it('one source available below floor → ok=false', () => {
    const result = checkPriceFloor(makeSignals(null, 0.88, null), floor, true)
    expect(result.ok).toBe(false)
    expect(result.effectivePrice).toBeCloseTo(0.88)
  })

  it('sources struct reflects individual values', () => {
    const result = checkPriceFloor(makeSignals(0.97, 0.95, null), floor, true)
    expect(result.sources.coingecko).toBeCloseTo(0.97)
    expect(result.sources.twap).toBeCloseTo(0.95)
    expect(result.sources.debank).toBeNull()
  })
})
