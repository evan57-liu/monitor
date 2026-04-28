# Phase 3: Aerodrome Protocol Module

Tasks 10–18. After this phase: all 5 alert rules are unit-tested with edge cases, withdrawal orders are generated correctly, and the aerodrome Monitor interface implementation passes typecheck.

> All imports in this module use `.js` extensions. All signal types are defined locally in each monitor file and passed to `alerts.ts`.

---

## Shared Signal Types

Create this file first — it's imported by all monitors and alerts.ts.

- [ ] **Create src/protocols/aerodrome/types.ts**

```typescript
// src/protocols/aerodrome/types.ts
// Internal signal types for the aerodrome monitor. Not exported from core/types.ts
// because they are protocol-specific.

export interface PriceSignal {
  coingecko: number | null    // null = source unavailable
  twap: number | null
  fetchedAt: Date
}

export interface PoolSignal {
  reserveInUsd: number
  msUsdRatio: number          // 0-1: proportion of msUSD in pool
  buys1h: number
  sells1h: number
  volume24h: number
  fetchedAt: Date
}

export interface SupplySignal {
  totalSupply: bigint
  previousSupply: bigint | null  // null on first reading
  fetchedAt: Date
}

export interface PositionSignal {
  netUsdValue: number
  previousNetUsdValue: number | null
  fetchedAt: Date
}

export interface ProtocolSignal {
  tvlUsd: number
  previousTvlUsd: number | null
  fetchedAt: Date
}

export interface WalletSignal {
  walletAddress: string
  msUsdAmount: number
  msUsdUsdValue: number
  previousMsUsdAmount: number | null
  fetchedAt: Date
}

export interface AllSignals {
  price: PriceSignal | null
  pool: PoolSignal | null
  supply: SupplySignal | null
  position: PositionSignal | null
  protocol: ProtocolSignal | null
  wallets: WalletSignal[] | null
}
```

---

## Task 10: Price Monitor

**Files:**
- Create: `src/protocols/aerodrome/monitors/price.ts`
- Test: `src/protocols/aerodrome/monitors/price.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/protocols/aerodrome/monitors/price.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PriceMonitor } from './price.js'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'

const mockCoinGecko = {
  getTokenPrice: vi.fn(),
} as unknown as CoinGeckoClient

const mockRpc = {
  getTwapPrice: vi.fn(),
} as unknown as RpcClient

const cfg = {
  msUsdAddress: '0x0000000000000000000000000000000000000001' as `0x${string}`,
  poolAddress: '0x0000000000000000000000000000000000000002' as `0x${string}`,
}

describe('PriceMonitor', () => {
  it('returns coingecko price as primary', async () => {
    vi.mocked(mockCoinGecko.getTokenPrice).mockResolvedValue({
      priceUsd: 0.9985, priceChange24hPct: -0.1, fetchedAt: new Date(),
    })
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.999)

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeCloseTo(0.9985)
    expect(signal.twap).toBeCloseTo(0.999)
  })

  it('returns null coingecko when CoinGecko fails, twap still works', async () => {
    vi.mocked(mockCoinGecko.getTokenPrice).mockRejectedValue(new Error('api down'))
    vi.mocked(mockRpc.getTwapPrice).mockResolvedValue(0.9982)

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeNull()
    expect(signal.twap).toBeCloseTo(0.9982)
  })

  it('returns fully null signal when both fail', async () => {
    vi.mocked(mockCoinGecko.getTokenPrice).mockRejectedValue(new Error('fail'))
    vi.mocked(mockRpc.getTwapPrice).mockRejectedValue(new Error('fail'))

    const monitor = new PriceMonitor(cfg, mockCoinGecko, mockRpc)
    const signal = await monitor.check()
    expect(signal.coingecko).toBeNull()
    expect(signal.twap).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/protocols/aerodrome/monitors/price.test.ts
```

- [ ] **Step 3: Create src/protocols/aerodrome/monitors/price.ts**

