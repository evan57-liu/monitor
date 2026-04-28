# Phase 1: Project Scaffold

Tasks 1–5. After this phase: `npm run typecheck && npm test` pass, SQLite schema is live, config loads from YAML + .env.

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "defi-monitor",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "dotenv": "^16.0.0",
    "nodemailer": "^6.0.0",
    "pino": "^9.0.0",
    "viem": "^2.0.0",
    "yaml": "^2.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.0.0",
    "@types/node": "^22.0.0",
    "@types/nodemailer": "^6.0.0",
    "pino-pretty": "^11.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.8.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

> **Important:** With `"module": "NodeNext"`, all imports in `.ts` files must use `.js` extension:
> ```typescript
> import { foo } from './foo.js'   // ✅ correct
> import { foo } from './foo'      // ❌ wrong
> ```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
  },
})
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
data/
configs/.env
*.env
!configs/.env.example
```

- [ ] **Step 5: Install dependencies**

```bash
cd /Users/57block/web3project/monitor
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Commit**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .gitignore
git commit -m "chore: initialise TypeScript project scaffold"
```

---

## Task 2: Core Types

**Files:**
- Create: `src/core/types.ts`

This file has no unit tests — type correctness is verified by `npm run typecheck`. Write the file in full, then typecheck.

- [ ] **Step 1: Create src/core/types.ts**

```typescript
// src/core/types.ts
// Central contract for the entire system. All interfaces and enums live here.
// Other modules import from this file. This file imports nothing from the project.

// ── Enums ─────────────────────────────────────────────────────────────────────

export enum AlertLevel {
  INFO = 'info',
  WARNING = 'warning',
  RED = 'red',
}

export enum AlertType {
  DEPEG = 'depeg',
  HACK_MINT = 'hack_mint',
  LIQUIDITY_DRAIN = 'liquidity_drain',
  INSIDER_EXIT = 'insider_exit',
  POSITION_DROP = 'position_drop',
  DATA_SOURCE_FAILURE = 'data_source_failure',
}

export enum OrderType {
  UNSTAKE = 'unstake',
  REMOVE_LIQUIDITY = 'remove_liquidity',
  SWAP = 'swap',
}

export enum OrderStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  SKIPPED_DRY_RUN = 'skipped_dry_run',
}

// ── Monitor ───────────────────────────────────────────────────────────────────

export interface Monitor {
  readonly id: string
  readonly name: string
  readonly pollIntervalMs: number
  init(): Promise<void>
  poll(): Promise<PollResult>
  shutdown(): Promise<void>
}

export interface PollResult {
  alerts: Alert[]
  orders: ExecutionOrder[]
  health: MonitorHealth
}

export interface MonitorHealth {
  healthy: boolean
  sources: Record<string, DataSourceStatus>
  checkedAt: Date
}

export interface DataSourceStatus {
  available: boolean
  lastSuccessAt: Date | null
  consecutiveFailures: number
  latencyMs: number | null
  /** null = primary is active */
  fallbackActive: string | null
}

// ── Alert ─────────────────────────────────────────────────────────────────────

export interface Alert {
  id: string
  type: AlertType
  level: AlertLevel
  protocol: string
  title: string
  /** Markdown-formatted detail for notifications */
  message: string
  /** Structured evidence data for storage */
  data: Record<string, unknown>
  triggeredAt: Date
  confirmations: number
  requiredConfirmations: number
  sustainedMs: number
  requiredSustainedMs: number
}

// ── ExecutionOrder ────────────────────────────────────────────────────────────

export interface ExecutionOrder {
  id: string
  alertId: string
  protocol: string
  type: OrderType
  /** 1-based sequence within the withdrawal group */
  sequence: number
  /** Orders with the same groupId execute sequentially; abort on failure */
  groupId: string
  params: UnstakeParams | RemoveLiquidityParams | SwapParams
  /** Refuse to execute above this gas price (gwei) */
  maxGasGwei: number
  /** Unix timestamp deadline for the transaction */
  deadline: number
  status: OrderStatus
  txHash?: string
  error?: string
  createdAt: Date
  executedAt?: Date
}

export interface UnstakeParams {
  gaugeAddress: `0x${string}`
  tokenId: bigint
}

