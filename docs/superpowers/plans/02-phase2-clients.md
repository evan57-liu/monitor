# Phase 2: Data Source Clients

Tasks 6–9. After this phase: circuit breaker, retry, CoinGecko client, DeBank client, and Base RPC client are all unit-tested and typecheck-clean.

---

## Task 6: Circuit Breaker + Retry

**Files:**
- Create: `src/core/circuit-breaker.ts`
- Create: `src/core/retry.ts`
- Test: `src/core/circuit-breaker.test.ts`
- Test: `src/core/retry.test.ts`

### Circuit Breaker

- [ ] **Step 1: Write failing test**

```typescript
// src/core/circuit-breaker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js'

describe('CircuitBreaker', () => {
  it('passes through successful calls', async () => {
    const cb = new CircuitBreaker({ maxFailures: 3, resetTimeMs: 60_000, name: 'test' })
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await cb.call(fn)).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('propagates errors when closed', async () => {
    const cb = new CircuitBreaker({ maxFailures: 3, resetTimeMs: 60_000, name: 'test' })
    const fn = vi.fn().mockRejectedValue(new Error('api fail'))
    await expect(cb.call(fn)).rejects.toThrow('api fail')
  })

  it('opens after maxFailures consecutive failures', async () => {
    const cb = new CircuitBreaker({ maxFailures: 3, resetTimeMs: 60_000, name: 'test' })
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    for (let i = 0; i < 3; i++) {
      await expect(cb.call(fn)).rejects.toThrow('fail')
    }
    // Now open — fn is NOT called again
    await expect(cb.call(fn)).rejects.toThrow(CircuitOpenError)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('resets to half-open after resetTime and succeeds', async () => {
    const cb = new CircuitBreaker({ maxFailures: 2, resetTimeMs: 50, name: 'test' })
    const failFn = vi.fn().mockRejectedValue(new Error('fail'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.call(failFn)).rejects.toThrow('fail')
    }
    await new Promise(r => setTimeout(r, 60))
    const okFn = vi.fn().mockResolvedValue('recovered')
    expect(await cb.call(okFn)).toBe('recovered')
    // Back to closed — next call goes through again
    await expect(cb.call(okFn)).resolves.toBe('recovered')
  })

  it('goes back to open if half-open probe fails', async () => {
    const cb = new CircuitBreaker({ maxFailures: 2, resetTimeMs: 50, name: 'test' })
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    for (let i = 0; i < 2; i++) {
      await expect(cb.call(fn)).rejects.toThrow('fail')
    }
    await new Promise(r => setTimeout(r, 60))
    await expect(cb.call(fn)).rejects.toThrow('fail') // half-open probe fails
    // Back to open
    await expect(cb.call(fn)).rejects.toThrow(CircuitOpenError)
  })

  it('exposes isOpen getter', async () => {
    const cb = new CircuitBreaker({ maxFailures: 1, resetTimeMs: 60_000, name: 'test' })
    expect(cb.isOpen).toBe(false)
    await expect(cb.call(() => Promise.reject(new Error('x')))).rejects.toThrow()
    expect(cb.isOpen).toBe(true)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/circuit-breaker.test.ts
```

Expected: `Cannot find module './circuit-breaker.js'`

- [ ] **Step 3: Create src/core/circuit-breaker.ts**

```typescript
// src/core/circuit-breaker.ts

export interface CircuitBreakerConfig {
  maxFailures: number
  resetTimeMs: number
  name: string
}

type State = 'closed' | 'open' | 'half-open'

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit ${name} is open`)
    this.name = 'CircuitOpenError'
  }
}

export class CircuitBreaker {
  private failures = 0
  private lastFailureAt = 0
  private state: State = 'closed'

  constructor(private readonly cfg: CircuitBreakerConfig) {}