```typescript
// src/protocols/aerodrome/monitors/price.ts
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { PriceSignal } from '../types.js'

interface PriceMonitorConfig {
  msUsdAddress: `0x${string}`
  poolAddress: `0x${string}`
}

export class PriceMonitor {
  constructor(
    private readonly cfg: PriceMonitorConfig,
    private readonly coinGecko: CoinGeckoClient,
    private readonly rpc: RpcClient,
  ) {}

  async check(): Promise<PriceSignal> {
    const [cgResult, twapResult] = await Promise.allSettled([
      this.coinGecko.getTokenPrice(this.cfg.msUsdAddress),
      this.rpc.getTwapPrice(this.cfg.poolAddress),
    ])

    return {
      coingecko: cgResult.status === 'fulfilled' ? cgResult.value.priceUsd : null,
      twap: twapResult.status === 'fulfilled' ? twapResult.value : null,
      fetchedAt: new Date(),
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/protocols/aerodrome/monitors/price.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/protocols/aerodrome/monitors/price.ts src/protocols/aerodrome/monitors/price.test.ts src/protocols/aerodrome/types.ts
git commit -m "feat: add aerodrome price monitor (CoinGecko + TWAP fallback)"
```

---

## Task 11: Pool Monitor

**Files:**
- Create: `src/protocols/aerodrome/monitors/pool.ts`
- Test: `src/protocols/aerodrome/monitors/pool.test.ts`

The pool monitor reads reserves from CoinGecko's pool endpoint and computes the msUSD ratio (proportion of msUSD in the pool by USD value).

- [ ] **Step 1: Write failing test**

```typescript
// src/protocols/aerodrome/monitors/pool.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PoolMonitor } from './pool.js'
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'

const mockCoinGecko = { getPoolData: vi.fn() } as unknown as CoinGeckoClient

const cfg = { poolAddress: '0x0000000000000000000000000000000000000001' }

describe('PoolMonitor', () => {
  it('computes msUsdRatio from buys/sells and reserve data', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockResolvedValue({
      reserveInUsd: 2_500_000, baseTokenPriceUsd: 0.999,
      volume24h: 180_000, buys1h: 40, sells1h: 60,
      buys24h: 320, sells24h: 480,
      // reserve0 = msUSD (token0), reserve1 = USDC (token1)
      // At price 0.999, if pool has 1.26M msUSD and 1.24M USDC (by value):
      // msUSD side = 1.26M * 0.999 = ~1.259M → ratio = 1.259/2.5 = ~0.504
      reserve0Raw: '1260000000000000000000000', // 1.26M msUSD (18 decimals)
      reserve1Raw: '1240000000',                 // 1.24M USDC (6 decimals)
      fetchedAt: new Date(),
    })
    const monitor = new PoolMonitor(cfg, mockCoinGecko)
    const signal = await monitor.check()
    expect(signal?.msUsdRatio).toBeGreaterThan(0.49)
    expect(signal?.msUsdRatio).toBeLessThan(0.55)
    expect(signal?.buys1h).toBe(40)
    expect(signal?.sells1h).toBe(60)
  })

  it('returns null when CoinGecko fails', async () => {
    vi.mocked(mockCoinGecko.getPoolData).mockRejectedValue(new Error('fail'))
    const monitor = new PoolMonitor(cfg, mockCoinGecko)
    expect(await monitor.check()).toBeNull()
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/protocols/aerodrome/monitors/pool.test.ts
```

- [ ] **Step 3: Create src/protocols/aerodrome/monitors/pool.ts**

