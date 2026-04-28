# DeFi Monitor Bot

> 7×24 小时 DeFi 监控机器人。监视 Aerodrome（Base 链）上的 msUSD/USDC LP 仓位，检测到危险信号时自动执行三步撤出。

---

## 目录

1. [项目概述](#1-项目概述)
2. [前置条件](#2-前置条件)
3. [安装](#3-安装)
4. [配置详解](#4-配置详解)
5. [密钥配置](#5-密钥配置)
6. [合约地址获取](#6-合约地址获取)
7. [执行钱包准备](#7-执行钱包准备)
8. [开发命令](#8-开发命令)
9. [三阶段测试流程（极重要）](#9-三阶段测试流程极重要)
10. [功能点逐项验证](#10-功能点逐项验证)
11. [守护进程部署](#11-守护进程部署)
12. [日常运维](#12-日常运维)
13. [数据库查询手册](#13-数据库查询手册)
14. [故障排查](#14-故障排查)
15. [系统架构](#15-系统架构)
16. [告警规则详解](#16-告警规则详解)

---

## 1. 项目概述

### 它做什么

- **监控**：每 10 秒从 CoinGecko Pro 抓取 msUSD 价格，每 30 秒从 DeBank 获取池子数据，每 60 秒通过 RPC 读取 totalSupply
- **检测**：5 种危险信号（脱锚、黑客铸造、流动性枯竭、内部人撤离、仓位异常）
- **执行**：触发 RED 级告警时自动三步撤出（取消质押 → 移除流动性 → 分批兑换为 USDC）
- **通知**：Server酱（微信推送）+ Gmail 双通道实时告警
- **运维**：Healthchecks.io 心跳监控、SQLite 持久化、每日 9 点邮件总结

### 关键设计原则

- **DRY_RUN 优先**：默认配置下不执行任何链上操作，所有逻辑完整运行但交易只记录日志
- **多源确认**：告警触发需要 2-3 个独立数据源同时确认，极大降低误报率
- **顺序执行**：撤出三步按序执行，任一步失败则中止，不会留下半完成状态
- **永不崩溃**：`poll()` 内部捕获所有错误，`main.ts` 有全局异常保护

---

## 2. 前置条件

### 硬件 & 系统

- macOS（Mac mini 或任意 Mac）
- 网络稳定，能访问 Coinbase/Base 链和各 API

### 软件

```bash
# 检查 Node.js 版本（需要 v22+）
node --version   # 期望: v22.x.x

# 检查 npm 版本
npm --version    # 期望: 10.x.x

# 检查 git
git --version
```

如果 Node.js 版本不对：
```bash
# 使用 nvm 安装（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 22
nvm use 22
```

### API 账号

| 服务 | 用途 | 获取方式 |
|------|------|----------|
| CoinGecko Pro | msUSD 价格 + 池子数据 | https://www.coingecko.com/en/api/pricing |
| DeBank Pro | 仓位价值 + 协议 TVL | https://cloud.debank.com |
| Server酱 | 微信推送告警 | https://sct.ftqq.com |
| Gmail 应用密码 | 邮件告警 | Gmail → 账号 → 安全性 → 应用专用密码 |
| Healthchecks.io | 心跳监控（死亡开关） | https://healthchecks.io（免费计划足够） |

---

## 3. 安装

```bash
# 克隆项目
cd /Users/57block/web3project
git clone <repo-url> monitor
cd monitor

# 安装依赖
npm install

# 验证依赖安装正确
npm run typecheck   # 期望: 0 errors
npm test            # 期望: 72 tests passed
```

---

## 4. 配置详解

所有非密钥配置在 `configs/monitor.yaml`。以下是每个关键配置项的详细说明。

### 4.1 全局设置

```yaml
global:
  dry_run: true       # ← 上线前必须是 true！
  log_level: "info"   # debug（最详细）| info | warn | error
```

**`dry_run: true`** 时的行为：
- 所有数据采集正常运行
- 告警逻辑正常运行
- 只有执行器被替换为 `DryRunExecutor`，只记录日志不发送交易
- 通知（Server酱/Email）**仍然正常发送**

### 4.2 数据源配置

```yaml
sources:
  coingecko:
    rate_limit_per_minute: 500    # Pro 计划一般 500/min，不用改
    timeout_ms: 10000             # 10秒超时
    retry_attempts: 3             # 失败最多重试 3 次

  debank:
    timeout_ms: 15000             # DeBank 响应较慢，给15秒
    retry_attempts: 3

  rpc:
    base:
      url: "https://mainnet.base.org"   # 免费公共 RPC，够用
      timeout_ms: 10000
```

> 如果公共 RPC 不稳定，可在 `configs/.env` 中设置 `DM_RPC_BASE_URL=https://你的私有RPC`

### 4.3 通知配置

```yaml
notifications:
  serverchan:
    enabled: true
    timeout_ms: 5000
    retry_attempts: 5       # 失败重试5次

  email:
    enabled: true
    smtp_host: "smtp.gmail.com"
    smtp_port: 587
    from: "your-monitor@gmail.com"
    to:
      - "you@example.com"   # 可以填多个收件人
    retry_attempts: 5
    daily_summary_hour: 9   # 每天9点发每日总结

  healthchecks:
    enabled: true
    interval_seconds: 60    # 每60秒发一次心跳
```

**Healthchecks.io 配置说明**：
1. 登录 https://healthchecks.io，创建一个新的 Check
2. 设置 Period = 5 minutes，Grace = 5 minutes
3. 复制 Ping URL（形如 `https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）
4. 填入 `configs/.env` 的 `DM_HEALTHCHECKS_PING_URL`
5. 如果 bot 停止运行超过 5 分钟，Healthchecks 会发邮件告警

### 4.4 协议配置（Aerodrome）

```yaml
protocols:
  aerodrome_msusd_usdc:
    enabled: true
    lp_token_id: 0    # ← 必须填入你的真实 NFT Token ID！

    # 轮询间隔
    polling:
      price_ms: 10000       # 价格：10秒
      pool_ms: 30000        # 池子：30秒
      supply_ms: 60000      # 供应量：60秒
      position_ms: 60000    # 仓位：60秒
      protocol_ms: 120000   # 协议 TVL：2分钟
      team_wallets_ms: 120000  # 团队钱包：2分钟
```

### 4.5 告警阈值配置

```yaml
alerts:
  depeg:
    price_threshold: 0.992    # 低于 $0.992 触发 → 可调整
    twap_threshold: 0.992     # 链上 TWAP 确认阈值
    pool_imbalance_pct: 75    # 池中 msUSD > 75% 确认池子失衡
    sustained_seconds: 180    # 须持续 3 分钟才升级为 RED
    required_confirmations: 3 # 三个数据源全部确认

  hack_mint:
    supply_increase_pct: 15   # totalSupply 1小时内增加 15%
    price_drop_pct: 2         # 同时价格下跌 2%
    sells_spike_multiplier: 5 # 同时卖出是正常的 5 倍

  liquidity_drain:
    tvl_drop_pct: 30          # Metronome TVL 1小时下降 30%
    pool_msusd_ratio_pct: 70  # 池子 msUSD 占比 > 70%
    sells_buys_ratio: 3       # 卖出/买入比 > 3

  insider_exit:
    large_outflow_usd: 50000  # 团队钱包单次转出 > $50,000
    price_drop_pct: 1         # 同时价格下跌 1%

  position_drop:
    drop_pct: 10              # 你的仓位价值 1小时内下跌 10%
```

### 4.6 执行参数配置

```yaml
execution:
  swap_batch_count: 3       # 分 3 批兑换 msUSD（降低单笔滑点）
  swap_slippage_bps: 100    # 1% 最大滑点（100 bps = 1%）
  gas_multiplier: 1.2       # Gas 估算乘以 1.2 倍确保打包
  deadline_seconds: 300     # 交易有效期 5 分钟
  max_gas_gwei: 50          # Gas 超过 50 gwei 时拒绝执行
```

---

## 5. 密钥配置

```bash
# 从模板创建 .env 文件（已在 .gitignore 中，不会被提交）
cp configs/.env.example configs/.env
```

编辑 `configs/.env`：

```bash
# CoinGecko Pro API Key
# 从 https://www.coingecko.com/en/api/pricing 获取
DM_COINGECKO_API_KEY=CG-xxxxxxxxxxxxxxxxxxxx

# DeBank Pro Access Key
# 从 https://cloud.debank.com 获取
DM_DEBANK_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxx

# 执行钱包私钥（0x 开头）
# ⚠️  这必须是你质押 LP 的主钱包私钥（Gauge 合约只允许原始 staker 取消质押）
# 推荐：用 macOS Keychain 存储（见下方"私钥安全存储"），省去明文写入 .env
# DRY_RUN 测试期间可以用假私钥（不会发送任何交易）：
# DM_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
# ⚠️  上线前必须换成真实私钥，且必须是质押 LP NFT 的那个钱包
# （Gauge.withdraw 只允许最初 deposit 的地址调用，无法委托给其他钱包）
DM_PRIVATE_KEY=0x...

# Server酱 SendKey
# 从 https://sct.ftqq.com 注册后获取，形如 SCTxxxxxxxxxx
DM_SERVERCHAN_SENDKEY=SCTxxxxxxxxxxxxxxxxxx

# Gmail 应用专用密码
# 不是你的 Gmail 登录密码！
# 路径：Google 账号 → 安全性 → 两步验证 → 应用专用密码
DM_EMAIL_USER=your@gmail.com
DM_EMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx

# Healthchecks.io Ping URL
DM_HEALTHCHECKS_PING_URL=https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# 可选：覆盖 Base RPC（如果公共节点不稳定）
# DM_RPC_BASE_URL=https://你的私有rpc节点
```

### 5.1 私钥安全存储

**不需要修改任何代码**。macOS FileVault 提供磁盘级 AES-XTS 加密，对应用完全透明——Node.js 读取 `.env` 的方式不变，但磁盘上所有文件（包括 `.env`）均处于加密状态。

**第一步：确认 FileVault 已开启**

```bash
fdesetup status
# 期望输出：FileVault is On.
```

如果未开启：系统设置 → 隐私与安全性 → FileVault → 打开。

**第二步：锁定 .env 文件权限**

```bash
# 只有你自己可读写，其他用户和程序无权访问
chmod 600 configs/.env
chmod 700 configs/

# 验证
ls -la configs/.env
# 期望：-rw------- 1 57block staff ... configs/.env
```

**这两步之后的防护效果：**

| 威胁场景 | 是否防住 |
|---------|---------|
| 磁盘/Mac 被盗，拔出硬盘读取 | ✅ FileVault 加密，无法读取 |
| 送修/回收时数据残留 | ✅ FileVault 加密 |
| 其他用户或低权限程序读取 | ✅ `chmod 600` 文件权限 |
| 意外提交到 git | ✅ `.gitignore` 已排除 |
| 攻击者以**你的用户身份**运行代码 | ❌ 任何软件方案均无法防御 |

最后一行是所有纯软件密钥保护的边界：能以你的身份执行任意代码的攻击者，无论 Keychain、GPG 还是其他方案，都无法阻止他。物理安全和账号安全（强密码、不运行来源不明的程序）才是最后防线。

---

## 6. 合约地址获取

在 `configs/monitor.yaml` 中填入以下地址，**所有地址均可从 Basescan 或 Aerodrome UI 查到**。

### 6.1 快速查找方法

```bash
# 以下是 Base 链上的固定地址，直接复制：
usdc_address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"          # USDC（Base）
router_address: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43"        # Aerodrome Router v2
position_manager_address: "0x827922686190790b37229fd06084350E74485b72" # Aerodrome NonfungiblePositionManager
```

### 6.2 需要你手动查找的地址

**msUSD 合约地址**：
1. 进入 https://basescan.org
2. 搜索 "msUSD"
3. 找到 Metronome 官方 msUSD 代币合约

**Aerodrome msUSD/USDC 池地址**（`pool_address`）：
1. 进入 https://aerodrome.finance/pools
2. 搜索 "msUSD/USDC"
3. 找到对应的集中流动性（CL）池，复制合约地址

**Gauge 地址**（`gauge_address`）：
1. 在 Aerodrome 池页面点击该池
2. 找到 "Gauge" 链接，复制 Gauge 合约地址

**你的 LP Token ID**（`lp_token_id`）：
1. 进入 https://aerodrome.finance/positions
2. 连接你的钱包
3. 找到 msUSD/USDC 仓位，Token ID 显示在右侧
4. 或者在 Basescan 上搜索你的钱包地址 → ERC-721 Tokens → 找到 Aerodrome 的 NFT

---

## 7. 执行钱包准备

**执行钱包即你质押 LP NFT 的那个钱包本身。**

Aerodrome Gauge 的 `withdraw(tokenId)` 只允许最初 `deposit` 的地址调用，没有任何委托或 approve 机制。因此 `DM_PRIVATE_KEY` 必须填写质押钱包的私钥，不能使用独立的"代理"钱包。

### 7.1 确认钱包地址

```bash
# 你的 LP NFT 质押在哪个钱包下，DM_PRIVATE_KEY 就填那个钱包的私钥
# 在 Aerodrome UI → Positions 页面可以看到质押该 NFT 的钱包地址
```

### 7.2 确保钱包有足够 ETH 做 Gas

```bash
# 在 Basescan 搜索你的钱包地址，查看 ETH 余额
# Base 链 Gas 费极低，三步撤出合计约 $0.50 ~ $1.00
# 建议余额不低于 $10 等值 ETH，足够应对网络拥堵
```

### 7.3 授权 Router 花费 msUSD（上线前必做）

三步撤出中，swap 步骤需要 Router 合约有权转移你钱包中的 msUSD。
通过 Basescan 的 Write Contract 功能完成（**用质押钱包签名**）：

1. 进入 msUSD 合约页面（Basescan 搜索 msUSD 合约地址）
2. 点击 **"Write Contract"** → **"approve"**
3. 填写参数：
   - `spender`：Router 地址（`0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`）
   - `amount`：`115792089237316195423570985008687907853269984665640564039457584007913129639935`（`type(uint256).max`，永久授权无需重复操作）
4. 用**质押钱包**连接 MetaMask 签名并发送

---

## 8. 开发命令

```bash
# 开发模式（热重载，使用 configs/monitor.yaml 的配置）
npm run dev

# 仅类型检查（不运行）
npm run typecheck

# 运行所有单元测试
npm test

# 监听模式运行测试（开发时用）
npm run test:watch

# 编译到 dist/ 目录（守护进程部署前运行）
npm run build

# 运行编译后的版本
npm start
```

---

## 9. 三阶段测试流程（极重要）

> **Bot 不能直接上线就跑 $18.5K 的仓位。必须按以下顺序分阶段测试。**

---

### 阶段 1：DRY_RUN 模式（建议 2-3 天）

**目标：** 验证数据采集、告警逻辑、通知发送全部正常工作。交易只记录日志，不发送到链上。

#### Step 1.1：配置 DRY_RUN 环境

```yaml
# configs/monitor.yaml
global:
  dry_run: true          # ← 确认是 true
  log_level: "debug"     # ← 改成 debug，看到所有细节
```

```bash
# configs/.env（DRY_RUN 期间可以用假私钥）
DM_PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000001
```

#### Step 1.2：验证 API 连通性

```bash
# 启动 bot
npm run dev

# 观察启动日志，确认以下输出：
# INFO: DeFi Monitor starting {"dryRun":true}
# INFO: SQLite database opened
# INFO: Notification channel test results {"channels":{"serverchan":true,"email":true}}
# INFO: Executor initialised {"mode":"DRY_RUN"}
# INFO: Protocol registered {"monitorId":"aerodrome-msusd-usdc"}
# INFO: Engine started — monitoring active
```

如果 `channels` 里有 `false`：
- `serverchan: false` → 检查 `DM_SERVERCHAN_SENDKEY` 是否正确
- `email: false` → 检查 Gmail 应用密码，确认已开启两步验证

#### Step 1.3：等待第一次数据采集（约 10 秒后）

日志中会出现类似以下内容（debug 级别）：

```
DEBUG: CoinGecko price fetched {"tokenAddress":"0x...","price":1.0001}
DEBUG: Pool data fetched {"msUsdRatio":0.501,"volume24h":182000}
DEBUG: Supply fetched {"totalSupply":"10000000000000000000000000"}
DEBUG: Position fetched {"netUsdValue":18500}
INFO: [aerodrome-msusd-usdc] poll complete {"alerts":0,"orders":0}
```

**验证清单 ✓**：
- [ ] 价格数据正常（coingecko 和 twap 都不是 null）
- [ ] 池子数据正常（msUsdRatio 在 0.4-0.6 之间是健康的）
- [ ] 仓位价值正常（接近你的实际仓位价值）
- [ ] totalSupply 数字合理（不是 0）
- [ ] 无 ERROR 级别日志

#### Step 1.4：手动测试通知

打开新终端，直接调用通知测试（通过环境变量触发）：

```bash
# 临时降低价格阈值触发 WARNING 告警（观察通知）
# 编辑 configs/monitor.yaml
alerts:
  depeg:
    price_threshold: 1.01   # 改成高于当前价格，必然触发
    sustained_seconds: 10   # 改成 10 秒，快速验证
    required_confirmations: 1

# 重启 bot
npm run dev

# 等待约 10-20 秒
# Server酱应该收到微信推送
# 邮件可能略有延迟（1-2 分钟内）
```

测试完成后**立即还原阈值**：
```yaml
price_threshold: 0.992
sustained_seconds: 180
required_confirmations: 3
```

**验证清单 ✓**：
- [ ] 微信收到 WARNING 级别推送
- [ ] 邮件收到告警内容
- [ ] 日志中显示 `DRY_RUN: would execute unstake`（不是真实交易）

#### Step 1.5：持续运行 2-3 天，观察以下指标

```bash
# 查看过去 48 小时有没有误报
sqlite3 data/monitor.db \
  "SELECT triggered_at, type, level, title FROM alerts ORDER BY triggered_at DESC LIMIT 20;"

# 检查健康状态
sqlite3 data/monitor.db \
  "SELECT checked_at, healthy FROM health_snapshots ORDER BY checked_at DESC LIMIT 10;"

# 看每日通知是否正常（每天 9 点）
tail -n 100 logs/stdout.log | grep "daily"
```

**阶段 1 通过标准**：
- [ ] 连续运行 48 小时无崩溃（`launchctl list | grep com.defi.monitor` PID 不变）
- [ ] 无误报告警（msUSD 正常时不应有 RED 告警）
- [ ] 每日总结邮件正常发送
- [ ] Healthchecks.io 仪表盘持续绿色
- [ ] API 错误率 < 5%（偶尔超时正常，熔断器会自动恢复）

---

### 阶段 2：小金额实盘测试（建议 1-2 天）

**目标：** 验证链上执行三步流程（unstake → remove liquidity → swap）能够真实完成。**这是最关键的一步，所有理论分析都不如真撤一次有效。**

#### Step 2.1：在 Aerodrome 建立 $100 的测试仓位

1. 进入 https://aerodrome.finance/liquidity
2. 选择 msUSD/USDC 池（集中流动性）
3. 存入约 $100 等值资产（msUSD + USDC 各 $50）
4. **获取新的 LP Token ID**（和主仓位不同）
5. 将 LP NFT 质押到对应 Gauge 获取奖励

#### Step 2.2：确认钱包和授权

```bash
# 确认质押钱包有 ETH（Basescan 搜索钱包地址查看余额）
# 需要至少 $5 等值 ETH（Base 链 Gas 很便宜，实际花费很少）

# 确认 Router 已获得 msUSD 授权（见第 7.3 节）
# 对测试仓位同样需要 Router 授权（若与主仓位使用同一钱包，已授权则无需重复操作）
```

#### Step 2.3：切换 bot 配置到测试仓位

```yaml
# configs/monitor.yaml
global:
  dry_run: false        # ← 关键！改为 false

protocols:
  aerodrome_msusd_usdc:
    lp_token_id: 你的测试仓位Token ID   # ← 换成测试仓位的 ID
```

```bash
# configs/.env
DM_PRIVATE_KEY=0x你的质押钱包私钥   # ← 换成真实私钥（必须是质押该 LP NFT 的钱包）
```

#### Step 2.4：触发测试撤出

有两种方法，选一种：

**方法 A：临时降低阈值（推荐）**

```yaml
# configs/monitor.yaml
alerts:
  position_drop:
    drop_pct: 0.01          # 改成极小值（0.01%），必然触发
    window_seconds: 60      # 时间窗口改为 60 秒
```

重启 bot，等待 60 秒，`position_drop` 告警应在下一次轮询时触发。

**方法 B：直接观察**

如果测试仓位期间 msUSD 发生波动，可以直接让它自然触发。

#### Step 2.5：观察执行过程

```bash
# 实时监控日志
tail -f logs/stdout.log

# 期望看到以下日志序列：
# INFO: Alert triggered {"type":"position_drop","level":"RED"}
# INFO: Executing unstake {"orderId":"...","type":"unstake","sequence":1}
# INFO: Transaction submitted {"txHash":"0x..."}
# INFO: Transaction confirmed {"txHash":"0x...","status":"success"}
# INFO: Executing remove_liquidity {"sequence":2}
# INFO: Transaction submitted {"txHash":"0x..."}
# INFO: Transaction confirmed ...
# INFO: Executing swap {"sequence":3,"batchIndex":0,"totalBatches":3}
# INFO: Executing swap {"sequence":4,"batchIndex":1}
# INFO: Executing swap {"sequence":5,"batchIndex":2}
# INFO: Execution group completed
```

#### Step 2.6：在 Basescan 验证交易

```bash
# 查看执行记录
sqlite3 data/monitor.db \
  "SELECT created_at, order_type, sequence, status, tx_hash
   FROM executions
   ORDER BY created_at DESC LIMIT 10;"

# 复制 tx_hash 到 https://basescan.org 验证：
# 1. unstake 交易：Gauge.withdraw(tokenId) 成功
# 2. remove_liquidity 交易：decreaseLiquidity + collect 成功
# 3. swap 交易（3笔）：exactInputSingle 成功，msUSD → USDC
```

**验证清单 ✓**：
- [ ] 5 笔交易全部成功（Status: Success）
- [ ] 执行钱包收到 USDC（在 Basescan 的 ERC-20 Token Txns 中可见）
- [ ] 原 LP NFT 已从 Gauge 中取消质押
- [ ] 流动性已从仓位移除
- [ ] 日志中无 ERROR（特别是无 "Order failed — aborting group"）

#### Step 2.7：测试完成后恢复配置

```yaml
# configs/monitor.yaml
global:
  dry_run: true   # 恢复 DRY_RUN，等待切换到主仓位

alerts:
  position_drop:
    drop_pct: 10          # 恢复原始阈值
    window_seconds: 3600
```

**阶段 2 通过标准**：
- [ ] 5 笔交易全部在链上成功确认
- [ ] USDC 到达执行钱包（或你指定的接收地址）
- [ ] 整个执行过程 < 5 分钟
- [ ] Gas 消耗合理（每笔 < $0.50，Base 链很便宜）

---

### 阶段 3：上线主仓位（$18.5K）

**进入此阶段的前提**：
- [ ] 阶段 1 连续运行 48 小时无问题
- [ ] 阶段 2 小金额测试成功完成
- [ ] 主仓位的三个授权已完成（见第 7 章）
- [ ] 执行钱包 ETH 余额充足（≥ $30）

#### Step 3.1：切换到主仓位

```yaml
# configs/monitor.yaml
global:
  dry_run: false        # ← 改为 false

protocols:
  aerodrome_msusd_usdc:
    lp_token_id: 你的主仓位Token ID    # ← 换成主仓位的 ID
    team_wallets:                       # ← 可选：填入 Metronome 已知团队地址
      - "0x..."
      - "0x..."
```

#### Step 3.2：重启守护进程

```bash
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# 确认 LIVE 模式
grep "LIVE" logs/stdout.log | tail -3
# 期望: INFO: Executor initialised {"mode":"LIVE"}
```

#### Step 3.3：第一周加倍关注

```bash
# 每天检查一次
sqlite3 data/monitor.db \
  "SELECT triggered_at, type, level, title FROM alerts ORDER BY triggered_at DESC LIMIT 10;"

# 确认没有误报
# 确认 Healthchecks.io 持续绿色
# 确认每日邮件总结正常到达
```

---

## 10. 功能点逐项验证

### 10.1 API 连通性验证

```bash
# 启动 bot 后查看启动日志
npm run dev 2>&1 | head -30

# 期望看到以下内容（没有 ERROR）：
# INFO: DeFi Monitor starting
# INFO: Notification channel test results {"channels":{"serverchan":true,"email":true}}
# INFO: Executor initialised {"mode":"DRY_RUN"}
# INFO: Engine started
```

**单独测试 CoinGecko API**：
```bash
curl -s "https://pro-api.coingecko.com/api/v3/ping" \
  -H "x-cg-pro-api-key: $你的APIKEY"
# 期望: {"gecko_says":"(V3) To the Moon!"}
```

**单独测试 DeBank API**：
```bash
curl -s "https://pro-openapi.debank.com/v1/user/protocol?id=aerodrome&user_addr=0x你的钱包地址" \
  -H "AccessKey: $你的ACCESSKEY"
# 期望: JSON 响应包含 portfolio_item_list
```

### 10.2 数据库验证

```bash
# 检查数据库是否正常创建和写入
sqlite3 data/monitor.db ".tables"
# 期望: alerts  executions  health_snapshots  pool_snapshots  price_history  supply_history

# 检查最近价格记录（10秒一条）
sqlite3 data/monitor.db \
  "SELECT recorded_at, coingecko_price, twap_price FROM price_history ORDER BY recorded_at DESC LIMIT 5;"

# 检查健康快照
sqlite3 data/monitor.db \
  "SELECT checked_at, healthy, sources FROM health_snapshots ORDER BY checked_at DESC LIMIT 5;"
```

### 10.3 熔断器验证

熔断器在数据源连续失败 5 次后自动暂停监控 5 分钟并发送告警。

**测试方法**：
```bash
# 临时将 CoinGecko URL 改为一个无效地址
# configs/monitor.yaml
sources:
  coingecko:
    base_url: "https://invalid-url-to-trigger-cb.example.com"

# 重启 bot，等待约 1 分钟
npm run dev

# 查看日志，应该看到：
# ERROR: Monitor poll failed {"consecutiveFailures":1}
# ERROR: Monitor poll failed {"consecutiveFailures":2}
# ... （共 5 次）
# WARN: Monitor paused for 5 minutes after circuit open
# 告警：收到 DATA_SOURCE_FAILURE 微信推送

# 恢复 URL 后 5 分钟，监控自动恢复
```

### 10.4 告警状态机验证

每种告警都有 WARNING（条件刚满足）和 RED（持续一段时间 + 多源确认）两个阶段。

```bash
# 验证 depeg 告警的 WARNING → RED 升级
# 1. 设置 price_threshold: 1.01（必然触发）
# 2. 设置 sustained_seconds: 30（30秒升级）
# 3. 设置 required_confirmations: 1（单源）
# 4. 重启 bot
# 5. 等待 10 秒：应收到 WARNING 推送
# 6. 等待 30 秒：应收到 RED 推送

# 查看数据库中的告警记录
sqlite3 data/monitor.db \
  "SELECT triggered_at, type, level, confirmations, sustained_ms FROM alerts ORDER BY triggered_at DESC LIMIT 5;"
```

### 10.5 顺序执行和失败中止验证

```bash
# 这个逻辑在单元测试中已覆盖，直接运行测试验证：
npm test -- src/core/engine.test.ts --reporter=verbose

# 期望全部通过，特别关注：
# ✓ executes orders from RED alert in sequence
# ✓ stops executing remaining orders in group if one fails
```

### 10.6 并发防重入验证

```bash
# 在单元测试中验证（已覆盖）
npm test -- src/core/engine.test.ts --reporter=verbose

# 关注：
# ✓ does not run overlapping cycles for the same monitor
```

---

## 11. 守护进程部署

### 11.1 编译项目

```bash
cd /Users/57block/web3project/monitor

# 确认最新代码
npm run typecheck && npm test

# 编译
npm run build

# 验证编译产物
ls dist/
# 期望: main.js, core/, protocols/

# 验证启动（DRY_RUN 模式）
node dist/main.js
```

### 11.2 确认 Node.js 路径

```bash
which node
# 记录输出的路径，需要与 plist 文件中一致
```

如果路径不是 `/Users/57block/.nvm/versions/node/v22.21.1/bin/node`，更新 `com.defi.monitor.plist`：

```xml
<key>ProgramArguments</key>
<array>
  <string>/你的/node/路径</string>
  <string>/Users/57block/web3project/monitor/dist/main.js</string>
</array>
```

### 11.3 安装守护进程

```bash
# 创建日志目录
mkdir -p /Users/57block/web3project/monitor/logs

# 复制 plist 到 LaunchAgents
cp com.defi.monitor.plist ~/Library/LaunchAgents/

# 加载守护进程
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# 验证运行状态（PID 列不是 0 或 - 表示正在运行）
launchctl list | grep com.defi.monitor
# 期望: 数字 PID    0    com.defi.monitor
```

### 11.4 防止 Mac mini 睡眠

```bash
# 防止系统和显示器睡眠（连接电源时）
sudo pmset -c sleep 0 displaysleep 0 disksleep 0

# 断电重启后自动启动
sudo pmset -c autorestart 1

# 验证
pmset -g | grep -E "sleep|autorestart"
# 期望包含:
#   sleep 0  (System sleep disabled)
#   autorestart 1
```

### 11.5 配置每周重启（可选但推荐）

防止长期运行内存泄漏：

```bash
crontab -e
```

添加（每周日凌晨 3 点重启）：
```
0 3 * * 0 launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist && sleep 5 && launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist
```

---

## 12. 日常运维

### 常用命令

```bash
# 查看守护进程状态
launchctl list | grep com.defi.monitor

# 停止守护进程
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist

# 启动守护进程
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# 重启守护进程
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist && \
  sleep 3 && \
  launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# 查看实时日志
tail -f logs/stdout.log

# 查看错误日志
tail -f logs/stderr.log

# 查看最近 100 行（包含时间戳）
tail -n 100 logs/stdout.log | grep -E "ERROR|WARN|INFO" | head -50
```

### 更新配置后重启

```bash
# 修改 configs/monitor.yaml 后
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# 验证新配置已加载
grep "DRY_RUN\|LIVE" logs/stdout.log | tail -3
```

### 代码更新后部署

```bash
git pull
npm install           # 如果有新依赖
npm run typecheck     # 确认无类型错误
npm test              # 确认测试通过
npm run build         # 重新编译

# 重启守护进程
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist
```

---

## 13. 数据库查询手册

```bash
# 进入交互式查询（不加后续参数）
sqlite3 data/monitor.db

# 或者直接执行查询
sqlite3 data/monitor.db "SELECT ..."
```

### 告警查询

```bash
# 最近 10 条告警
sqlite3 data/monitor.db \
  "SELECT triggered_at, type, level, title, confirmations, sustained_ms/1000 AS sustained_sec
   FROM alerts
   ORDER BY triggered_at DESC LIMIT 10;"

# 只看 RED 级别告警
sqlite3 data/monitor.db \
  "SELECT triggered_at, type, title FROM alerts WHERE level='red' ORDER BY triggered_at DESC;"

# 统计各类告警数量
sqlite3 data/monitor.db \
  "SELECT type, level, COUNT(*) as count FROM alerts GROUP BY type, level ORDER BY count DESC;"

# 查询最近 24 小时的告警
sqlite3 data/monitor.db \
  "SELECT triggered_at, type, level, title FROM alerts
   WHERE triggered_at > datetime('now', '-24 hours')
   ORDER BY triggered_at DESC;"
```

### 执行记录查询

```bash
# 最近 10 次执行记录
sqlite3 data/monitor.db \
  "SELECT created_at, order_type, sequence, status, tx_hash, error
   FROM executions
   ORDER BY created_at DESC LIMIT 10;"

# 查询失败的执行
sqlite3 data/monitor.db \
  "SELECT created_at, order_type, sequence, error FROM executions WHERE status='failed';"

# 统计执行成功率
sqlite3 data/monitor.db \
  "SELECT status, COUNT(*) as count FROM executions GROUP BY status;"
```

### 价格历史查询

```bash
# 最近 1 小时的价格
sqlite3 data/monitor.db \
  "SELECT recorded_at, coingecko_price, twap_price
   FROM price_history
   WHERE recorded_at > datetime('now', '-1 hour')
   ORDER BY recorded_at DESC;"

# 24 小时价格范围
sqlite3 data/monitor.db \
  "SELECT MIN(coingecko_price) as min_price,
          MAX(coingecko_price) as max_price,
          AVG(coingecko_price) as avg_price
   FROM price_history
   WHERE recorded_at > datetime('now', '-24 hours');"
```

### 健康状态查询

```bash
# 监控器最近健康状态
sqlite3 data/monitor.db \
  "SELECT checked_at, monitor_id, healthy FROM health_snapshots ORDER BY checked_at DESC LIMIT 10;"

# 统计不健康次数
sqlite3 data/monitor.db \
  "SELECT monitor_id, COUNT(*) as unhealthy_count
   FROM health_snapshots
   WHERE healthy=0
   GROUP BY monitor_id;"
```

---

## 14. 故障排查

### Bot 无法启动

```bash
# 查看错误日志
cat logs/stderr.log

# 常见原因和解决方法：
```

| 错误信息 | 原因 | 解决方法 |
|----------|------|----------|
| `DM_COINGECKO_API_KEY is required` | .env 文件缺失或路径错误 | 确认 `configs/.env` 存在且包含所有必填密钥 |
| `Private key not found. Set DM_PRIVATE_KEY...` | 私钥既不在 .env 也不在 Keychain | 二选一：在 `.env` 设置 `DM_PRIVATE_KEY`，或运行 `security add-generic-password -s defi-monitor -a private-key -w 0x你的私钥` |
| `FILL_IN` 相关错误 | monitor.yaml 未填写合约地址 | 填写所有 `FILL_IN` 占位符 |
| `Cannot find module` | npm install 未运行 | 运行 `npm install` |
| `SyntaxError: Unexpected token` | dist/ 目录未编译或过期 | 运行 `npm run build` |

### 通知发送失败

```bash
# 测试 ServerChan
curl -X POST "https://sctapi.ftqq.com/你的SendKey.send" \
  -d "title=测试&desp=Bot测试通知"
# 期望微信收到消息

# 测试 Gmail SMTP（确认应用密码而非登录密码）
# 确认 Gmail 账号已开启两步验证
# 路径：Google 账号 → 安全性 → 两步验证 → 应用专用密码
```

### API 返回 401 / 403

```bash
# CoinGecko Pro API 密钥失效
# 检查密钥是否包含多余空格：
cat configs/.env | grep COINGECKO

# DeBank 同理
cat configs/.env | grep DEBANK
```

### 链上交易失败

```bash
# 查询失败的执行记录
sqlite3 data/monitor.db \
  "SELECT order_type, status, error FROM executions WHERE status='failed' LIMIT 5;"

# 常见原因：
# "insufficient funds" → 执行钱包 ETH 不足，充值
# "execution reverted" → 授权未完成，检查三个 approve
# "gas price too high" → max_gas_gwei 设置过低，适当提高
# "deadline exceeded" → 网络拥堵，增大 deadline_seconds
```

### 数据采集频繁报错

```bash
# 查看熔断器状态（日志中搜索）
grep "circuit\|paused\|resumed" logs/stdout.log | tail -20

# 如果看到 "Monitor paused"，等待 5 分钟自动恢复
# 如果反复触发熔断器，检查 API 密钥和网络连通性
```

### 磁盘空间不足

```bash
# 检查数据库大小
du -h data/monitor.db

# 手动触发清理（保留最近 30 天）
sqlite3 data/monitor.db \
  "DELETE FROM price_history WHERE recorded_at < datetime('now', '-30 days');
   DELETE FROM pool_snapshots WHERE recorded_at < datetime('now', '-30 days');
   DELETE FROM health_snapshots WHERE checked_at < datetime('now', '-7 days');
   VACUUM;"

# 清理日志（保留最近 7 天）
find logs/ -name "*.log" -mtime +7 -delete
```

---

## 15. 系统架构

```
configs/
  monitor.yaml     ← 非敏感配置（阈值、地址、间隔）
  .env             ← 密钥（gitignored）
  .env.example     ← 密钥模板

src/
  main.ts          ← 入口：加载配置 → 初始化 → 注册协议 → 启动引擎

  core/
    types.ts       ← 所有共享接口（从这里开始理解系统）
    config.ts      ← YAML + .env 加载与验证
    logger.ts      ← pino 结构化日志
    engine.ts      ← 主循环：防重入 + 熔断器 + 顺序执行
    circuit-breaker.ts  ← 熔断器（5 次失败 → 暂停 5 分钟）
    retry.ts       ← 指数退避重试

    clients/
      coingecko.ts ← CoinGecko Pro（价格 + 池子数据，8s TTL 缓存）
      debank.ts    ← DeBank Pro（仓位 + TVL + 钱包，50s TTL 缓存）
      rpc.ts       ← viem publicClient（RPC 调用 + TWAP 计算）

    storage/
      index.ts     ← SQLite 初始化 + 6 张表 Schema
      queries.ts   ← 类型安全的查询函数

    executor/
      dry-run.ts   ← DRY_RUN：只记录日志，返回 SKIPPED_DRY_RUN
      index.ts     ← LIVE：viem 签名 + 广播 + 等待收据

    notify/
      serverchan.ts  ← Server酱 HTTP 推送
      email.ts       ← Gmail SMTP（nodemailer）
      healthchecks.ts ← Healthchecks.io 心跳
      notifier.ts    ← 编排器（RED → 双通道，WARNING → 单通道）

  protocols/
    aerodrome/
      index.ts     ← 实现 Monitor 接口（6 路并行采集）
      types.ts     ← 协议专用信号类型
      alerts.ts    ← 5 条告警规则 + 状态机（最核心逻辑）
      orders.ts    ← 3 步撤出订单生成
      monitors/
        price.ts   ← msUSD 价格（CoinGecko 主 + TWAP 备）
        pool.ts    ← 池子储备 + 买卖量
        supply.ts  ← totalSupply（RPC 直读）
        position.ts ← 你的仓位价值（DeBank）
        protocol.ts ← Metronome 协议 TVL（DeBank）
        wallets.ts  ← 团队钱包监控（DeBank）

data/
  monitor.db       ← SQLite 数据库（gitignored）

logs/
  stdout.log       ← 标准输出（gitignored）
  stderr.log       ← 错误输出（gitignored）

dist/              ← 编译产物（gitignored）
```

### 数据流

```
CoinGecko/DeBank/RPC
       ↓ （并行采集，Promise.allSettled）
6 个 Monitor（price/pool/supply/position/protocol/wallets）
       ↓
alerts.ts（多源交叉确认 + 持续时间状态机）
       ↓
WARNING → 仅 Server酱推送
RED     → 生成撤出订单 + Server酱 + Email 双通道
       ↓
Engine.executeOrderGroup（按序执行，失败中止）
  → Executor.execute（DRY_RUN 记日志 / LIVE 发链上交易）
  → SQLite 持久化
```

---

## 16. 告警规则详解

### Depeg（脱锚）

**触发条件**（3 个数据源全部确认 + 持续 3 分钟）：
1. CoinGecko 价格 < $0.992
2. Aerodrome 池子 TWAP < $0.992
3. 池子中 msUSD 占比 > 75%（单边失衡）

**误报防护**：三源确认避免单一数据源故障误报；3 分钟持续时间避免瞬时价格波动

### Hack Mint（黑客铸造）

**触发条件**（2 个数据源确认 + 持续 60 秒）：
1. msUSD totalSupply 在 1 小时内增加 > 15%
2. 同时价格下跌 > 2%（铸币后抛售导致）
3. 同时卖出量是正常水平的 5 倍

### Liquidity Drain（流动性枯竭）

**触发条件**（2 个数据源确认 + 持续 120 秒）：
1. Metronome 整体协议 TVL 在 1 小时内下降 > 30%
2. 池子 msUSD 占比 > 70%（USDC 被抽走）
3. 卖出/买入比 > 3

### Insider Exit（内部人撤离）

**触发条件**（2 个数据源确认 + 持续 60 秒）：
1. 任一团队钱包单次 msUSD 转出 > $50,000
2. 同时价格下跌 > 1%

> 需要在 `team_wallets` 中配置 Metronome 已知团队/国库地址才能生效

### Position Drop（仓位异常）

**触发条件**（立即，无延迟）：
1. 你的 LP 仓位 1 小时内价值下跌 > 10%

这是最后的防线——其他所有检测都失败时，仓位本身的异常会触发撤出。

---

## 附录：快速参考

### 关键数字

| 指标 | 数值 | 含义 |
|------|------|------|
| 价格采集间隔 | 10 秒 | 每 10 秒一次 CoinGecko 价格 |
| Depeg 持续时间 | 180 秒 | 满足条件后 3 分钟才触发 RED |
| 熔断器阈值 | 5 次 | 连续 5 次失败触发熔断 |
| 熔断恢复时间 | 5 分钟 | 暂停后自动恢复 |
| 分批兑换数量 | 3 批 | msUSD 分 3 批换 USDC |
| 最大 Gas | 50 gwei | 超过则拒绝执行 |
| 心跳间隔 | 60 秒 | Healthchecks.io 每分钟一次 |

### 环境变量一览

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `DM_COINGECKO_API_KEY` | ✅ | CoinGecko Pro API Key |
| `DM_DEBANK_ACCESS_KEY` | ✅ | DeBank Pro Access Key |
| `DM_PRIVATE_KEY` | ✅* | 执行钱包私钥（0x 开头）。*可用 macOS Keychain 代替，见第 5.1 节 |
| `DM_SERVERCHAN_SENDKEY` | ✅ | Server酱 SendKey |
| `DM_EMAIL_USER` | ✅ | Gmail 账号 |
| `DM_EMAIL_PASSWORD` | ✅ | Gmail 应用专用密码 |
| `DM_HEALTHCHECKS_PING_URL` | ✅ | Healthchecks.io Ping URL |
| `DM_RPC_BASE_URL` | ❌ | 自定义 RPC（可选，默认用公共节点） |
| `DM_GLOBAL_DRY_RUN` | ❌ | 覆盖 YAML 中的 dry_run 设置 |
| `DM_GLOBAL_LOG_LEVEL` | ❌ | 覆盖日志级别 |
