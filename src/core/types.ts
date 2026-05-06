// src/core/types.ts
// 整个系统的核心契约。所有接口和枚举均定义于此。
// 其他模块从本文件导入。本文件不从项目中导入任何内容。
//
// 注意：tsconfig 已启用 exactOptionalPropertyTypes。
// 可选字段（如 txHash?: string）必须省略，不能设为 undefined。
// 使用条件展开：{ ...(txHash != null && { txHash }) }
//
// 注意：ExecutionOrder.params 是一个无标签联合类型，通过 order.type 收窄。
// 消费方必须对 order.type 使用 switch，并配合类型断言（如 params as UnstakeParams）。
// 这是一种已接受的设计取舍——type+params 的配对由订单生成层（orders.ts）而非类型层保证。

// ── 枚举 ──────────────────────────────────────────────────────────────────────

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
  WITHDRAWAL_ABORTED = 'withdrawal_aborted',
}

export enum OrderType {
  UNSTAKE = 'unstake',
  REMOVE_LIQUIDITY = 'remove_liquidity',
  SWAP = 'swap',
  PRICE_FLOOR_GUARD = 'price_floor_guard',
}

export enum OrderStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  SKIPPED_DRY_RUN = 'skipped_dry_run',
}

// ── 监控器 ────────────────────────────────────────────────────────────────────

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
  /** null 表示主数据源处于活跃状态 */
  fallbackActive: string | null
}

// ── 告警 ──────────────────────────────────────────────────────────────────────

export interface Alert {
  id: string
  type: AlertType
  level: AlertLevel
  protocol: string
  title: string
  /** Markdown 格式的通知详情 */
  message: string
  /** 结构化的证据数据，用于存储 */
  data: Record<string, unknown>
  triggeredAt: Date
  confirmations: number
  requiredConfirmations: number
  sustainedMs: number
  requiredSustainedMs: number
}

// ── 执行订单 ──────────────────────────────────────────────────────────────────

export interface ExecutionOrder {
  id: string
  alertId: string
  protocol: string
  type: OrderType
  /** 撤出组内从 1 开始的执行序号 */
  sequence: number
  /** 相同 groupId 的订单按顺序执行；失败则中止 */
  groupId: string
  params: UnstakeParams | RemoveLiquidityParams | SwapParams | PriceFloorGuardParams
  /** 超过此 Gas 价格（gwei）拒绝执行 */
  maxGasGwei: number
  /** 交易的 Unix 时间戳截止时间 */
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
  /** 基点，例如 100 = 1% */
  slippageBps: number
  /** 移除流动性并收取代币后销毁 NFT position，默认 true */
  burnAfterRemove?: boolean
}

export interface SwapParams {
  routerAddress: `0x${string}`
  tokenIn: `0x${string}`
  tokenOut: `0x${string}`
  amountIn: bigint
  amountOutMin: bigint
  /** Universal Router path 中的 3 字节 poolParam（CL factory 标志位 | tickSpacing） */
  poolParam: number
  batchIndex: number
  totalBatches: number
}

export interface PriceFloorGuardParams {
  poolAddress: `0x${string}`
  token0Decimals: number
  token1Decimals: number
  twapWindowSeconds: number
  floor: number
  failClosed: boolean
}

// ── 通知 ──────────────────────────────────────────────────────────────────────

export interface NotificationChannel {
  readonly name: string
  /** 投递成功返回 true，失败返回 false。不得抛出异常。 */
  send(notification: Notification): Promise<boolean>
  test(): Promise<boolean>
}

export interface Notification {
  title: string
  /** Markdown 格式的正文 */
  body: string
  level: AlertLevel
  metadata?: Record<string, unknown>
}

// ── 执行器 ────────────────────────────────────────────────────────────────────

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