  get isOpen(): boolean {
    return this.state === 'open'
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.cfg.resetTimeMs) {
        this.state = 'half-open'
      } else {
        throw new CircuitOpenError(this.cfg.name)
      }
    }

    try {
      const result = await fn()
      if (this.state === 'half-open') this.reset()
      return result
    } catch (err) {
      this.onFailure()
      throw err
    }
  }

  private onFailure(): void {
    this.failures++
    this.lastFailureAt = Date.now()
    if (this.state === 'half-open' || this.failures >= this.cfg.maxFailures) {
      this.state = 'open'
    }
  }

  private reset(): void {
    this.failures = 0
    this.lastFailureAt = 0
    this.state = 'closed'
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/core/circuit-breaker.test.ts
```

Expected: 6 tests pass.

### Retry

- [ ] **Step 5: Write failing retry test**

```typescript
// src/core/retry.test.ts
import { describe, it, expect, vi } from 'vitest'
import { withRetry } from './retry.js'

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 })).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('retries and succeeds on 3rd attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('ok')
    expect(await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws after all attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fail'))
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 })
    ).rejects.toThrow('always fail')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 6: Create src/core/retry.ts**

```typescript
// src/core/retry.ts

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < opts.maxAttempts) {
        const base = opts.baseDelayMs * 2 ** (attempt - 1)
        const delay = Math.min(base, opts.maxDelayMs)
        const jitter = delay * 0.1 * Math.random()
        await sleep(delay + jitter)
      }
    }
  }
  throw lastErr
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
```

- [ ] **Step 7: Run retry test — expect PASS**

```bash
npm test -- src/core/retry.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/core/circuit-breaker.ts src/core/circuit-breaker.test.ts src/core/retry.ts src/core/retry.test.ts
git commit -m "feat: add circuit breaker and retry utilities"
```

---

## Task 7: CoinGecko Client

**Files:**
- Create: `src/core/clients/coingecko.ts`
- Test: `src/core/clients/coingecko.test.ts`

CoinGecko Pro endpoints used:
- `/onchain/networks/base/tokens/{address}` → msUSD price
- `/onchain/networks/base/pools/{address}` → pool data (reserves, buys, sells)
- Simple price endpoint as backup

- [ ] **Step 1: Write failing test**

```typescript
// src/core/clients/coingecko.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoinGeckoClient } from './coingecko.js'

const BASE_URL = 'https://pro-api.coingecko.com/api/v3'
const API_KEY = 'test-key'

// Mock global fetch
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function makeTokenResponse(price: number) {
  return {
    data: {
      attributes: {
        price_usd: price.toString(),
        price_change_percentage: { h24: '-0.5' },
      },
    },
  }
}

function makePoolResponse(opts: { reserve0: string; reserve1: string; buys1h: number; sells1h: number }) {
  return {
    data: {
      attributes: {
        reserve_in_usd: '2500000',
        base_token_price_usd: '1.001',
        volume_usd: { h24: '180000' },
        transactions: {
          h1: { buys: opts.buys1h, sells: opts.sells1h },
          h24: { buys: opts.buys1h * 8, sells: opts.sells1h * 8 },
        },
        reserve0: opts.reserve0,
        reserve1: opts.reserve1,
      },
    },
  }
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('CoinGeckoClient', () => {
  it('fetches token price', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makeTokenResponse(0.9985),
    })
    const client = new CoinGeckoClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5000, retryAttempts: 1 })
    const result = await client.getTokenPrice('0xabc123')
    expect(result.priceUsd).toBeCloseTo(0.9985)
    expect(fetchMock).toHaveBeenCalledOnce()
    const url = fetchMock.mock.calls[0]?.[0] as string
    expect(url).toContain('/onchain/networks/base/tokens/0xabc123')
  })

  it('returns cached result within TTL', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeTokenResponse(1.0) })
    const client = new CoinGeckoClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5000, retryAttempts: 1 })
    await client.getTokenPrice('0xabc123')
    await client.getTokenPrice('0xabc123') // should use cache
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('fetches pool data', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => makePoolResponse({ reserve0: '1250000000000000000000000', reserve1: '1250000000', buys1h: 40, sells1h: 10 }),
    })
    const client = new CoinGeckoClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5000, retryAttempts: 1 })
    const pool = await client.getPoolData('0xpool123')
    expect(pool.buys1h).toBe(40)
    expect(pool.sells1h).toBe(10)
  })

  it('throws on non-200 response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
    const client = new CoinGeckoClient({ baseUrl: BASE_URL, apiKey: API_KEY, timeoutMs: 5000, retryAttempts: 1 })
    await expect(client.getTokenPrice('0xabc')).rejects.toThrow('CoinGecko API error: 429')
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/clients/coingecko.test.ts
```

