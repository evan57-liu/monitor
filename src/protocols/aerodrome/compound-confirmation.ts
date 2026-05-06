// src/protocols/aerodrome/compound-confirmation.ts
import { AlertType } from '../../core/types.js'
import type { Alert } from '../../core/types.js'
import type pino from 'pino'

// depeg 单独触发误报率高（市场波动即可满足），需要攻击类信号佐证才能生成订单。
const CORROBORATORS: ReadonlySet<AlertType> = new Set([
  AlertType.HACK_MINT, AlertType.LIQUIDITY_DRAIN, AlertType.INSIDER_EXIT,
])

export function applyCompoundConfirmation(redAlerts: Alert[], logger: pino.Logger): Alert[] {
  const types = new Set(redAlerts.map(a => a.type))
  const hasCorroborator = [...types].some(t => CORROBORATORS.has(t))
  return redAlerts.filter(a => {
    if (a.type === AlertType.DEPEG && !hasCorroborator) {
      logger.warn({ alertId: a.id }, 'Depeg RED alone — order generation suppressed (compound confirmation required)')
      return false
    }
    return true
  })
}