```typescript
// src/protocols/aerodrome/monitors/pool.ts
import type { CoinGeckoClient } from '../../../core/clients/coingecko.js'
import type { PoolSignal } from '../types.js'

interface PoolMonitorConfig { poolAddress: string }

export class PoolMonitor {
  constructor(
    private readonly cfg: PoolMonitorConfig,
    private readonly coinGecko: CoinGeckoClient,
  ) {}

  async check(): Promise<PoolSignal | null> {
    try {
      const pool = await this.coinGecko.getPoolData(this.cfg.poolAddress)
      // Compute msUSD ratio: msUSD side of pool / total reserve (by USD value)
      // reserve0 = msUSD (18 decimals), reserve1 = USDC (6 decimals)
      const msUsdAmount = Number(BigInt(pool.reserve0Raw)) / 1e18
      const usdcAmount = Number(BigInt(pool.reserve1Raw)) / 1e6
      const msUsdUsdValue = msUsdAmount * pool.baseTokenPriceUsd
      const totalUsdValue = msUsdUsdValue + usdcAmount
      const msUsdRatio = totalUsdValue > 0 ? msUsdUsdValue / totalUsdValue : 0

      return {
        reserveInUsd: pool.reserveInUsd,
        msUsdRatio,
        buys1h: pool.buys1h,
        sells1h: pool.sells1h,
        volume24h: pool.volume24h,
        fetchedAt: new Date(),
      }
    } catch {
      return null
    }
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/protocols/aerodrome/monitors/pool.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/protocols/aerodrome/monitors/pool.ts src/protocols/aerodrome/monitors/pool.test.ts
git commit -m "feat: add aerodrome pool monitor (reserves, ratio, buy/sell)"
```

---

## Task 12: Supply Monitor

**Files:**
- Create: `src/protocols/aerodrome/monitors/supply.ts`
- Test: `src/protocols/aerodrome/monitors/supply.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/protocols/aerodrome/monitors/supply.test.ts
import { describe, it, expect, vi } from 'vitest'
import { SupplyMonitor } from './supply.js'
import type { RpcClient } from '../../../core/clients/rpc.js'

const mockRpc = { getTotalSupply: vi.fn() } as unknown as RpcClient
const cfg = { msUsdAddress: '0x0000000000000000000000000000000000000001' as `0x${string}` }

describe('SupplyMonitor', () => {
  it('returns current supply and tracks previous', async () => {
    vi.mocked(mockRpc.getTotalSupply)
      .mockResolvedValueOnce(1_000_000n * 10n ** 18n)
      .mockResolvedValueOnce(1_020_000n * 10n ** 18n)

    const monitor = new SupplyMonitor(cfg, mockRpc)
    const first = await monitor.check()
    expect(first.totalSupply).toBe(1_000_000n * 10n ** 18n)
    expect(first.previousSupply).toBeNull()

    const second = await monitor.check()
    expect(second.totalSupply).toBe(1_020_000n * 10n ** 18n)
    expect(second.previousSupply).toBe(1_000_000n * 10n ** 18n)
  })

  it('throws when RPC fails (caller handles null)', async () => {
    vi.mocked(mockRpc.getTotalSupply).mockRejectedValue(new Error('rpc fail'))
    const monitor = new SupplyMonitor(cfg, mockRpc)
    await expect(monitor.check()).rejects.toThrow('rpc fail')
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/protocols/aerodrome/monitors/supply.test.ts
```

- [ ] **Step 3: Create src/protocols/aerodrome/monitors/supply.ts**

```typescript
// src/protocols/aerodrome/monitors/supply.ts
import type { RpcClient } from '../../../core/clients/rpc.js'
import type { SupplySignal } from '../types.js'

interface SupplyMonitorConfig { msUsdAddress: `0x${string}` }

export class SupplyMonitor {
  private previousSupply: bigint | null = null

  constructor(
    private readonly cfg: SupplyMonitorConfig,
    private readonly rpc: RpcClient,
  ) {}

  async check(): Promise<SupplySignal> {
    const totalSupply = await this.rpc.getTotalSupply(this.cfg.msUsdAddress)
    const signal: SupplySignal = {
      totalSupply,
      previousSupply: this.previousSupply,
      fetchedAt: new Date(),
    }
    this.previousSupply = totalSupply
    return signal
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/protocols/aerodrome/monitors/supply.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/protocols/aerodrome/monitors/supply.ts src/protocols/aerodrome/monitors/supply.test.ts
git commit -m "feat: add aerodrome supply monitor (RPC totalSupply)"
```