- [ ] **Step 3: Create src/core/clients/coingecko.ts**

```typescript
// src/core/clients/coingecko.ts
import { withRetry } from '../retry.js'

export interface CoinGeckoConfig {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  retryAttempts: number
}

export interface TokenPrice {
  priceUsd: number
  priceChange24hPct: number
  fetchedAt: Date
}

export interface PoolData {
  reserveInUsd: number
  baseTokenPriceUsd: number
  volume24h: number
  buys1h: number
  sells1h: number
  buys24h: number
  sells24h: number
  reserve0Raw: string
  reserve1Raw: string
  fetchedAt: Date
}

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

export class CoinGeckoClient {
  private cache = new Map<string, CacheEntry<unknown>>()
  private readonly ttlMs = 8_000 // 8s — safe for 10s polling interval

  constructor(private readonly cfg: CoinGeckoConfig) {}

  async getTokenPrice(tokenAddress: string): Promise<TokenPrice> {
    return this.cached(`token:${tokenAddress}`, async () => {
      const url = `${this.cfg.baseUrl}/onchain/networks/base/tokens/${tokenAddress}`
      const raw = await this.fetch(url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attrs = (raw as any).data.attributes
      return {
        priceUsd: parseFloat(attrs.price_usd as string),
        priceChange24hPct: parseFloat(attrs.price_change_percentage.h24 as string),
        fetchedAt: new Date(),
      }
    })
  }

  async getPoolData(poolAddress: string): Promise<PoolData> {
    return this.cached(`pool:${poolAddress}`, async () => {
      const url = `${this.cfg.baseUrl}/onchain/networks/base/pools/${poolAddress}`
      const raw = await this.fetch(url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attrs = (raw as any).data.attributes
      return {
        reserveInUsd: parseFloat(attrs.reserve_in_usd as string),
        baseTokenPriceUsd: parseFloat(attrs.base_token_price_usd as string),
        volume24h: parseFloat(attrs.volume_usd.h24 as string),
        buys1h: attrs.transactions.h1.buys as number,
        sells1h: attrs.transactions.h1.sells as number,
        buys24h: attrs.transactions.h24.buys as number,
        sells24h: attrs.transactions.h24.sells as number,
        reserve0Raw: attrs.reserve0 as string,
        reserve1Raw: attrs.reserve1 as string,
        fetchedAt: new Date(),
      }
    })
  }

  private async fetch(url: string): Promise<unknown> {
    return withRetry(
      async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
        try {
          const res = await globalThis.fetch(url, {
            headers: { 'x-cg-pro-api-key': this.cfg.apiKey },
            signal: controller.signal,
          })
          if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`)
          return res.json()
        } finally {
          clearTimeout(timeout)
        }
      },
      { maxAttempts: this.cfg.retryAttempts, baseDelayMs: 500, maxDelayMs: 5_000 },
    )
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.data as T
    const data = await fn()
    this.cache.set(key, { data, expiresAt: Date.now() + this.ttlMs })
    return data
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/core/clients/coingecko.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/clients/coingecko.ts src/core/clients/coingecko.test.ts
git commit -m "feat: add CoinGecko Pro client with TTL cache"
```

---

## Task 8: DeBank Client

**Files:**
- Create: `src/core/clients/debank.ts`
- Test: `src/core/clients/debank.test.ts`

DeBank Pro endpoints used:
- `/v1/user/protocol` → user's protocol position (Aerodrome LP value)
- `/v1/protocol` → protocol TVL (Metronome)
- `/v1/user/token_list` → wallet token holdings (team wallet monitoring)

- [ ] **Step 1: Write failing test**

```typescript
// src/core/clients/debank.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DeBankClient } from './debank.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => fetchMock.mockReset())

