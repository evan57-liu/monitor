# DeFi Monitor Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 7×24 DeFi monitoring bot that watches msUSD/USDC on Aerodrome (Base chain) via CoinGecko Pro, DeBank, and Base RPC, and auto-executes a 3-step withdrawal when danger signals are confirmed.

**Architecture:** Interface-based, extensible to multiple protocols. `src/core/` is protocol-agnostic infrastructure (clients, storage, executor, notify). Each protocol (starting with `aerodrome`) implements the `Monitor` interface and runs in an independent polling loop driven by the Engine. Protocols produce `Alert[]` and `ExecutionOrder[]`; the Engine handles dispatch, storage, notification, and execution.

**Tech Stack:** TypeScript 5 (ESM, Node 22), viem v2, better-sqlite3, yaml, dotenv, pino, nodemailer, vitest, tsx

---

## Plan Files

| File | Contents |
|------|----------|
| `00-overview.md` | This file: architecture, file map, dependency order |
| `01-phase1-scaffold.md` | Tasks 1–5: npm setup, types, config, logger, storage |
| `02-phase2-clients.md` | Tasks 6–9: circuit-breaker, retry, CoinGecko, DeBank, RPC |
| `03-phase3-aerodrome.md` | Tasks 10–18: all monitors, alerts, orders, index |
| `04-phase4-execution.md` | Tasks 19–24: executor, DRY_RUN, notifiers |
| `05-phase5-engine.md` | Tasks 25–26: engine, main.ts |
| `06-phase6-operations.md` | Tasks 27–28: launchd, CLAUDE.md |

---

## Full File Map

```
monitor/
├── configs/
│   ├── monitor.yaml          # Non-secret config (thresholds, addresses, intervals)
│   └── .env.example          # Secret template (API keys, private key)
├── data/                     # SQLite DB — gitignored
├── docs/superpowers/plans/   # This directory
├── src/
│   ├── core/
│   │   ├── types.ts              # ALL shared interfaces and enums (written first, frozen early)
│   │   ├── config.ts             # YAML + .env loading, typed config struct, validation
│   │   ├── logger.ts             # pino instance, export default logger
│   │   ├── engine.ts             # Main loop: register monitors, poll, dispatch orders/alerts
│   │   ├── circuit-breaker.ts    # Generic circuit breaker (closed → open → half-open)
│   │   ├── retry.ts              # Exponential backoff with jitter
│   │   ├── clients/
│   │   │   ├── coingecko.ts      # CoinGecko Pro REST client + TTL cache
│   │   │   ├── debank.ts         # DeBank Pro REST client + TTL cache
│   │   │   └── rpc.ts            # viem createPublicClient for Base
│   │   ├── storage/
│   │   │   ├── index.ts          # SQLite open, schema migration, retention cleanup
│   │   │   └── queries.ts        # Typed insert/select for all 6 tables
│   │   ├── executor/
│   │   │   ├── index.ts          # Live executor: sign + broadcast via viem walletClient
│   │   │   └── dry-run.ts        # DRY_RUN executor: eth_call simulate, log, skip
│   │   └── notify/
│   │       ├── notifier.ts       # Parallel send, retry, fallback to local log
│   │       ├── serverchan.ts     # ServerChan HTTP push
│   │       ├── email.ts          # Gmail SMTP via nodemailer
│   │       └── healthchecks.ts   # Healthchecks.io heartbeat (GET ping URL)
│   ├── protocols/
│   │   └── aerodrome/
│   │       ├── index.ts          # Implements Monitor interface; assembles all sub-monitors
│   │       ├── alerts.ts         # evaluateAlerts(): 5 rules, state machine, multi-source confirm
│   │       ├── orders.ts         # generateWithdrawalOrders(): 3-step ExecutionOrder[]
│   │       └── monitors/
│   │           ├── price.ts      # msUSD price: CoinGecko primary → Aerodrome TWAP fallback
│   │           ├── pool.ts       # Pool reserves, msUSD ratio, buys/sells (CoinGecko)
│   │           ├── supply.ts     # msUSD totalSupply via RPC (every 60s)
│   │           ├── position.ts   # User LP position value via DeBank
│   │           ├── protocol.ts   # Metronome protocol TVL via DeBank
│   │           └── wallets.ts    # Team wallet holdings via DeBank (insider exit signal)
│   └── main.ts                   # Entry: load config → init → register → start engine
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
└── CLAUDE.md
```

---

## Dependency Order

Tasks must be implemented in this order — each line depends on everything above it:

```
types.ts
  └── config.ts, logger.ts
        └── storage/ (uses logger)
              └── circuit-breaker.ts, retry.ts
                    └── clients/ (use circuit-breaker + retry)
                          └── protocols/aerodrome/monitors/ (use clients)
                                └── protocols/aerodrome/alerts.ts (uses monitor outputs)
                                      └── protocols/aerodrome/orders.ts (uses alert)
                                            └── protocols/aerodrome/index.ts (assembles all)
                                                  └── executor/ (uses types)
                                                        └── notify/ (uses types)
                                                              └── engine.ts (uses all of above)
                                                                    └── main.ts
```

---

## Invariants to Enforce Throughout

1. **Never throw inside `poll()`** — catch all errors internally, return degraded `PollResult`
2. **Never crash the process** — `uncaughtException` and `unhandledRejection` must be caught in main
3. **DRY_RUN is a first-class mode** — every execution path must check `config.global.dryRun`
4. **bigint for all on-chain amounts** — never use `number` for token amounts or gas
5. **Dates as `Date` objects internally, ISO strings in SQLite** — no unix timestamps in DB
6. **tsconfig strictness** — `noUncheckedIndexedAccess: true` means `arr[0]` returns `T | undefined`; always guard

---

## Verification Checkpoints

| After Phase | Test command | Expected |
|-------------|-------------|----------|
| Phase 1 | `npm run typecheck && npm test` | 0 errors, storage tests green |
| Phase 2 | `npm test` | circuit-breaker + client tests green |
| Phase 3 | `npm test` | all aerodrome unit tests green |
| Phase 4 | `npm test` | executor + notifier tests green |
| Phase 5 | `DRY_RUN=true npm start` | bot starts, polls, logs signals |
| Phase 6 | `launchctl load com.defi.monitor.plist` | daemon running on Mac mini |
