# DeBank Position Enrichment — Design Spec

**日期：** 2026-04-28  
**状态：** 已批准，待实施

---

## 背景

当前 `PositionMonitor` 通过 DeBank Pro API 获取 LP 仓位价值，存在三个不足：

1. **过滤方式不稳定**：按 `position_index`（LP Token ID）过滤，但 DeBank 文档更推荐用 `pool.id`（Gauge 合约地址），后者是链上稳定地址。
2. **奖励可见性缺失**：`PositionSignal.netUsdValue` 已包含 AERO 奖励（来自 `stats.net_usd_value`），但无拆分字段，运维时无法判断仓位缩水是真实损失还是领取奖励所致。
3. **depeg 多源确认不足**：depeg 告警有 4 个 source（CoinGecko、TWAP、pool 失衡比、poolPrice），required_confirmations=3。DeBank 响应里已有 msUSD 价格，可作为第 5 个独立源，门槛提升至 5 中取 4，减少误报。

---

## 设计目标

- 用 `pool.id`（Gauge 地址）替换 `position_index` 作为过滤键
- 在 `PositionSignal` 中暴露 `rewardUsdValue`（AERO 奖励 USD 价值）
- 在 `PositionSignal` 中暴露 `debankMsUsdPrice`（DeBank 返回的 msUSD 价格）
- 将 `debankMsUsdPrice` 接入 `evaluateDepeg`，required_confirmations 从 3 → 4

**不在本次范围内：** 其他告警的多源逻辑、reward 的独立 claim 检测、AERO 价格独立监控。

---

## 架构与数据流

```
DeBank API response
  └─ portfolio_item_list
       └─ 按 pool.id 过滤（大小写不敏感）
            ├─ stats.net_usd_value          → UserProtocolPosition.netUsdValue
            ├─ detail.reward_token_list     → UserProtocolPosition.rewardUsdValue
            └─ detail.supply_token_list     → UserProtocolPosition.supplyTokenPrices

UserProtocolPosition
  └─ PositionMonitor.check()
       ├─ netUsdValue           → PositionSignal.netUsdValue
       ├─ rewardUsdValue        → PositionSignal.rewardUsdValue        (NEW)
       └─ supplyTokenPrices[msUsdAddress]
                                → PositionSignal.debankMsUsdPrice      (NEW)

PositionSignal
  └─ evaluateDepeg()
       └─ debankMsUsdPrice < priceThreshold → confirmations.add('debank')  (NEW)
```

---

## 详细设计

### 1. `DeBankClient.getUserProtocolPosition`

**签名变更：**
```typescript
getUserProtocolPosition(
  walletAddress: string,
  protocolId: string,
  poolId?: string,   // 取代 positionIndex；按 pool.id 过滤（大小写不敏感）
): Promise<UserProtocolPosition>
```

**`UserProtocolPosition` 接口：**
```typescript
export interface UserProtocolPosition {
  netUsdValue: number
  assetUsdValue: number
  debtUsdValue: number
  rewardUsdValue: number                    // NEW: sum(reward_token.amount × price)
  supplyTokenPrices: Record<string, number> // NEW: address(小写) → price
  fetchedAt: Date
}
```

**解析逻辑：**
- 过滤：`item.pool?.id?.toLowerCase() === poolId?.toLowerCase()`（未传 poolId 则不过滤）
- rewardUsdValue：`detail.reward_token_list?.reduce((s, t) => s + t.amount * t.price, 0) ?? 0`
- supplyTokenPrices：`Object.fromEntries(detail.supply_token_list?.map(t => [t.id.toLowerCase(), t.price]) ?? [])`

`DeBankClient` 不关心哪个地址是 msUSD，保持协议无关性，由上层查询。

**缓存键：** `position:${walletAddress}:${protocolId}:${poolId ?? ''}`（pool.id 纳入键，避免不同过滤条件命中同一缓存）

---

### 2. `PositionMonitorConfig`（内部接口）