export interface RemoveLiquidityParams {
  positionManagerAddress: `0x${string}`
  tokenId: bigint
  liquidity: bigint
  amount0Min: bigint
  amount1Min: bigint
  /** Basis points, e.g. 100 = 1% */
  slippageBps: number
}

export interface SwapParams {
  routerAddress: `0x${string}`
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  amountIn: bigint
  amountOutMin: bigint
  batchIndex: number
  totalBatches: number
}

// ── Notification ──────────────────────────────────────────────────────────────

export interface NotificationChannel {
  readonly name: string
  /** Returns true if delivered, false on failure. Must NOT throw. */
  send(notification: Notification): Promise<boolean>
  test(): Promise<boolean>
}

export interface Notification {
  title: string
  /** Markdown-formatted body */
  body: string
  level: AlertLevel
  metadata?: Record<string, unknown>
}

// ── Executor ──────────────────────────────────────────────────────────────────

export interface Executor {
  execute(order: ExecutionOrder): Promise<ExecutionResult>
}

export interface ExecutionResult {
  status: OrderStatus
  txHash?: string
  gasUsed?: bigint
  gasPriceGwei?: number
  error?: string
  executedAt: Date
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: add core types and interfaces"
```

---

## Task 3: Config Module

**Files:**
- Create: `configs/monitor.yaml`
- Create: `configs/.env.example`
- Create: `src/core/config.ts`
- Test: `src/core/config.test.ts`

- [ ] **Step 1: Create configs/.env.example**

```bash
# CoinGecko Pro API key
DM_COINGECKO_API_KEY=CG-xxxxxxxxxxxxxxxxxxxx

# DeBank Pro access key
DM_DEBANK_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxx

# Execution wallet private key (0x-prefixed)
DM_PRIVATE_KEY=0x...

# ServerChan send key
DM_SERVERCHAN_SENDKEY=SCTxxxxxxxxxxxxxxxxxx

# Gmail app password (not your account password)
DM_EMAIL_USER=you@gmail.com
DM_EMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx

# Healthchecks.io ping URL
DM_HEALTHCHECKS_PING_URL=https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Optional: override Base RPC URL
# DM_RPC_BASE_URL=https://mainnet.base.org
```

- [ ] **Step 2: Create configs/monitor.yaml**

```yaml
# Environment variable prefix: DM_
# Any value can be overridden via env var with DM_ prefix + SCREAMING_SNAKE_CASE key path
# e.g., DM_GLOBAL_DRY_RUN=false overrides global.dry_run

global:
  dry_run: true
  log_level: "info"   # debug | info | warn | error

sources:
  coingecko:
    base_url: "https://pro-api.coingecko.com/api/v3"
    rate_limit_per_minute: 500
    timeout_ms: 10000
    retry_attempts: 3
  debank:
    base_url: "https://pro-openapi.debank.com/v1"
    timeout_ms: 15000
    retry_attempts: 3
  rpc:
    base:
      url: "https://mainnet.base.org"
      timeout_ms: 10000
      retry_attempts: 3

notifications:
  serverchan:
    enabled: true
    timeout_ms: 5000
    retry_attempts: 5
  email:
    enabled: true
    smtp_host: "smtp.gmail.com"
    smtp_port: 587
    from: "defi-monitor@gmail.com"
    to:
      - "your@email.com"
    retry_attempts: 5
    daily_summary_hour: 9
  healthchecks:
    enabled: true
    interval_seconds: 60

protocols:
  aerodrome_msusd_usdc:
    enabled: true
    chain: "base"
    chain_id: 8453

    # Find these on Basescan / Aerodrome UI
    pool_address: "FILL_IN"              # Aerodrome msUSD/USDC pool
    gauge_address: "FILL_IN"             # Gauge contract for staking LP NFT
    msusd_address: "FILL_IN"             # msUSD token on Base
    usdc_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  # USDC on Base
    router_address: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"  # Aerodrome Router v2
    position_manager_address: "0x827922686190790b37229fd06084350E74485b72"  # Aerodrome NonfungiblePositionManager

    # Your LP NFT token ID (from Aerodrome UI or Basescan)
    lp_token_id: 0

