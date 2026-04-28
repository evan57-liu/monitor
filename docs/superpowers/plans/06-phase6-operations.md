# Phase 6: Operations

Tasks 27–28. After this phase: the bot runs as a persistent launchd daemon on Mac mini, restarts after crashes and power loss, and the project has a CLAUDE.md for future contributors.

---

## Task 27: Mac mini Daemon Setup

**Files:**
- Create: `com.defi.monitor.plist`
- Run: `pmset` configuration (one-time, as root)

### Step A: Prevent Mac mini from sleeping

- [ ] **Run these commands on the Mac mini (one-time):**

```bash
# Prevent sleep when plugged in
sudo pmset -c sleep 0 displaysleep 0 disksleep 0

# Auto-start after power failure
sudo pmset -c autorestart 1

# Verify
pmset -g | grep -E "sleep|autorestart"
```

Expected output includes:
```
sleep                1  (Display sleep enabled; system sleep disabled)
autorestart          1
```

### Step B: Build the project

- [ ] **Build for production:**

```bash
cd /Users/57block/web3project/monitor
npm run build
```

Expected: `dist/` directory created with compiled JS files.

- [ ] **Verify startup:**

```bash
DRY_RUN=true node dist/main.js
```

Expected: same output as `npm run dev`.

### Step C: Create launchd plist

- [ ] **Create `com.defi.monitor.plist` in the project root:**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.defi.monitor</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/57block/web3project/monitor/dist/main.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>/Users/57block/web3project/monitor</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>

  <!-- Restart immediately if process exits (crash recovery) -->
  <key>KeepAlive</key>
  <true/>

  <!-- Wait 10s before restarting after crash -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!-- Start automatically on login/boot -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Log output -->
  <key>StandardOutPath</key>
  <string>/Users/57block/web3project/monitor/logs/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/57block/web3project/monitor/logs/stderr.log</string>
</dict>
</plist>
```

> **Check Node.js path:** Run `which node` to confirm it's `/usr/local/bin/node`. If it's elsewhere (e.g., `/opt/homebrew/bin/node` on Apple Silicon), update the plist accordingly.

- [ ] **Create logs directory:**

```bash
mkdir -p /Users/57block/web3project/monitor/logs
```

- [ ] **Add logs/ to .gitignore:**

```bash
echo "logs/" >> .gitignore
```

### Step D: Install and start the daemon

- [ ] **Copy plist to LaunchAgents and load:**

```bash
cp com.defi.monitor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist
```

- [ ] **Verify it's running:**

```bash
launchctl list | grep com.defi.monitor
```

Expected: line with PID (non-zero number in first column = running).

- [ ] **Check logs:**

```bash
tail -f /Users/57block/web3project/monitor/logs/stdout.log
```

Expected: same startup logs as manual run.

### Step E: Weekly restart cron (keep memory clean)

A weekly restart prevents any long-running memory issues.

- [ ] **Add crontab entry:**

```bash
crontab -e
```

Add this line (restarts every Sunday at 3am):
```
0 3 * * 0 launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist && sleep 5 && launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist
```

### Step F: Operational commands reference

```bash
# Stop the daemon
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist

# Start the daemon
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# Restart
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist && sleep 3 && launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# View live logs
tail -f /Users/57block/web3project/monitor/logs/stdout.log

# Check daemon status
launchctl list | grep com.defi.monitor

# Check DB (recent alerts)
sqlite3 /Users/57block/web3project/monitor/data/monitor.db \
  "SELECT triggered_at, type, level, title FROM alerts ORDER BY triggered_at DESC LIMIT 10;"

# Check executions
sqlite3 /Users/57block/web3project/monitor/data/monitor.db \
  "SELECT created_at, order_type, status, tx_hash FROM executions ORDER BY created_at DESC LIMIT 10;"
```

### Step G: Enable LIVE mode (after DRY_RUN validation)

Only after running in DRY_RUN for 48+ hours without false positives:

- [ ] **Edit `configs/monitor.yaml`:**

```yaml
global:
  dry_run: false   # ← change this
```

- [ ] **Verify execution wallet approvals are set:**

The execution wallet must have been pre-approved by the LP NFT owner:
1. `gauge.approve(executionWallet, tokenId)` — lets executor call `gauge.withdraw(tokenId)`
2. `positionManager.approve(executionWallet, tokenId)` — lets executor call `decreaseLiquidity`
3. `routerAddress` must be approved for `msUsdAddress` and `usdcAddress` token transfers

These approvals must be done from the **owner wallet** (not the execution wallet) using Basescan or a dApp UI before going live.

- [ ] **Restart daemon to pick up config change:**

```bash
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist
```

- [ ] **Verify LIVE mode in logs:**

```bash
grep "LIVE" /Users/57block/web3project/monitor/logs/stdout.log | tail -5
```

Expected: `"Executor initialised" {"mode":"LIVE"}`

- [ ] **Commit**

```bash
git add com.defi.monitor.plist .gitignore
git commit -m "ops: add launchd plist for Mac mini daemon"
```

---

## Task 28: CLAUDE.md + Final Cleanup

**Files:**
- Create: `CLAUDE.md`
- Verify: `npm run typecheck && npm test`

- [ ] **Step 1: Create CLAUDE.md**

```markdown
# CLAUDE.md — DeFi Monitor Bot

