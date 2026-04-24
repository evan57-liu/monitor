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