    # Metronome team/treasury wallets (for insider exit detection)
    team_wallets: []

    polling:
      price_ms: 10000       # 10s — CoinGecko price
      pool_ms: 30000        # 30s — pool reserves + buys/sells
      supply_ms: 60000      # 60s — totalSupply via RPC
      position_ms: 60000    # 60s — your position value via DeBank
      protocol_ms: 120000   # 2min — Metronome protocol TVL
      team_wallets_ms: 120000  # 2min — team wallet holdings

    alerts:
      depeg:
        price_threshold: 0.992      # CoinGecko price below this triggers
        twap_threshold: 0.992       # On-chain TWAP below this confirms
        pool_imbalance_pct: 75      # msUSD ratio in pool > 75% confirms
        sustained_seconds: 180      # Must persist 3min before RED
        required_confirmations: 3   # All 3 sources must confirm

      hack_mint:
        supply_increase_pct: 15     # totalSupply +15% in window
        supply_window_seconds: 3600
        price_drop_pct: 2
        sells_spike_multiplier: 5

      liquidity_drain:
        tvl_drop_pct: 30
        tvl_window_seconds: 3600
        pool_msusd_ratio_pct: 70
        sells_buys_ratio: 3

      insider_exit:
        large_outflow_usd: 50000
        price_drop_pct: 1

      position_drop:
        drop_pct: 10
        window_seconds: 3600

    execution:
      swap_batch_count: 3
      swap_slippage_bps: 100    # 1%
      gas_multiplier: 1.2
      deadline_seconds: 300
      max_gas_gwei: 50

storage:
  sqlite_path: "data/monitor.db"
  retention_days:
    price_history: 30
    pool_snapshots: 30
    health_snapshots: 7
```

- [ ] **Step 3: Write failing config test**

```typescript
// src/core/config.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from './config.js'

const TMP = join(tmpdir(), 'dm-config-test')

const MINIMAL_YAML = `
global:
  dry_run: true
  log_level: "info"
sources:
  coingecko:
    base_url: "https://pro-api.coingecko.com/api/v3"
    rate_limit_per_minute: 500
    timeout_ms: 10000
    retry_attempts: 3
  debank:
    base_url: "https://pro-openapi.debank.com/v1"
    timeout_ms: 15000
    retry_attempts: 3
  rpc:
    base:
      url: "https://mainnet.base.org"
      timeout_ms: 10000
      retry_attempts: 3
notifications:
  serverchan:
    enabled: false
    timeout_ms: 5000
    retry_attempts: 3
  email:
    enabled: false
    smtp_host: "smtp.gmail.com"
    smtp_port: 587
    from: "x@gmail.com"
    to: ["x@gmail.com"]
    retry_attempts: 3
    daily_summary_hour: 9
  healthchecks:
    enabled: false
    interval_seconds: 60
protocols:
  aerodrome_msusd_usdc:
    enabled: true
    chain: "base"
    chain_id: 8453
    pool_address: "0x0000000000000000000000000000000000000001"
    gauge_address: "0x0000000000000000000000000000000000000002"
    msusd_address: "0x0000000000000000000000000000000000000003"
    usdc_address: "0x0000000000000000000000000000000000000004"
    router_address: "0x0000000000000000000000000000000000000005"
    position_manager_address: "0x0000000000000000000000000000000000000006"
    lp_token_id: 12345
    team_wallets: []
    polling:
      price_ms: 10000
      pool_ms: 30000
      supply_ms: 60000
      position_ms: 60000
      protocol_ms: 120000
      team_wallets_ms: 120000
    alerts:
      depeg:
        price_threshold: 0.992
        twap_threshold: 0.992
        pool_imbalance_pct: 75
        sustained_seconds: 180
        required_confirmations: 3
      hack_mint:
        supply_increase_pct: 15
        supply_window_seconds: 3600
        price_drop_pct: 2
        sells_spike_multiplier: 5
      liquidity_drain:
        tvl_drop_pct: 30
        tvl_window_seconds: 3600
        pool_msusd_ratio_pct: 70
        sells_buys_ratio: 3
      insider_exit:
        large_outflow_usd: 50000
        price_drop_pct: 1
      position_drop:
        drop_pct: 10
        window_seconds: 3600
    execution:
      swap_batch_count: 3
      swap_slippage_bps: 100
      gas_multiplier: 1.2
      deadline_seconds: 300
      max_gas_gwei: 50
storage:
  sqlite_path: "data/monitor.db"
  retention_days:
    price_history: 30
    pool_snapshots: 30
    health_snapshots: 7
`

const MINIMAL_ENV = `
DM_COINGECKO_API_KEY=test-cg-key
DM_DEBANK_ACCESS_KEY=test-db-key
DM_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
DM_SERVERCHAN_SENDKEY=SCTtest
DM_EMAIL_USER=test@gmail.com
DM_EMAIL_PASSWORD=test-pass
DM_HEALTHCHECKS_PING_URL=https://hc-ping.com/test
`

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  writeFileSync(join(TMP, 'monitor.yaml'), MINIMAL_YAML)
  writeFileSync(join(TMP, '.env'), MINIMAL_ENV)
})

