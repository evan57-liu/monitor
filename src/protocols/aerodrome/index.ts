// src/protocols/aerodrome/index.ts
import { AlertLevel, AlertType } from '../../core/types.js'
import type { Monitor, PollResult, DataSourceStatus } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'
import type { CoinGeckoClient } from '../../core/clients/coingecko.js'
import type { DeBankClient } from '../../core/clients/debank.js'
import type { RpcClient } from '../../core/clients/rpc.js'
import { PriceMonitor } from './monitors/price.js'
import { PoolMonitor } from './monitors/pool.js'
import { SupplyMonitor } from './monitors/supply.js'
import { PositionMonitor } from './monitors/position.js'
import { ProtocolMonitor } from './monitors/protocol.js'
import { WalletMonitor } from './monitors/wallets.js'
import { evaluateAlerts } from './alerts.js'
import { generateWithdrawalOrders } from './orders.js'
import type { AlertState } from './alerts.js'
import type { AllSignals } from './types.js'

export class AerodromeMonitor implements Monitor {
  readonly id = 'aerodrome-msusd-usdc'
  readonly name = 'Aerodrome msUSD/USDC'
  readonly pollIntervalMs: number

  private readonly priceMonitor: PriceMonitor
  private readonly poolMonitor: PoolMonitor
  private readonly supplyMonitor: SupplyMonitor
  private readonly positionMonitor: PositionMonitor
  private readonly protocolMonitor: ProtocolMonitor
  private readonly walletMonitor: WalletMonitor
  private readonly alertState: AlertState = new Map()
  private readonly sourceHealth: Record<string, DataSourceStatus> = {}

  constructor(
    private readonly cfg: AerodromeConfig,
    coinGecko: CoinGeckoClient,
    deBank: DeBankClient,
    rpc: RpcClient,
    walletAddress: string,
  ) {
    this.pollIntervalMs = Math.min(
      cfg.polling.priceMs, cfg.polling.poolMs, cfg.polling.supplyMs,
      cfg.polling.positionMs, cfg.polling.protocolMs, cfg.polling.teamWalletsMs,
    )
    this.priceMonitor = new PriceMonitor(
      { msUsdAddress: cfg.msUsdAddress as `0x${string}`, poolAddress: cfg.poolAddress as `0x${string}` },
      coinGecko, rpc,
    )
    this.poolMonitor = new PoolMonitor({ poolAddress: cfg.poolAddress }, coinGecko)
    this.supplyMonitor = new SupplyMonitor({ msUsdAddress: cfg.msUsdAddress as `0x${string}` }, rpc)
    this.positionMonitor = new PositionMonitor({ walletAddress, protocolId: 'aerodrome' }, deBank)
    this.protocolMonitor = new ProtocolMonitor({ protocolId: 'metronome-synth' }, deBank)
    this.walletMonitor = new WalletMonitor(
      { teamWallets: cfg.teamWallets, msUsdAddress: cfg.msUsdAddress, msUsdSymbol: 'msUSD', chain: cfg.chain },
      deBank,
    )
    this.initSourceHealth()
  }

  async init(): Promise<void> {
    // Warm up: do one fetch to verify all sources respond
    // Errors here are non-fatal — the monitor will degrade gracefully during poll()
  }

  async poll(): Promise<PollResult> {
    const startMs = Date.now()

    const [priceR, poolR, supplyR, positionR, protocolR, walletsR] = await Promise.allSettled([
      this.priceMonitor.check(),
      this.poolMonitor.check(),
      this.supplyMonitor.check(),
      this.positionMonitor.check(),
      this.protocolMonitor.check(),
      this.walletMonitor.check(),
    ])

    this.updateSourceHealth('price', priceR, startMs)
    this.updateSourceHealth('pool', poolR, startMs)
    this.updateSourceHealth('supply', supplyR, startMs)
    this.updateSourceHealth('position', positionR, startMs)
    this.updateSourceHealth('protocol', protocolR, startMs)
    this.updateSourceHealth('wallets', walletsR, startMs)

    const signals: AllSignals = {
      price: priceR.status === 'fulfilled' ? priceR.value : null,
      pool: poolR.status === 'fulfilled' ? poolR.value : null,
      supply: supplyR.status === 'fulfilled' ? supplyR.value : null,
      position: positionR.status === 'fulfilled' ? positionR.value : null,
      protocol: protocolR.status === 'fulfilled' ? protocolR.value : null,
      wallets: walletsR.status === 'fulfilled' ? walletsR.value : null,
    }

    const alerts = evaluateAlerts(this.alertState, signals, this.cfg, this.id)

    // Estimate msUSD balance for order generation (use position value as proxy)
    const msUsdBalance = signals.position
      ? BigInt(Math.floor(signals.position.netUsdValue * 1e18))
      : 0n

    const orders = alerts
      .filter(a => a.level === AlertLevel.RED)
      .flatMap(a => generateWithdrawalOrders(a, this.cfg, msUsdBalance))

    return {
      alerts,
      orders,
      health: {
        healthy: Object.values(this.sourceHealth).every(s => s.available),
        sources: { ...this.sourceHealth },
        checkedAt: new Date(),
      },
    }
  }

  async shutdown(): Promise<void> { /* nothing to clean up */ }

  private initSourceHealth(): void {
    for (const name of ['price', 'pool', 'supply', 'position', 'protocol', 'wallets']) {
      this.sourceHealth[name] = {
        available: false,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        latencyMs: null,
        fallbackActive: null,
      }
    }
  }

  private updateSourceHealth(name: string, result: PromiseSettledResult<unknown>, startMs: number): void {
    const h = this.sourceHealth[name]
    if (!h) return
    if (result.status === 'fulfilled') {
      h.available = true
      h.lastSuccessAt = new Date()
      h.consecutiveFailures = 0
      h.latencyMs = Date.now() - startMs
      h.fallbackActive = null
    } else {
      h.available = false
      h.consecutiveFailures++
    }
  }
}