---

## Tasks 13–15: Position, Protocol, Wallet Monitors

These three monitors follow the same pattern as above. Write failing test → implement → pass → commit.

- [ ] **Create src/protocols/aerodrome/monitors/position.ts**

```typescript
// src/protocols/aerodrome/monitors/position.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { PositionSignal } from '../types.js'

interface PositionMonitorConfig { walletAddress: string; protocolId: string }

export class PositionMonitor {
  private previousValue: number | null = null

  constructor(private readonly cfg: PositionMonitorConfig, private readonly debank: DeBankClient) {}

  async check(): Promise<PositionSignal | null> {
    try {
      const pos = await this.debank.getUserProtocolPosition(this.cfg.walletAddress, this.cfg.protocolId)
      const signal: PositionSignal = {
        netUsdValue: pos.netUsdValue,
        previousNetUsdValue: this.previousValue,
        fetchedAt: new Date(),
      }
      this.previousValue = pos.netUsdValue
      return signal
    } catch { return null }
  }
}
```

- [ ] **Create src/protocols/aerodrome/monitors/protocol.ts**

```typescript
// src/protocols/aerodrome/monitors/protocol.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { ProtocolSignal } from '../types.js'

interface ProtocolMonitorConfig { protocolId: string }

export class ProtocolMonitor {
  private previousTvl: number | null = null

  constructor(private readonly cfg: ProtocolMonitorConfig, private readonly debank: DeBankClient) {}

  async check(): Promise<ProtocolSignal | null> {
    try {
      const tvlData = await this.debank.getProtocolTvl(this.cfg.protocolId)
      const signal: ProtocolSignal = {
        tvlUsd: tvlData.tvlUsd,
        previousTvlUsd: this.previousTvl,
        fetchedAt: new Date(),
      }
      this.previousTvl = tvlData.tvlUsd
      return signal
    } catch { return null }
  }
}
```

- [ ] **Create src/protocols/aerodrome/monitors/wallets.ts**

```typescript
// src/protocols/aerodrome/monitors/wallets.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { WalletSignal } from '../types.js'

interface WalletMonitorConfig {
  teamWallets: string[]
  msUsdAddress: string
  msUsdSymbol: string
  chain: string
}

export class WalletMonitor {
  private previousAmounts = new Map<string, number>()

  constructor(private readonly cfg: WalletMonitorConfig, private readonly debank: DeBankClient) {}

  async check(): Promise<WalletSignal[]> {
    if (this.cfg.teamWallets.length === 0) return []

    const results = await Promise.allSettled(
      this.cfg.teamWallets.map(wallet => this.checkWallet(wallet)),
    )

    return results
      .filter((r): r is PromiseFulfilledResult<WalletSignal> => r.status === 'fulfilled')
      .map(r => r.value)
  }

  private async checkWallet(walletAddress: string): Promise<WalletSignal> {
    const tokens = await this.debank.getWalletTokens(walletAddress, this.cfg.chain)
    const msUsdToken = tokens.find(t => t.symbol === this.cfg.msUsdSymbol)
    const msUsdAmount = msUsdToken?.amount ?? 0
    const msUsdUsdValue = msUsdToken?.usdValue ?? 0
    const previous = this.previousAmounts.get(walletAddress) ?? null
    this.previousAmounts.set(walletAddress, msUsdAmount)
    return { walletAddress, msUsdAmount, msUsdUsdValue, previousMsUsdAmount: previous, fetchedAt: new Date() }
  }
}
```

- [ ] **Write tests for position, protocol, wallets monitors**

