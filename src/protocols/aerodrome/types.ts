// src/protocols/aerodrome/types.ts
// Aerodrome 监控器的内部信号类型。不从 core/types.ts 导出，
// 因为这些类型是协议特有的。

export interface PriceSignal {
  coingecko: number | null    // null = 数据源不可用
  twap: number | null
  fetchedAt: Date
}

export interface PoolSignal {
  reserveInUsd: number
  msUsdRatio: number          // 0-1：msUSD 在池中的占比（由 RPC balanceOf 计算）
  poolPriceUsd: number        // GeckoTerminal 池内推导的 msUSD 价格，与 coingecko 交叉验证
  buys1h: number
  sells1h: number
  volume24h: number
  fetchedAt: Date
}

export interface SupplySignal {
  totalSupply: bigint
  previousSupply: bigint | null  // 首次读取时为 null
  fetchedAt: Date
}

export interface PositionSignal {
  netUsdValue: number
  rewardUsdValue: number           // AERO 等奖励的 USD 价值（透明拆分）
  previousNetUsdValue: number | null
  debankMsUsdPrice: number | null  // DeBank 返回的 msUSD 价格，null = 数据不可用
  fetchedAt: Date
}

export interface ProtocolSignal {
  tvlUsd: number
  previousTvlUsd: number | null
  fetchedAt: Date
}

export interface WalletSignal {
  walletAddress: string
  msUsdAmount: number
  msUsdUsdValue: number
  previousMsUsdAmount: number | null
  fetchedAt: Date
}

export interface AllSignals {
  price: PriceSignal | null
  pool: PoolSignal | null
  supply: SupplySignal | null
  position: PositionSignal | null
  protocol: ProtocolSignal | null
  wallets: WalletSignal[] | null
}
