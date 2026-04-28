// src/protocols/aerodrome/index.ts
import { AlertLevel } from '../../core/types.js'
import type { Monitor, PollResult, DataSourceStatus } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'
import type { CoinGeckoClient } from '../../core/clients/coingecko.js'
import type { DeBankClient } from '../../core/clients/debank.js'
import type { RpcClient } from '../../core/clients/rpc.js'
import type pino from 'pino'
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

// 必须与 AllSignals 的键保持一致
const SOURCE_NAMES = ['price', 'pool', 'supply', 'position', 'protocol', 'wallets'] as const
type SourceName = typeof SOURCE_NAMES[number]

function initialHealth(): DataSourceStatus {
  return { available: false, lastSuccessAt: null, consecutiveFailures: 0, latencyMs: null, fallbackActive: null }
}

// 对单次异步调用计时，返回 [settled 结果, 耗时毫秒]
async function timed<T>(fn: () => Promise<T>): Promise<[PromiseSettledResult<T>, number]> {
  const t0 = Date.now()
  const result = await fn().then(
    (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
    (reason): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
  )
  return [result, Date.now() - t0]
}

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
  private readonly sourceHealth: Record<SourceName, DataSourceStatus> = {
    price: initialHealth(), pool: initialHealth(), supply: initialHealth(),
    position: initialHealth(), protocol: initialHealth(), wallets: initialHealth(),
  }

  constructor(
    private readonly cfg: AerodromeConfig,
    coinGecko: CoinGeckoClient,
    deBank: DeBankClient,
    rpc: RpcClient,
    walletAddress: string,
    private readonly logger: pino.Logger,
  ) {
    this.pollIntervalMs = Math.min(
      cfg.polling.priceMs, cfg.polling.poolMs, cfg.polling.supplyMs,
      cfg.polling.positionMs, cfg.polling.protocolMs, cfg.polling.teamWalletsMs,
    )
    this.priceMonitor = new PriceMonitor(
      { msUsdAddress: cfg.msUsdAddress as `0x${string}`, poolAddress: cfg.poolAddress as `0x${string}` },
      coinGecko, rpc, logger,
    )
    this.poolMonitor = new PoolMonitor(
      {
        poolAddress: cfg.poolAddress as `0x${string}`,
        msUsdAddress: cfg.msUsdAddress as `0x${string}`,
        usdcAddress: cfg.usdcAddress as `0x${string}`,
      },
      coinGecko, rpc, logger,
    )
    this.supplyMonitor = new SupplyMonitor({ msUsdAddress: cfg.msUsdAddress as `0x${string}` }, rpc)
    this.positionMonitor = new PositionMonitor({ walletAddress, protocolId: 'aerodrome' }, deBank)
    this.protocolMonitor = new ProtocolMonitor({ protocolId: 'metronome-synth' }, deBank)
    this.walletMonitor = new WalletMonitor(
      { teamWallets: cfg.teamWallets, msUsdAddress: cfg.msUsdAddress, msUsdSymbol: 'msUSD', chain: cfg.chain },
      deBank,
    )
  }

  async init(): Promise<void> {}

  async poll(): Promise<PollResult> {
    const [
      [priceR, priceMs], [poolR, poolMs], [supplyR, supplyMs],
      [positionR, positionMs], [protocolR, protocolMs], [walletsR, walletsMs],
    ] = await Promise.all([
      timed(() => this.priceMonitor.check()),
      timed(() => this.poolMonitor.check()),
      timed(() => this.supplyMonitor.check()),
      timed(() => this.positionMonitor.check()),
      timed(() => this.protocolMonitor.check()),
      timed(() => this.walletMonitor.check()),
    ])

    this.updateSourceHealth('price',    priceR,    priceMs)
    this.updateSourceHealth('pool',     poolR,     poolMs)
    this.updateSourceHealth('supply',   supplyR,   supplyMs)
    this.updateSourceHealth('position', positionR, positionMs)
    this.updateSourceHealth('protocol', protocolR, protocolMs)
    this.updateSourceHealth('wallets',  walletsR,  walletsMs)

    const signals: AllSignals = {
      price:    priceR.status    === 'fulfilled' ? priceR.value    : null,
      pool:     poolR.status     === 'fulfilled' ? poolR.value     : null,
      supply:   supplyR.status   === 'fulfilled' ? supplyR.value   : null,
      position: positionR.status === 'fulfilled' ? positionR.value : null,
      protocol: protocolR.status === 'fulfilled' ? protocolR.value : null,
      wallets:  walletsR.status  === 'fulfilled' ? walletsR.value  : null,
    }

    const alerts = evaluateAlerts(this.alertState, signals, this.cfg, this.id)

    this.logger.debug({
      latencyMs: { price: priceMs, pool: poolMs, supply: supplyMs, position: positionMs, protocol: protocolMs, wallets: walletsMs },
      supply: signals.supply ? { totalSupply: signals.supply.totalSupply.toString(), previousSupply: signals.supply.previousSupply?.toString() ?? null } : null,
      protocol: signals.protocol ? { tvlUsd: signals.protocol.tvlUsd, previousTvlUsd: signals.protocol.previousTvlUsd } : null,
      pool: signals.pool ? { buys1h: signals.pool.buys1h, sells1h: signals.pool.sells1h, volume24h: signals.pool.volume24h, reserveInUsd: signals.pool.reserveInUsd } : null,
      wallets: signals.wallets?.map(w => ({ address: w.walletAddress, msUsdAmount: w.msUsdAmount, previousMsUsdAmount: w.previousMsUsdAmount })) ?? null,
    }, 'Poll detail')

    this.logger.info({
      price:       signals.price?.coingecko      ?? null,
      poolPrice:   signals.pool?.poolPriceUsd    ?? null,
      twap:        signals.price?.twap           ?? null,
      msUsdRatio:  signals.pool?.msUsdRatio      ?? null,
      positionUsd: signals.position?.netUsdValue ?? null,
      alerts:      alerts.length,
      sources: Object.fromEntries(SOURCE_NAMES.map(k => [k, this.sourceHealth[k].available])),
    }, 'Poll complete')

    // 估算 msUSD 余额用于生成订单（以仓位价值作为代理）
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
        healthy: SOURCE_NAMES.every(k => this.sourceHealth[k].available),
        sources: { ...this.sourceHealth },
        checkedAt: new Date(),
      },
    }
  }

  async shutdown(): Promise<void> {}

  private updateSourceHealth(name: SourceName, result: PromiseSettledResult<unknown>, latencyMs: number): void {
    const h = this.sourceHealth[name]
    if (result.status === 'fulfilled') {
      h.available = true
      h.lastSuccessAt = new Date()
      h.consecutiveFailures = 0
      h.latencyMs = latencyMs
      h.fallbackActive = null
    } else {
      h.available = false
      h.consecutiveFailures++
    }
  }
}