## Project overview

7×24 DeFi monitoring bot. Watches msUSD/USDC LP position on Aerodrome (Base chain).
Auto-withdraws when danger signals are detected.
Runs as a launchd daemon on Mac mini.

## Running the project

```bash
npm run dev          # Development (DRY_RUN mode by default via configs/monitor.yaml)
npm run typecheck    # Type-check only
npm test             # Run all unit tests
npm run build        # Compile to dist/
```

## Configuration

- `configs/monitor.yaml` — all non-secret settings (thresholds, addresses, intervals)
- `configs/.env` — secrets (gitignored, see `.env.example` for template)
- Set `global.dry_run: true` for testing — no on-chain transactions will execute

## Architecture

```
src/core/        ← Protocol-agnostic infrastructure
  types.ts       ← All shared interfaces (start here)
  engine.ts      ← Main loop: polls monitors, dispatches alerts/orders
  clients/       ← CoinGecko, DeBank, viem RPC
  storage/       ← SQLite (price history, alerts, executions)
  executor/      ← On-chain execution (live + DRY_RUN)
  notify/        ← ServerChan, Email, Healthchecks, Notifier

src/protocols/aerodrome/
  index.ts       ← Implements Monitor interface (entry point)
  alerts.ts      ← 5 alert rules with state machine ← most critical logic
  orders.ts      ← 3-step withdrawal order generation
  monitors/      ← Individual data fetchers (price, pool, supply, position, protocol, wallets)
```

## Adding a new protocol

1. Create `src/protocols/<name>/` with the same structure as `aerodrome/`
2. Implement the `Monitor` interface in `index.ts`
3. Register in `src/main.ts`: `engine.register(new MyProtocolMonitor(...))`
4. Add config section to `configs/monitor.yaml`

## Alert system

5 red alert types → auto-withdrawal triggered:
- `depeg` — price < $0.992, multi-source confirmed, sustained 3min
- `hack_mint` — totalSupply +15%, price dropping, sells spike
- `liquidity_drain` — Metronome TVL -30%, pool imbalanced
- `insider_exit` — team wallet large outflow + price drop
- `position_drop` — your LP value -10% in 1hr

All alerts require multi-source confirmation before escalating to RED.
See `src/protocols/aerodrome/alerts.ts` for the state machine.

## DRY_RUN mode

`global.dry_run: true` in monitor.yaml:
- All monitoring and alerting logic runs identically
- The `DryRunExecutor` logs what would be executed but sends no transactions
- Run for 48+ hours before switching to LIVE

## Operations

```bash
# Start daemon
launchctl load ~/Library/LaunchAgents/com.defi.monitor.plist

# Stop daemon
launchctl unload ~/Library/LaunchAgents/com.defi.monitor.plist

# View logs
tail -f logs/stdout.log

# Query recent alerts
sqlite3 data/monitor.db "SELECT triggered_at, type, level, title FROM alerts ORDER BY triggered_at DESC LIMIT 10;"
```

## Invariants

- `poll()` must never throw — all errors are caught internally
- `main.ts` has global `uncaughtException` and `unhandledRejection` handlers
- `bigint` for all on-chain token amounts — never `number`
- Import paths use `.js` extension (NodeNext module resolution)
- `noUncheckedIndexedAccess: true` — `arr[0]` returns `T | undefined`, always guard
```

- [ ] **Step 2: Run full final check**

```bash
npm run typecheck && npm test
```

Expected: 0 type errors, all tests green.

- [ ] **Step 3: Final commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md with architecture, operations, and invariants"
```

---

## Deployment Checklist (before going LIVE)

Run through this checklist after DRY_RUN validation:

- [ ] DRY_RUN ran for 48+ hours with no false positives
- [ ] Alert thresholds reviewed — no spurious WARNING alerts
- [ ] `configs/monitor.yaml` has correct contract addresses for pool, gauge, msUSD, USDC
- [ ] `lp_token_id` is set to your actual NFT token ID
- [ ] `team_wallets` populated with known Metronome team/treasury addresses
- [ ] Execution wallet has sufficient ETH for gas (≥$30 worth)
- [ ] LP NFT ownership pre-approved the execution wallet on `gauge` and `positionManager`
- [ ] ServerChan receives test notification from `notifier.testAll()`
- [ ] Email receives test notification from `notifier.testAll()`
- [ ] Healthchecks.io dashboard shows green
- [ ] `global.dry_run: false` set in monitor.yaml
- [ ] Daemon restarted, logs show `"mode":"LIVE"`
- [ ] First live poll completes without errors