describe('loadConfig', () => {
  it('loads yaml and env secrets', () => {
    const cfg = loadConfig(join(TMP, 'monitor.yaml'), join(TMP, '.env'))
    expect(cfg.global.dryRun).toBe(true)
    expect(cfg.secrets.coingeckoApiKey).toBe('test-cg-key')
    expect(cfg.secrets.privateKey).toStartWith('0x')
  })

  it('exposes aerodrome protocol config', () => {
    const cfg = loadConfig(join(TMP, 'monitor.yaml'), join(TMP, '.env'))
    const ae = cfg.protocols.aerodromeMusdUsdc
    expect(ae.chainId).toBe(8453)
    expect(ae.lpTokenId).toBe(12345)
    expect(ae.alerts.depeg.priceThreshold).toBe(0.992)
    expect(ae.execution.swapBatchCount).toBe(3)
  })

  it('throws when required secret is missing', () => {
    writeFileSync(join(TMP, '.env'), '') // empty env
    expect(() => loadConfig(join(TMP, 'monitor.yaml'), join(TMP, '.env'))).toThrow(
      /DM_COINGECKO_API_KEY/,
    )
  })
})
```

- [ ] **Step 4: Run test — expect FAIL**

```bash
npm test -- src/core/config.test.ts
```

Expected: `Cannot find module './config.js'`

- [ ] **Step 5: Create src/core/config.ts**

```typescript
// src/core/config.ts
import { readFileSync } from 'node:fs'
import { config as loadDotenv } from 'dotenv'
import { parse } from 'yaml'

// ── Config types ───────────────────────────────────────────────────────────────

export interface AppConfig {
  global: { dryRun: boolean; logLevel: string }
  sources: {
    coingecko: { baseUrl: string; rateLimitPerMinute: number; timeoutMs: number; retryAttempts: number }
    debank: { baseUrl: string; timeoutMs: number; retryAttempts: number }
    rpc: { base: { url: string; timeoutMs: number; retryAttempts: number } }
  }
  notifications: {
    serverchan: { enabled: boolean; sendkey: string; timeoutMs: number; retryAttempts: number }
    email: {
      enabled: boolean; smtpHost: string; smtpPort: number; user: string; password: string
      from: string; to: string[]; retryAttempts: number; dailySummaryHour: number
    }
    healthchecks: { enabled: boolean; pingUrl: string; intervalSeconds: number }
  }
  protocols: { aerodromeMusdUsdc: AerodromeConfig }
  storage: { sqlitePath: string; retentionDays: { priceHistory: number; poolSnapshots: number; healthSnapshots: number } }
  secrets: { coingeckoApiKey: string; debankAccessKey: string; privateKey: string }
}

