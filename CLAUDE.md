# CLAUDE.md — DeFi 监控机器人

## 项目概述

7x24 小时 DeFi 监控机器人。监视 Aerodrome（Base 链）上的 msUSD/USDC LP 仓位。
检测到危险信号时自动撤出。
作为 launchd 守护进程运行在 Mac mini 上。

## 运行项目

```bash
npm run dev          # 开发模式（通过 configs/monitor.yaml 默认启用 DRY_RUN）
npm run typecheck    # 仅类型检查
npm test             # 运行全部单元测试
npm run build        # 编译到 dist/
```

## 配置

- `configs/monitor.yaml` — 所有非敏感配置（阈值、地址、时间间隔）
- `configs/.env` — 密钥（已加入 .gitignore，模板见 `.env.example`）
- 测试时设置 `global.dry_run: true` — 不会执行任何链上交易

## 架构

```
src/core/        ← 与协议无关的基础设施
  types.ts       ← 所有共享接口（从这里开始阅读）
  engine.ts      ← 主循环：轮询监控器，分发告警/订单
  clients/       ← CoinGecko、DeBank、viem RPC
  storage/       ← SQLite（价格历史、告警、执行记录）
  executor/      ← 链上执行（实盘 + DRY_RUN）
  notify/        ← ServerChan、Email、Healthchecks、Notifier

src/protocols/aerodrome/
  index.ts       ← 实现 Monitor 接口（入口）
  alerts.ts      ← 5 条告警规则及状态机 ← 最核心的逻辑
  orders.ts      ← 3 步撤出订单生成
  monitors/      ← 各数据抓取器（price、pool、supply、position、protocol、wallets）
```

## 添加新协议

1. 按照 `aerodrome/` 的结构创建 `src/protocols/<name>/`
2. 在 `index.ts` 中实现 `Monitor` 接口
3. 在 `src/main.ts` 中注册：`engine.register(new MyProtocolMonitor(...))`
4. 在 `configs/monitor.yaml` 中添加对应配置段

## 告警系统

5 种告警类型，RED 级通过两道闸才生成撤出订单：

- `depeg` — 价格低于 $0.986797，4 选 3 多源确认，持续 3 分钟
- `hack_mint` — totalSupply 在过去 1 小时（`supply_window_seconds`）内增加 > 15%，价格跌至 $0.98 以下，卖出激增
- `liquidity_drain` — Metronome TVL 在过去 1 小时（`tvl_window_seconds`）内下降 > 30%，池子失衡
- `insider_exit` — 团队钱包大额流出 + 价格下跌
- `position_drop` — LP 仓位在过去 1 小时（`window_seconds`）内价值下跌 > 配置阈值（最后防线，独立触发）

**两道闸（撤出必须同时通过）**：

1. **复合确认**：`depeg RED` 必须与 `hack_mint / liquidity_drain / insider_exit` 任一 RED 同时存在才能触发撤出；`position_drop RED` 可独立触发。
2. **价格地板**：`max(coingecko, twap, debank) ≥ $0.92`；三源全不可用时拒绝撤出（fail-closed），写 `WITHDRAWAL_ABORTED` 告警通知运维人工处理。

撤出序列：unstake → remove_liquidity → `[price_floor_guard + swap] × 3 批`。每批 swap 前门控订单重新检查链上 TWAP + DeBank 价格，破地板则中止剩余批次。

详见 `src/protocols/aerodrome/alerts.ts`（状态机）和 `src/protocols/aerodrome/index.ts`（两道闸入口）。

## DRY_RUN 模式

在 monitor.yaml 中设置 `global.dry_run: true`：
- 所有监控和告警逻辑与实盘完全一致
- `DryRunExecutor` 记录本应执行的操作，但不发送任何交易
- 切换到实盘前请至少运行 48 小时

## 运维

```bash
# 启动守护进程
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# 停止守护进程
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist

# 查看日志
tail -f logs/stdout.log

# 查询最近告警
sqlite3 data/monitor.db "SELECT triggered_at, type, level, title FROM alerts ORDER BY triggered_at DESC LIMIT 10;"

# 查看供应量历史（验证 hack_mint 窗口基准）
sqlite3 data/monitor.db "SELECT recorded_at, total_supply FROM supply_history ORDER BY recorded_at DESC LIMIT 10;"

# 查看 TVL 历史（验证 liquidity_drain 窗口基准）
sqlite3 data/monitor.db "SELECT recorded_at, tvl_usd FROM protocol_tvl_history WHERE protocol='aerodrome-msusd-usdc' ORDER BY recorded_at DESC LIMIT 10;"

# 查看仓位历史（验证 position_drop 窗口基准）
sqlite3 data/monitor.db "SELECT recorded_at, net_usd_value FROM position_history ORDER BY recorded_at DESC LIMIT 10;"
```

## 文档维护规则

每次完成以下任意一类改动后，**必须同步更新 `README.md`**：

- 新增或修改配置项（`configs/monitor.yaml`、`configs/.env` 变量、新增配置读取逻辑）
- 新增或移除功能（新协议、新告警类型、新通知渠道等）
- 运维操作步骤有变化（启动方式、日志路径、数据库查询等）
- 架构或模块结构发生变化

**不更新 README.md 则视为任务未完成。**

## 不变量

- `poll()` 永远不能抛出异常——所有错误在内部捕获
- `main.ts` 设有全局 `uncaughtException` 和 `unhandledRejection` 处理器
- 所有链上代币数量使用 `bigint`——绝不使用 `number`
- 导入路径使用 `.js` 扩展名（NodeNext 模块解析）
- `noUncheckedIndexedAccess: true` — `arr[0]` 返回 `T | undefined`，始终做防守判断
- `exactOptionalPropertyTypes: true` — 可选字段必须省略，不能设为 `undefined`