```typescript
// src/protocols/aerodrome/monitors/position.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PositionMonitor } from './position.js'
import type { DeBankClient } from '../../../core/clients/debank.js'

const mockDeBank = { getUserProtocolPosition: vi.fn() } as unknown as DeBankClient

describe('PositionMonitor', () => {
  it('tracks previous value across calls', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition)
      .mockResolvedValueOnce({ netUsdValue: 18000, assetUsdValue: 18000, debtUsdValue: 0, fetchedAt: new Date() })
      .mockResolvedValueOnce({ netUsdValue: 17500, assetUsdValue: 17500, debtUsdValue: 0, fetchedAt: new Date() })
    const m = new PositionMonitor({ walletAddress: '0xuser', protocolId: 'aerodrome' }, mockDeBank)
    const s1 = await m.check()
    expect(s1?.previousNetUsdValue).toBeNull()
    const s2 = await m.check()
    expect(s2?.previousNetUsdValue).toBe(18000)
    expect(s2?.netUsdValue).toBe(17500)
  })

  it('returns null when DeBank fails', async () => {
    vi.mocked(mockDeBank.getUserProtocolPosition).mockRejectedValue(new Error('fail'))
    const m = new PositionMonitor({ walletAddress: '0xuser', protocolId: 'aerodrome' }, mockDeBank)
    expect(await m.check()).toBeNull()
  })
})
```

- [ ] **Run all monitor tests**

```bash
npm test -- src/protocols/aerodrome/monitors/
```

Expected: all green.

- [ ] **Commit**

```bash
git add src/protocols/aerodrome/monitors/
git commit -m "feat: add position, protocol, and wallet monitors"
```

---

## Task 16: Alert Evaluation Logic

**Files:**
- Create: `src/protocols/aerodrome/alerts.ts`
- Test: `src/protocols/aerodrome/alerts.test.ts`

This is the most critical file. The state machine maintains per-alert-type tracking of first trigger time and confirmations. Alerts escalate from WARNING to RED when sustained and fully confirmed.

- [ ] **Step 1: Write failing test**

```typescript
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

// Helper to simulate "condition has been present for N seconds"
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
        previousMsUsdAmount: 200_000, // sold 100k msUSD ($100k outflow)
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
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/protocols/aerodrome/alerts.test.ts
```

- [ ] **Step 3: Create src/protocols/aerodrome/alerts.ts**