export interface AerodromeConfig {
  enabled: boolean
  chain: string
  chainId: number
  poolAddress: string
  gaugeAddress: string
  msUsdAddress: string
  usdcAddress: string
  routerAddress: string
  positionManagerAddress: string
  lpTokenId: number
  teamWallets: string[]
  polling: { priceMs: number; poolMs: number; supplyMs: number; positionMs: number; protocolMs: number; teamWalletsMs: number }
  alerts: {
    depeg: { priceThreshold: number; twapThreshold: number; poolImbalancePct: number; sustainedSeconds: number; requiredConfirmations: number }
    hackMint: { supplyIncreasePct: number; supplyWindowSeconds: number; priceDropPct: number; sellsSpikeMultiplier: number }
    liquidityDrain: { tvlDropPct: number; tvlWindowSeconds: number; poolMsUsdRatioPct: number; sellsBuysRatio: number }
    insiderExit: { largeOutflowUsd: number; priceDropPct: number }
    positionDrop: { dropPct: number; windowSeconds: number }
  }
  execution: { swapBatchCount: number; swapSlippageBps: number; gasMultiplier: number; deadlineSeconds: number; maxGasGwei: number }
}

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadConfig(yamlPath: string, envPath: string): AppConfig {
  loadDotenv({ path: envPath, override: false })

  const raw = readFileSync(yamlPath, 'utf8')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const y = parse(raw) as any

  const secrets = {
    coingeckoApiKey: requireEnv('DM_COINGECKO_API_KEY'),
    debankAccessKey: requireEnv('DM_DEBANK_ACCESS_KEY'),
    privateKey: requireEnv('DM_PRIVATE_KEY'),
  }

  const ae = y.protocols.aerodrome_msusd_usdc

  return {
    global: {
      dryRun: process.env['DM_GLOBAL_DRY_RUN'] === 'false' ? false : Boolean(y.global.dry_run),
      logLevel: (process.env['DM_GLOBAL_LOG_LEVEL'] ?? y.global.log_level) as string,
    },
    sources: {
      coingecko: y.sources.coingecko,
      debank: y.sources.debank,
      rpc: { base: { url: process.env['DM_RPC_BASE_URL'] ?? y.sources.rpc.base.url, timeoutMs: y.sources.rpc.base.timeout_ms, retryAttempts: y.sources.rpc.base.retry_attempts } },
    },
    notifications: {
      serverchan: { enabled: y.notifications.serverchan.enabled, sendkey: process.env['DM_SERVERCHAN_SENDKEY'] ?? '', timeoutMs: y.notifications.serverchan.timeout_ms, retryAttempts: y.notifications.serverchan.retry_attempts },
      email: { enabled: y.notifications.email.enabled, smtpHost: y.notifications.email.smtp_host, smtpPort: y.notifications.email.smtp_port, user: process.env['DM_EMAIL_USER'] ?? '', password: process.env['DM_EMAIL_PASSWORD'] ?? '', from: y.notifications.email.from, to: y.notifications.email.to as string[], retryAttempts: y.notifications.email.retry_attempts, dailySummaryHour: y.notifications.email.daily_summary_hour },
      healthchecks: { enabled: y.notifications.healthchecks.enabled, pingUrl: process.env['DM_HEALTHCHECKS_PING_URL'] ?? '', intervalSeconds: y.notifications.healthchecks.interval_seconds },
    },
    protocols: {
      aerodromeMusdUsdc: {
        enabled: ae.enabled,
        chain: ae.chain,
        chainId: ae.chain_id,
        poolAddress: ae.pool_address,
        gaugeAddress: ae.gauge_address,
        msUsdAddress: ae.msusd_address,
        usdcAddress: ae.usdc_address,
        routerAddress: ae.router_address,
        positionManagerAddress: ae.position_manager_address,
        lpTokenId: ae.lp_token_id,
        teamWallets: ae.team_wallets as string[],
        polling: { priceMs: ae.polling.price_ms, poolMs: ae.polling.pool_ms, supplyMs: ae.polling.supply_ms, positionMs: ae.polling.position_ms, protocolMs: ae.polling.protocol_ms, teamWalletsMs: ae.polling.team_wallets_ms },
        alerts: {
          depeg: { priceThreshold: ae.alerts.depeg.price_threshold, twapThreshold: ae.alerts.depeg.twap_threshold, poolImbalancePct: ae.alerts.depeg.pool_imbalance_pct, sustainedSeconds: ae.alerts.depeg.sustained_seconds, requiredConfirmations: ae.alerts.depeg.required_confirmations },
          hackMint: { supplyIncreasePct: ae.alerts.hack_mint.supply_increase_pct, supplyWindowSeconds: ae.alerts.hack_mint.supply_window_seconds, priceDropPct: ae.alerts.hack_mint.price_drop_pct, sellsSpikeMultiplier: ae.alerts.hack_mint.sells_spike_multiplier },
          liquidityDrain: { tvlDropPct: ae.alerts.liquidity_drain.tvl_drop_pct, tvlWindowSeconds: ae.alerts.liquidity_drain.tvl_window_seconds, poolMsUsdRatioPct: ae.alerts.liquidity_drain.pool_msusd_ratio_pct, sellsBuysRatio: ae.alerts.liquidity_drain.sells_buys_ratio },
          insiderExit: { largeOutflowUsd: ae.alerts.insider_exit.large_outflow_usd, priceDropPct: ae.alerts.insider_exit.price_drop_pct },
          positionDrop: { dropPct: ae.alerts.position_drop.drop_pct, windowSeconds: ae.alerts.position_drop.window_seconds },
        },
        execution: { swapBatchCount: ae.execution.swap_batch_count, swapSlippageBps: ae.execution.swap_slippage_bps, gasMultiplier: ae.execution.gas_multiplier, deadlineSeconds: ae.execution.deadline_seconds, maxGasGwei: ae.execution.max_gas_gwei },
      },
    },
    storage: { sqlitePath: y.storage.sqlite_path, retentionDays: { priceHistory: y.storage.retention_days.price_history, poolSnapshots: y.storage.retention_days.pool_snapshots, healthSnapshots: y.storage.retention_days.health_snapshots } },
    secrets,
  }
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Required environment variable ${key} is not set`)
  return value
}
```

- [ ] **Step 6: Run test — expect PASS**

```bash
npm test -- src/core/config.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add configs/monitor.yaml configs/.env.example src/core/config.ts src/core/config.test.ts
git commit -m "feat: add config module (YAML + .env loading)"
```

---

## Task 4: Logger

**Files:**
- Create: `src/core/logger.ts`

- [ ] **Step 1: Create src/core/logger.ts**

```typescript
// src/core/logger.ts
import pino from 'pino'
import { loadConfig } from './config.js'

// Logger is initialised once and exported as a singleton.
// In tests, import directly from 'pino' to avoid config loading.
let _logger: pino.Logger | null = null

export function initLogger(logLevel: string): pino.Logger {
  _logger = pino({
    level: logLevel,
    transport:
      process.env['NODE_ENV'] !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
        : undefined,
  })
  return _logger
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = pino({ level: 'info' })
  }
  return _logger
}

export default { init: initLogger, get: getLogger }
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/core/logger.ts
git commit -m "feat: add pino logger module"
```

---

## Task 5: Storage

**Files:**
- Create: `src/core/storage/index.ts`
- Create: `src/core/storage/queries.ts`
- Test: `src/core/storage/storage.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/core/storage/storage.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb, closeDb, runRetentionCleanup } from './index.js'
import {
  insertPriceHistory,
  insertPoolSnapshot,
  insertSupplyHistory,
  insertAlert,
  insertExecution,
  getRecentPrices,
  getRecentSupply,
} from './queries.js'
import { AlertLevel, AlertType, OrderStatus, OrderType } from '../types.js'
import type Database from 'better-sqlite3'

let db: Database.Database

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  closeDb(db)
})

describe('price_history', () => {
  it('inserts and retrieves price records', () => {
    insertPriceHistory(db, {
      protocol: 'aerodrome-msusd-usdc',
      token: 'msusd',
      price: 0.9985,
      source: 'coingecko',
      recordedAt: new Date(),
    })
    const rows = getRecentPrices(db, 'aerodrome-msusd-usdc', 'msusd', 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.price).toBeCloseTo(0.9985)
  })
})

describe('supply_history', () => {
  it('inserts and retrieves supply records', () => {
    insertSupplyHistory(db, {
      token: 'msusd',
      totalSupply: 1_000_000n * 10n ** 18n,
      chain: 'base',
      recordedAt: new Date(),
    })
    const rows = getRecentSupply(db, 'msusd', 5)
    expect(rows).toHaveLength(1)
    expect(BigInt(rows[0]?.totalSupply ?? '0')).toBe(1_000_000n * 10n ** 18n)
  })
})

describe('alerts', () => {
  it('inserts alert record', () => {
    insertAlert(db, {
      id: crypto.randomUUID(),
      type: AlertType.DEPEG,
      level: AlertLevel.RED,
      protocol: 'aerodrome-msusd-usdc',
      title: 'Test depeg',
      message: 'price fell',
      data: { price: 0.985 },
      triggeredAt: new Date(),
      confirmations: 3,
      requiredConfirmations: 3,
      sustainedMs: 200_000,
      requiredSustainedMs: 180_000,
    })
    // No error = pass
  })
})

describe('retention cleanup', () => {
  it('deletes price records older than retention days', () => {
    const old = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000) // 35 days ago
    insertPriceHistory(db, { protocol: 'test', token: 'msusd', price: 1.0, source: 'cg', recordedAt: old })
    insertPriceHistory(db, { protocol: 'test', token: 'msusd', price: 1.0, source: 'cg', recordedAt: new Date() })
    runRetentionCleanup(db, { priceHistory: 30, poolSnapshots: 30, healthSnapshots: 7 })
    expect(getRecentPrices(db, 'test', 'msusd', 10)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/storage/storage.test.ts
```

Expected: `Cannot find module './index.js'`

- [ ] **Step 3: Create src/core/storage/index.ts**

```typescript
// src/core/storage/index.ts
import Database from 'better-sqlite3'
import { mkdirSync, dirname } from 'node:fs'
import { join } from 'node:path'

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function closeDb(db: Database.Database): void {
  db.close()
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,
      token TEXT NOT NULL,
      price REAL NOT NULL,
      source TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_price_protocol_time ON price_history(protocol, recorded_at);

    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      protocol TEXT NOT NULL,
      pool_address TEXT NOT NULL,
      reserve0 TEXT NOT NULL,
      reserve1 TEXT NOT NULL,
      volume_24h REAL,
      buys_1h INTEGER,
      sells_1h INTEGER,
      msusd_ratio REAL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pool_protocol_time ON pool_snapshots(protocol, recorded_at);

    CREATE TABLE IF NOT EXISTS supply_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      total_supply TEXT NOT NULL,
      chain TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_supply_token_time ON supply_history(token, recorded_at);

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      level TEXT NOT NULL,
      protocol TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT NOT NULL,
      confirmations INTEGER NOT NULL,
      required_confirmations INTEGER NOT NULL,
      sustained_ms INTEGER NOT NULL,
      required_sustained_ms INTEGER NOT NULL,
      triggered_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_protocol_time ON alerts(protocol, triggered_at);

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id),
      protocol TEXT NOT NULL,
      order_type TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      params_json TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      gas_used TEXT,
      gas_price_gwei REAL,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      executed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exec_alert ON executions(alert_id);

    CREATE TABLE IF NOT EXISTS health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id TEXT NOT NULL,
      healthy INTEGER NOT NULL,
      sources_json TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_health_monitor_time ON health_snapshots(monitor_id, checked_at);
  `)
}