```typescript
interface PositionMonitorConfig {
  walletAddress: string
  protocolId: string
  poolId: string        // 取代 positionIndex，传入 cfg.gaugeAddress
  msUsdAddress: string  // NEW: 用于从 supplyTokenPrices 中查 msUSD 价格
}
```

---

### 3. `PositionSignal`（`src/protocols/aerodrome/types.ts`）

```typescript
export interface PositionSignal {
  netUsdValue: number
  rewardUsdValue: number           // NEW: AERO 奖励 USD 价值（透明拆分）
  previousNetUsdValue: number | null
  debankMsUsdPrice: number | null  // NEW: DeBank 返回的 msUSD 价格，null = 数据不可用
  fetchedAt: Date
}
```

---

### 4. `PositionMonitor.check()`

```typescript
const pos = await this.debank.getUserProtocolPosition(
  this.cfg.walletAddress, this.cfg.protocolId, this.cfg.poolId,
)
const debankMsUsdPrice =
  pos.supplyTokenPrices[this.cfg.msUsdAddress.toLowerCase()] ?? null

return {
  netUsdValue: pos.netUsdValue,
  rewardUsdValue: pos.rewardUsdValue,
  previousNetUsdValue: this.previousValue,
  debankMsUsdPrice,
  fetchedAt: new Date(),
}
```

---

### 5. `evaluateDepeg`（`src/protocols/aerodrome/alerts.ts`）

在现有四条 source 之后加入第五条：

```typescript
function evaluateDepeg(state, signals, cfg, protocol, now) {
  const { price, pool, position } = signals  // 解构加入 position

  // ... 现有四条 source 不变 ...

  // NEW: DeBank msUSD 价格
  if (position?.debankMsUsdPrice !== null && position?.debankMsUsdPrice !== undefined) {
    data.debankPrice = position.debankMsUsdPrice
    if (position.debankMsUsdPrice < t.priceThreshold) confirmations.add('debank')
  }
  // ...
}
```

---

### 6. `AerodromeMonitor` 构造 + 日志

**构造变更（`index.ts`）：**
```typescript
new PositionMonitor({
  walletAddress,
  protocolId: cfg.debankProtocolId,
  poolId: cfg.gaugeAddress,        // 取代 lpTokenId.toString()
  msUsdAddress: cfg.msUsdAddress,
}, deBank, logger)
```

**`logger.info` 补充字段：**
```typescript
debankMsUsdPrice: signals.position?.debankMsUsdPrice ?? null,
rewardUsd:        signals.position?.rewardUsdValue   ?? null,
```

---

### 7. `configs/monitor.yaml`

```yaml
depeg:
  required_confirmations: 4   # 原 3，现 5 中取 4
```

---

## 变更文件清单

| 文件 | 变更摘要 |
|------|---------|
| `src/core/clients/debank.ts` | 签名加 `poolId`；`pool.id` 过滤；解析 `rewardUsdValue` + `supplyTokenPrices` |
| `src/protocols/aerodrome/types.ts` | `PositionSignal` 加 `rewardUsdValue`、`debankMsUsdPrice` |
| `src/protocols/aerodrome/monitors/position.ts` | config 换 `poolId`+`msUsdAddress`，填充新字段 |
| `src/protocols/aerodrome/alerts.ts` | `evaluateDepeg` 加 `debank` source，解构加 `position` |
| `src/protocols/aerodrome/index.ts` | 构造 `PositionMonitor` 传新字段；日志补充 |
| `configs/monitor.yaml` | `required_confirmations: 4` |

---

## 测试要点

- `DeBankClient`：验证 `pool.id` 过滤正确（大小写）、`rewardUsdValue` 正确累加、`supplyTokenPrices` 正确构建
- `PositionMonitor`：验证 `debankMsUsdPrice` 正确从 map 查询，`rewardUsdValue` 正确透传
- `evaluateDepeg`：验证 `debank` source 在价格低于阈值时计入，`required_confirmations=4` 生效