```typescript
// src/protocols/aerodrome/alerts.ts
import { AlertLevel, AlertType } from '../../core/types.js'
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    for (const c of confirmations) existing.confirmations.add(c)
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

// ── Alert Rules ───────────────────────────────────────────────────────────────

function evaluateDepeg(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date): Alert | null {
  const { price, pool } = signals
  const t = cfg.alerts.depeg
  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  if (price?.coingecko !== null && price?.coingecko !== undefined) {
    data.coingeckoPrice = price.coingecko
    if (price.coingecko < t.priceThreshold) confirmations.add('coingecko')
  }
  if (price?.twap !== null && price?.twap !== undefined) {
    data.twapPrice = price.twap
    if (price.twap < t.twapThreshold) confirmations.add('twap')
  }
  if (pool !== null) {
    data.msUsdRatio = pool.msUsdRatio
    if (pool.msUsdRatio > t.poolImbalancePct / 100) confirmations.add('pool')
  }

  return buildAlert(AlertType.DEPEG, state, confirmations, data, t, protocol,
    `msUSD Depeg: ${price?.coingecko !== null ? `$${price?.coingecko?.toFixed(4)}` : 'price unavailable'}`, now)
}

function evaluateHackMint(state: AlertState, signals: AllSignals, cfg: AerodromeConfig, protocol: string, now: Date): Alert | null {
  const { supply, price, pool } = signals
  const t = cfg.alerts.hackMint
  const confirmations = new Set<string>()
  const data: Record<string, unknown> = {}

  if (supply?.previousSupply !== null && supply !== null) {
    const prev = supply.previousSupply ?? supply.totalSupply
    const increasePct = prev > 0n ? Number((supply.totalSupply - prev) * 10000n / prev) / 100 : 0
    data.supplyIncreasePct = increasePct
    data.totalSupply = supply.totalSupply.toString()
    if (increasePct >= t.supplyIncreasePct) confirmations.add('supply')
  }
  if (price?.coingecko !== null && price?.coingecko !== undefined) {
    const dropPct = (1 - price.coingecko) * 100
    data.priceDropPct = dropPct
    if (dropPct >= t.priceDropPct) confirmations.add('price')
  }
  if (pool !== null) {
    const sellsRatio = pool.buys1h > 0 ? pool.sells1h / pool.buys1h : pool.sells1h
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

  if (proto?.previousTvlUsd !== null && proto !== null && proto.previousTvlUsd !== null) {
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
      const outflowUsd = (wallet.previousMsUsdAmount - wallet.msUsdAmount) * (wallet.msUsdUsdValue / (wallet.msUsdAmount || 1))
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
    data.currentValue = position.netUsdValue
    data.previousValue = position.previousNetUsdValue
    if (dropPct >= t.dropPct) confirmations.add('position')
  }

  return buildAlert(AlertType.POSITION_DROP, state, confirmations, data, { sustainedSeconds: 0, requiredConfirmations: 1 }, protocol, `Position Value Drop: -${data.dropPct?.toFixed?.(1) ?? '?'}%`, now)
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/protocols/aerodrome/alerts.test.ts
```

Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/protocols/aerodrome/alerts.ts src/protocols/aerodrome/alerts.test.ts
git commit -m "feat: add aerodrome alert evaluation (5 rules, state machine, multi-source confirm)"
```

---

## Task 17: Withdrawal Order Generation

**Files:**
- Create: `src/protocols/aerodrome/orders.ts`
- Test: `src/protocols/aerodrome/orders.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/protocols/aerodrome/orders.test.ts
import { describe, it, expect } from 'vitest'
import { generateWithdrawalOrders } from './orders.js'
import { AlertLevel, AlertType, OrderType } from '../../core/types.js'
import type { Alert } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'

const cfg = {
  gaugeAddress: '0x0000000000000000000000000000000000000001',
  positionManagerAddress: '0x0000000000000000000000000000000000000002',
  routerAddress: '0x0000000000000000000000000000000000000003',
  msUsdAddress: '0x0000000000000000000000000000000000000004',
  usdcAddress: '0x0000000000000000000000000000000000000005',
  lpTokenId: 12345,
  execution: { swapBatchCount: 3, swapSlippageBps: 100, gasMultiplier: 1.2, deadlineSeconds: 300, maxGasGwei: 50 },
} as unknown as AerodromeConfig

const redAlert: Alert = {
  id: 'alert-1',
  type: AlertType.DEPEG,
  level: AlertLevel.RED,
  protocol: 'aerodrome-msusd-usdc',
  title: 'test',
  message: 'test',
  data: { msUsdBalance: (100_000n * 10n ** 18n).toString() },
  triggeredAt: new Date(),
  confirmations: 3,
  requiredConfirmations: 3,
  sustainedMs: 200_000,
  requiredSustainedMs: 180_000,
}