export function runRetentionCleanup(
  db: Database.Database,
  days: { priceHistory: number; poolSnapshots: number; healthSnapshots: number },
): void {
  db.prepare(`DELETE FROM price_history WHERE created_at < datetime('now', '-${days.priceHistory} days')`).run()
  db.prepare(`DELETE FROM pool_snapshots WHERE created_at < datetime('now', '-${days.poolSnapshots} days')`).run()
  db.prepare(`DELETE FROM health_snapshots WHERE created_at < datetime('now', '-${days.healthSnapshots} days')`).run()
}
```

- [ ] **Step 4: Create src/core/storage/queries.ts**

```typescript
// src/core/storage/queries.ts
import type Database from 'better-sqlite3'
import type { Alert, ExecutionOrder, ExecutionResult, MonitorHealth } from '../types.js'

// ── Price ──────────────────────────────────────────────────────────────────────

export interface PriceRecord {
  protocol: string; token: string; price: number; source: string; recordedAt: Date
}

export function insertPriceHistory(db: Database.Database, r: PriceRecord): void {
  db.prepare(`INSERT INTO price_history (protocol, token, price, source, recorded_at) VALUES (?, ?, ?, ?, ?)`)
    .run(r.protocol, r.token, r.price, r.source, r.recordedAt.toISOString())
}

