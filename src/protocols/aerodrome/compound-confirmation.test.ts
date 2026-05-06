// src/protocols/aerodrome/compound-confirmation.test.ts
import { describe, it, expect } from 'vitest'
import { applyCompoundConfirmation } from './compound-confirmation.js'
import { AlertLevel, AlertType } from '../../core/types.js'
import type { Alert } from '../../core/types.js'
import pino from 'pino'

const logger = pino({ level: 'silent' })

function makeRed(type: AlertType): Alert {
  return {
    id: crypto.randomUUID(),
    type,
    level: AlertLevel.RED,
    protocol: 'test',
    title: 'test',
    message: '',
    data: {},
    triggeredAt: new Date(),
    confirmations: 2,
    requiredConfirmations: 2,
    sustainedMs: 200_000,
    requiredSustainedMs: 180_000,
  }
}

describe('applyCompoundConfirmation', () => {
  it('depeg RED alone → filtered out (no orders)', () => {
    const result = applyCompoundConfirmation([makeRed(AlertType.DEPEG)], logger)
    expect(result).toHaveLength(0)
  })

  it('depeg RED + hack_mint RED → both pass', () => {
    const result = applyCompoundConfirmation([makeRed(AlertType.DEPEG), makeRed(AlertType.HACK_MINT)], logger)
    expect(result).toHaveLength(2)
    expect(result.map(a => a.type)).toContain(AlertType.DEPEG)
    expect(result.map(a => a.type)).toContain(AlertType.HACK_MINT)
  })

  it('depeg RED + liquidity_drain RED → both pass', () => {
    const result = applyCompoundConfirmation([makeRed(AlertType.DEPEG), makeRed(AlertType.LIQUIDITY_DRAIN)], logger)
    expect(result).toHaveLength(2)
  })

  it('depeg RED + insider_exit RED → both pass', () => {
    const result = applyCompoundConfirmation([makeRed(AlertType.DEPEG), makeRed(AlertType.INSIDER_EXIT)], logger)
    expect(result).toHaveLength(2)
  })

  it('position_drop RED alone → passes (independent last-resort trigger)', () => {
    const result = applyCompoundConfirmation([makeRed(AlertType.POSITION_DROP)], logger)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe(AlertType.POSITION_DROP)
  })

  it('hack_mint RED alone (no depeg) → passes', () => {
    const result = applyCompoundConfirmation([makeRed(AlertType.HACK_MINT)], logger)
    expect(result).toHaveLength(1)
  })

  it('empty input → empty output', () => {
    expect(applyCompoundConfirmation([], logger)).toHaveLength(0)
  })
})