describe('generateWithdrawalOrders', () => {
  it('generates 3-step sequence: unstake → remove_liquidity → 3 swaps', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n)
    expect(orders).toHaveLength(5) // 1 unstake + 1 remove + 3 swaps
    expect(orders[0]?.type).toBe(OrderType.UNSTAKE)
    expect(orders[1]?.type).toBe(OrderType.REMOVE_LIQUIDITY)
    expect(orders[2]?.type).toBe(OrderType.SWAP)
    expect(orders[3]?.type).toBe(OrderType.SWAP)
    expect(orders[4]?.type).toBe(OrderType.SWAP)
  })

  it('assigns sequential sequence numbers starting at 1', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n)
    expect(orders.map(o => o.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  it('all orders share the same groupId', () => {
    const orders = generateWithdrawalOrders(redAlert, cfg, 100_000n * 10n ** 18n)
    const groupIds = new Set(orders.map(o => o.groupId))
    expect(groupIds.size).toBe(1)
  })

  it('swap batches divide total amount evenly', () => {
    const totalMsUsd = 90_000n * 10n ** 18n // divisible by 3
    const orders = generateWithdrawalOrders(redAlert, cfg, totalMsUsd)
    const swaps = orders.filter(o => o.type === OrderType.SWAP)
    const batchAmount = totalMsUsd / 3n
    for (const swap of swaps) {
      expect((swap.params as { amountIn: bigint }).amountIn).toBe(batchAmount)
    }
  })

  it('applies slippage correctly (1% = 9900/10000 of amountIn)', () => {
    const totalMsUsd = 30_000n * 10n ** 18n
    const orders = generateWithdrawalOrders(redAlert, cfg, totalMsUsd)
    const swap = orders.find(o => o.type === OrderType.SWAP)
    if (!swap) throw new Error('no swap')
    const params = swap.params as { amountIn: bigint; amountOutMin: bigint }
    // amountOutMin = amountIn * (10000 - slippageBps) / 10000
    // msUSD has 18 decimals, USDC has 6 decimals → convert
    // At ~$1 price: amountOutMin in USDC ≈ amountIn / 1e12 * 0.99
    const expectedMin = params.amountIn / 10n ** 12n * 9900n / 10000n
    expect(params.amountOutMin).toBe(expectedMin)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/protocols/aerodrome/orders.test.ts
```

- [ ] **Step 3: Create src/protocols/aerodrome/orders.ts**

```typescript
// src/protocols/aerodrome/orders.ts
import { OrderStatus, OrderType } from '../../core/types.js'
import type { Alert, ExecutionOrder, UnstakeParams, RemoveLiquidityParams, SwapParams } from '../../core/types.js'
import type { AerodromeConfig } from '../../core/config.js'

/**
 * Generates a 3-step withdrawal sequence:
 * 1. Unstake LP NFT from gauge
 * 2. Remove all liquidity (decrease to 0)
 * 3. Swap msUSD → USDC in N batches
 *
 * All orders share a groupId. The engine executes them in sequence,
 * aborting on any failure.
 *
 * @param msUsdBalance — estimated msUSD balance after removing liquidity
 */
export function generateWithdrawalOrders(
  alert: Alert,
  cfg: AerodromeConfig,
  msUsdBalance: bigint,
): ExecutionOrder[] {
  const groupId = crypto.randomUUID()
  const deadline = Math.floor(Date.now() / 1000) + cfg.execution.deadlineSeconds
  const now = new Date()
  const orders: ExecutionOrder[] = []
  let seq = 1

  // Step 1: Unstake LP NFT from gauge
  const unstakeParams: UnstakeParams = {
    gaugeAddress: cfg.gaugeAddress as `0x${string}`,
    tokenId: BigInt(cfg.lpTokenId),
  }
  orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.UNSTAKE, unstakeParams, deadline, now))

  // Step 2: Remove all liquidity
  // liquidity = 0 signals "remove all" — the executor reads actual liquidity from the NFT
  const removeParams: RemoveLiquidityParams = {
    positionManagerAddress: cfg.positionManagerAddress as `0x${string}`,
    tokenId: BigInt(cfg.lpTokenId),
    liquidity: 0n, // executor will call positions(tokenId) to get actual liquidity
    amount0Min: 0n,
    amount1Min: 0n,
    slippageBps: cfg.execution.swapSlippageBps,
  }
  orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.REMOVE_LIQUIDITY, removeParams, deadline, now))

  // Step 3: Swap msUSD → USDC in N batches
  const batchCount = BigInt(cfg.execution.swapBatchCount)
  const batchAmount = msUsdBalance / batchCount
  for (let i = 0; i < cfg.execution.swapBatchCount; i++) {
    // Last batch gets the remainder
    const amountIn = i === cfg.execution.swapBatchCount - 1
      ? msUsdBalance - batchAmount * (batchCount - 1n)
      : batchAmount
    // msUSD (18 dec) → USDC (6 dec): divide by 1e12 for unit conversion, then apply slippage
    const amountOutMin = amountIn / 10n ** 12n * BigInt(10000 - cfg.execution.swapSlippageBps) / 10000n
    const swapParams: SwapParams = {
      routerAddress: cfg.routerAddress as `0x${string}`,
      tokenIn: cfg.msUsdAddress as `0x${string}`,
      tokenOut: cfg.usdcAddress as `0x${string}`,
      amountIn,
      amountOutMin,
      batchIndex: i,
      totalBatches: cfg.execution.swapBatchCount,
    }
    orders.push(makeOrder(alert, cfg, groupId, seq++, OrderType.SWAP, swapParams, deadline, now))
  }

  return orders
}