function okJson(data: unknown) {
  return { ok: true, json: async () => data }
}

describe('DeBankClient', () => {
  const client = new DeBankClient({
    baseUrl: 'https://pro-openapi.debank.com/v1',
    accessKey: 'test-key',
    timeoutMs: 5000,
    retryAttempts: 1,
  })

  it('fetches user position for a protocol', async () => {
    fetchMock.mockResolvedValueOnce(okJson({
      portfolio_item_list: [
        { stats: { net_usd_value: 18650.5, asset_usd_value: 18650.5, debt_usd_value: 0 } },
      ],
    }))
    const pos = await client.getUserProtocolPosition('0xwallet', 'aerodrome')
    expect(pos.netUsdValue).toBeCloseTo(18650.5)
  })

  it('returns zero value when no position found', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ portfolio_item_list: [] }))
    const pos = await client.getUserProtocolPosition('0xwallet', 'aerodrome')
    expect(pos.netUsdValue).toBe(0)
  })

  it('fetches protocol TVL', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ tvl: 55_000_000, user_count: 1200 }))
    const tvl = await client.getProtocolTvl('metronome-synth')
    expect(tvl.tvlUsd).toBe(55_000_000)
  })

  it('fetches wallet token list', async () => {
    fetchMock.mockResolvedValueOnce(okJson([
      { id: 'msusd', symbol: 'msUSD', amount: 50000, price: 0.999, chain: 'base' },
    ]))
    const tokens = await client.getWalletTokens('0xteam', 'base')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.symbol).toBe('msUSD')
    expect(tokens[0]?.usdValue).toBeCloseTo(49950)
  })

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
    await expect(client.getProtocolTvl('x')).rejects.toThrow('DeBank API error: 401')
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
npm test -- src/core/clients/debank.test.ts
```

- [ ] **Step 3: Create src/core/clients/debank.ts**

```typescript
// src/core/clients/debank.ts
import { withRetry } from '../retry.js'

export interface DeBankConfig {
  baseUrl: string
  accessKey: string
  timeoutMs: number
  retryAttempts: number
}

export interface UserProtocolPosition {
  netUsdValue: number
  assetUsdValue: number
  debtUsdValue: number
  fetchedAt: Date
}

export interface ProtocolTvl {
  tvlUsd: number
  userCount: number
  fetchedAt: Date
}

export interface WalletToken {
  id: string
  symbol: string
  amount: number
  priceUsd: number
  usdValue: number
  chain: string
}

interface CacheEntry<T> { data: T; expiresAt: number }

export class DeBankClient {
  private cache = new Map<string, CacheEntry<unknown>>()
  private readonly ttlMs = 50_000 // ~50s for 60s polling

  constructor(private readonly cfg: DeBankConfig) {}

  async getUserProtocolPosition(walletAddress: string, protocolId: string): Promise<UserProtocolPosition> {
    return this.cached(`position:${walletAddress}:${protocolId}`, async () => {
      const url = `${this.cfg.baseUrl}/user/protocol?id=${protocolId}&user_addr=${walletAddress}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await this.fetch(url) as any
      const items = raw.portfolio_item_list as Array<{ stats: { net_usd_value: number; asset_usd_value: number; debt_usd_value: number } }>
      const total = items.reduce((acc, item) => ({
        netUsdValue: acc.netUsdValue + (item.stats.net_usd_value ?? 0),
        assetUsdValue: acc.assetUsdValue + (item.stats.asset_usd_value ?? 0),
        debtUsdValue: acc.debtUsdValue + (item.stats.debt_usd_value ?? 0),
      }), { netUsdValue: 0, assetUsdValue: 0, debtUsdValue: 0 })
      return { ...total, fetchedAt: new Date() }
    })
  }

  async getProtocolTvl(protocolId: string): Promise<ProtocolTvl> {
    return this.cached(`protocol:${protocolId}`, async () => {
      const url = `${this.cfg.baseUrl}/protocol?id=${protocolId}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await this.fetch(url) as any
      return {
        tvlUsd: raw.tvl as number,
        userCount: raw.user_count as number,
        fetchedAt: new Date(),
      }
    })
  }