export function getRecentPrices(
  db: Database.Database, protocol: string, token: string, limit: number,
): Array<{ price: number; source: string; recordedAt: string }> {
  return db.prepare(`SELECT price, source, recorded_at as recordedAt FROM price_history WHERE protocol = ? AND token = ? ORDER BY recorded_at DESC LIMIT ?`)
    .all(protocol, token, limit) as Array<{ price: number; source: string; recordedAt: string }>
}

// ── Pool ───────────────────────────────────────────────────────────────────────

export interface PoolSnapshotRecord {
  protocol: string; poolAddress: string; reserve0: bigint; reserve1: bigint
  volume24h: number | null; buys1h: number | null; sells1h: number | null
  msUsdRatio: number | null; recordedAt: Date
}

export function insertPoolSnapshot(db: Database.Database, r: PoolSnapshotRecord): void {
  db.prepare(`INSERT INTO pool_snapshots (protocol, pool_address, reserve0, reserve1, volume_24h, buys_1h, sells_1h, msusd_ratio, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.protocol, r.poolAddress, r.reserve0.toString(), r.reserve1.toString(), r.volume24h, r.buys1h, r.sells1h, r.msUsdRatio, r.recordedAt.toISOString())
}

// ── Supply ─────────────────────────────────────────────────────────────────────

export interface SupplyRecord { token: string; totalSupply: bigint; chain: string; recordedAt: Date }

export function insertSupplyHistory(db: Database.Database, r: SupplyRecord): void {
  db.prepare(`INSERT INTO supply_history (token, total_supply, chain, recorded_at) VALUES (?, ?, ?, ?)`)
    .run(r.token, r.totalSupply.toString(), r.chain, r.recordedAt.toISOString())
}

export function getRecentSupply(
  db: Database.Database, token: string, limit: number,
): Array<{ totalSupply: string; recordedAt: string }> {
  return db.prepare(`SELECT total_supply as totalSupply, recorded_at as recordedAt FROM supply_history WHERE token = ? ORDER BY recorded_at DESC LIMIT ?`)
    .all(token, limit) as Array<{ totalSupply: string; recordedAt: string }>
}

// ── Alert ──────────────────────────────────────────────────────────────────────

export function insertAlert(db: Database.Database, a: Alert): void {
  db.prepare(`INSERT INTO alerts (id, type, level, protocol, title, message, data_json, confirmations, required_confirmations, sustained_ms, required_sustained_ms, triggered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(a.id, a.type, a.level, a.protocol, a.title, a.message, JSON.stringify(a.data), a.confirmations, a.requiredConfirmations, a.sustainedMs, a.requiredSustainedMs, a.triggeredAt.toISOString())
}

// ── Execution ──────────────────────────────────────────────────────────────────

export function insertExecution(db: Database.Database, order: ExecutionOrder, result: ExecutionResult): void {
  db.prepare(`INSERT INTO executions (id, alert_id, protocol, order_type, sequence, group_id, params_json, status, tx_hash, gas_used, gas_price_gwei, error_message, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(order.id, order.alertId, order.protocol, order.type, order.sequence, order.groupId, JSON.stringify(order.params), result.status, result.txHash ?? null, result.gasUsed?.toString() ?? null, result.gasPriceGwei ?? null, result.error ?? null, result.executedAt.toISOString())
}

// ── Health ─────────────────────────────────────────────────────────────────────

export function insertHealthSnapshot(db: Database.Database, monitorId: string, health: MonitorHealth): void {
  db.prepare(`INSERT INTO health_snapshots (monitor_id, healthy, sources_json, checked_at) VALUES (?, ?, ?, ?)`)
    .run(monitorId, health.healthy ? 1 : 0, JSON.stringify(health.sources), health.checkedAt.toISOString())
}
```

- [ ] **Step 5: Run test — expect PASS**

```bash
npm test -- src/core/storage/storage.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 6: Full typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/storage/
git commit -m "feat: add SQLite storage layer with schema and typed queries"
```