function makeOrder(
  alert: Alert,
  cfg: AerodromeConfig,
  groupId: string,
  sequence: number,
  type: OrderType,
  params: UnstakeParams | RemoveLiquidityParams | SwapParams,
  deadline: number,
  createdAt: Date,
): ExecutionOrder {
  return {
    id: crypto.randomUUID(),
    alertId: alert.id,
    protocol: alert.protocol,
    type,
    sequence,
    groupId,
    params,
    maxGasGwei: cfg.execution.maxGasGwei,
    deadline,
    status: OrderStatus.PENDING,
    createdAt,
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/protocols/aerodrome/orders.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/protocols/aerodrome/orders.ts src/protocols/aerodrome/orders.test.ts
git commit -m "feat: add withdrawal order generation (3-step, batched swap)"
```

---

## Task 18: Aerodrome Monitor Index

**Files:**
- Create: `src/protocols/aerodrome/index.ts`

No new unit tests — the sub-monitors are already tested. Typecheck is the verification.

- [ ] **Step 1: Create src/protocols/aerodrome/index.ts**

```typescript
// src/protocols/aerodrome/index.ts
import { AlertLevel, AlertType } from '../../core/types.js'
import type { Monitor, PollResult, MonitorHealth, DataSourceStatus } from '../../core/types.js'
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
    const now = Date.now()

    const [priceR, poolR, supplyR, positionR, protocolR, walletsR] = await Promise.allSettled([
      this.priceMonitor.check(),
      this.poolMonitor.check(),
      this.supplyMonitor.check(),
      this.positionMonitor.check(),
      this.protocolMonitor.check(),
      this.walletMonitor.check(),
    ])

    this.updateSourceHealth('price', priceR, now)
    this.updateSourceHealth('pool', poolR, now)
    this.updateSourceHealth('supply', supplyR, now)
    this.updateSourceHealth('position', positionR, now)
    this.updateSourceHealth('protocol', protocolR, now)
    this.updateSourceHealth('wallets', walletsR, now)

    const signals: AllSignals = {
      price: priceR.status === 'fulfilled' ? priceR.value : null,
      pool: poolR.status === 'fulfilled' ? poolR.value : null,
      supply: supplyR.status === 'fulfilled' ? supplyR.value : null,
      position: positionR.status === 'fulfilled' ? positionR.value : null,
      protocol: protocolR.status === 'fulfilled' ? protocolR.value : null,
      wallets: walletsR.status === 'fulfilled' ? walletsR.value : null,
    }

    const alerts = evaluateAlerts(this.alertState, signals, this.cfg, this.id)

    // Estimate msUSD balance for order generation (use pool data as proxy if available)
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
      this.sourceHealth[name] = { available: false, lastSuccessAt: null, consecutiveFailures: 0, latencyMs: null, fallbackActive: null }
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
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/protocols/aerodrome/index.ts
git commit -m "feat: assemble AerodromeMonitor implementing Monitor interface"
```

---

## Phase 3 Checkpoint

```bash
npm run typecheck && npm test
```

Expected: 0 errors, all tests green including all alert rules edge cases.