  async getWalletTokens(walletAddress: string, chain: string): Promise<WalletToken[]> {
    return this.cached(`tokens:${walletAddress}:${chain}`, async () => {
      const url = `${this.cfg.baseUrl}/user/token_list?user_addr=${walletAddress}&chain_id=${chain}&is_all=false`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await this.fetch(url) as any[]
      return raw.map(t => ({
        id: t.id as string,
        symbol: t.symbol as string,
        amount: t.amount as number,
        priceUsd: t.price as number,
        usdValue: (t.amount as number) * (t.price as number),
        chain: t.chain as string,
      }))
    })
  }

  private async fetch(url: string): Promise<unknown> {
    return withRetry(
      async () => {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs)
        try {
          const res = await globalThis.fetch(url, {
            headers: { AccessKey: this.cfg.accessKey },
            signal: controller.signal,
          })
          if (!res.ok) throw new Error(`DeBank API error: ${res.status}`)
          return res.json()
        } finally {
          clearTimeout(timeout)
        }
      },
      { maxAttempts: this.cfg.retryAttempts, baseDelayMs: 500, maxDelayMs: 5_000 },
    )
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.data as T
    const data = await fn()
    this.cache.set(key, { data, expiresAt: Date.now() + this.ttlMs })
    return data
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
npm test -- src/core/clients/debank.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/clients/debank.ts src/core/clients/debank.test.ts
git commit -m "feat: add DeBank Pro client with TTL cache"
```

---

## Task 9: RPC Client (viem)

**Files:**
- Create: `src/core/clients/rpc.ts`

No unit tests for the RPC client — it wraps viem which is already tested. Typecheck is the verification.

- [ ] **Step 1: Create src/core/clients/rpc.ts**

```typescript
// src/core/clients/rpc.ts
import { createPublicClient, http, parseAbi } from 'viem'
import { base } from 'viem/chains'

export interface RpcConfig {
  url: string
  timeoutMs: number
}

// ERC-20 ABI subset — totalSupply + balanceOf
const ERC20_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

// Aerodrome CL pool ABI subset — for TWAP
const CL_POOL_ABI = parseAbi([
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
])

export class RpcClient {
  readonly client: ReturnType<typeof createPublicClient>

  constructor(cfg: RpcConfig) {
    this.client = createPublicClient({
      chain: base,
      transport: http(cfg.url, { timeout: cfg.timeoutMs }),
    })
  }

  async getTotalSupply(tokenAddress: `0x${string}`): Promise<bigint> {
    return this.client.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'totalSupply',
    })
  }

  /**
   * Returns the 5-minute TWAP price of token0 in terms of token1.
   * Uses tick arithmetic: price = 1.0001^(avgTick).
   * Returns price as a plain number (e.g., 0.9985 for msUSD).
   */
  async getTwapPrice(poolAddress: `0x${string}`, twapWindowSeconds = 300): Promise<number> {
    const secondsAgos = [twapWindowSeconds, 0] as const
    const [tickCumulatives] = await this.client.readContract({
      address: poolAddress,
      abi: CL_POOL_ABI,
      functionName: 'observe',
      args: [Array.from(secondsAgos) as [number, number]],
    })
    const tick0 = tickCumulatives[0]
    const tick1 = tickCumulatives[1]
    if (tick0 === undefined || tick1 === undefined) throw new Error('observe returned empty')
    const avgTick = Number(tick1 - tick0) / twapWindowSeconds
    return Math.pow(1.0001, avgTick)
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/clients/rpc.ts
git commit -m "feat: add viem RPC client for Base (totalSupply + TWAP)"
```

---

## Phase 2 Checkpoint

```bash
npm run typecheck && npm test
```

Expected: 0 type errors, all tests (storage + circuit-breaker + retry + coingecko + debank) green.
