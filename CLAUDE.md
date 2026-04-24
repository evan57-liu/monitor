# CLAUDE.md — DeFi Monitor Bot

## Project overview

7x24 DeFi monitoring bot. Watches msUSD/USDC LP position on Aerodrome (Base chain).
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
- `exactOptionalPropertyTypes: true` — optional fields must be OMITTED, not set to `undefined`
