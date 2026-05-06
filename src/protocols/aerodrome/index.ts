// src/protocols/aerodrome/index.ts
import { AlertLevel } from '../../core/types.js'
import type { Monitor, PollResult, DataSourceStatus } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'
import type { CoinGeckoClient } from '../../core/clients/coingecko.js'
import type { DeBankClient } from '../../core/clients/debank.js'
import type { RpcClient } from '../../core/clients/rpc.js'
import type pino from 'pino'
import { MarketMonitor } from './monitors/market.js'
import type { MarketSignal } from './monitors/market.js'
import { SupplyMonitor } from './monitors/supply.js'
import { PositionMonitor } from './monitors/position.js'
import { ProtocolMonitor } from './monitors/protocol.js'
import { WalletMonitor } from './monitors/wallets.js'
import { evaluateAlerts } from './alerts.js'
import { generateWithdrawalOrders } from './orders.js'
import type { AlertState } from './alerts.js'
import type { AllSignals } from './types.js'

// market = CoinGecko + TWAP + 链上余额（产出 price 和 pool 两个信号）
const SOURCE_NAMES = ['market', 'supply', 'position', 'protocol', 'wallets'] as const
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

  private readonly marketMonitor: MarketMonitor
  private readonly supplyMonitor: SupplyMonitor
  private readonly positionMonitor: PositionMonitor
  private readonly protocolMonitor: ProtocolMonitor
  private readonly walletMonitor: WalletMonitor
  private readonly alertState: AlertState = new Map()
  private readonly sourceHealth: Record<SourceName, DataSourceStatus> = {
    market: initialHealth(), supply: initialHealth(),
    position: initialHealth(), protocol: initialHealth(), wallets: initialHealth(),
  }
  // 各子监控器独立限速：记录上次实际执行时间
  private readonly lastRunAt = new Map<SourceName, number>()
  // 跨 tick 缓存：子监控器未运行时，使用上次信号参与告警评估
  private readonly cachedSignals: AllSignals = {
    price: null, pool: null, supply: null, position: null, protocol: null, wallets: null,
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
      cfg.polling.marketMs, cfg.polling.supplyMs,
      cfg.polling.positionMs, cfg.polling.protocolMs, cfg.polling.teamWalletsMs,
    )
    this.marketMonitor = new MarketMonitor(
      {
        poolAddress: cfg.poolAddress as `0x${string}`,
        msUsdAddress: cfg.msUsdAddress as `0x${string}`,
        usdcAddress: cfg.usdcAddress as `0x${string}`,
        token0Decimals: 18, // msUSD 为 token0（地址较小），18位小数
        token1Decimals: 6,  // USDC 为 token1（地址较大），6位小数
      },
      coinGecko, rpc, logger,
    )
    this.supplyMonitor = new SupplyMonitor({ msUsdAddress: cfg.msUsdAddress as `0x${string}` }, rpc, logger)
    this.positionMonitor = new PositionMonitor({ walletAddress, protocolId: cfg.debankProtocolId, poolId: cfg.gaugeAddress, msUsdAddress: cfg.msUsdAddress }, deBank, logger)
    this.protocolMonitor = new ProtocolMonitor({ protocolIds: cfg.metronomeProtocolIds }, deBank, logger)
    this.walletMonitor = new WalletMonitor(
      { teamWallets: cfg.teamWallets, msUsdAddress: cfg.msUsdAddress, msUsdSymbol: 'msUSD', chain: cfg.chain },
      deBank,
      logger,
    )
  }

  async init(): Promise<void> {}

  async poll(): Promise<PollResult> {
    const tick = Date.now()
    const p = this.cfg.polling

    const runIf = <T>(
      name: SourceName,
      intervalMs: number,
      fn: () => Promise<T>,
    ): Promise<[PromiseSettledResult<T> | null, number]> => {
      const last = this.lastRunAt.get(name)
      if (last !== undefined && tick - last < intervalMs) {
        return Promise.resolve([null, 0] as [null, number])
      }
      return timed(fn).then(([result, ms]) => {
        this.lastRunAt.set(name, tick)
        return [result, ms] as [PromiseSettledResult<T>, number]
      })
    }

    const [
      [marketR, marketMs], [supplyR, supplyMs],
      [positionR, positionMs], [protocolR, protocolMs], [walletsR, walletsMs],
    ] = await Promise.all([
      runIf('market',   p.marketMs,     () => this.marketMonitor.check()),
      runIf('supply',   p.supplyMs,     () => this.supplyMonitor.check()),
      runIf('position', p.positionMs,   () => this.positionMonitor.check()),
      runIf('protocol', p.protocolMs,   () => this.protocolMonitor.check()),
      runIf('wallets',  p.teamWalletsMs,() => this.walletMonitor.check()),
    ])

    // market monitor 产出 price 和 pool 两个信号，需单独展开
    if (marketR !== null) {
      this.updateSourceHealth('market', marketR, marketMs)
      if (marketR.status === 'fulfilled') {
        this.cachedSignals.price = marketR.value.price
        this.cachedSignals.pool  = marketR.value.pool
      } else {
        this.cachedSignals.price = null
        this.cachedSignals.pool  = null
      }
    }
    this.applyResult('supply',   supplyR,   supplyMs)
    this.applyResult('position', positionR, positionMs)
    this.applyResult('protocol', protocolR, protocolMs)
    this.applyResult('wallets',  walletsR,  walletsMs)

    const signals: AllSignals = { ...this.cachedSignals }

    const alerts = evaluateAlerts(this.alertState, signals, this.cfg, this.id)

    this.logger.debug({
      latencyMs: { market: marketMs, supply: supplyMs, position: positionMs, protocol: protocolMs, wallets: walletsMs },
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
      positionUsd:       signals.position?.netUsdValue          ?? null,
      debankMsUsdPrice:  signals.position?.debankMsUsdPrice     ?? null,
      rewardUsd:         signals.position?.rewardUsdValue        ?? null,
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

  // 子监控器运行结果统一处理：跳过则不更新，否则刷新健康状态和缓存信号
  private applyResult(name: SourceName, result: PromiseSettledResult<unknown> | null, ms: number): void {
    if (result === null) return
    this.updateSourceHealth(name, result, ms)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this.cachedSignals as any)[name] = result.status === 'fulfilled' ? result.value : null
  }

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
      this.logger.warn({ source: name, err: result.reason }, 'Data source error')
    }
  }
}
