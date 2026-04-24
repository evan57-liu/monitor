// src/protocols/aerodrome/types.ts
// Internal signal types for the aerodrome monitor. Not exported from core/types.ts
// because they are protocol-specific.

export interface PriceSignal {
  coingecko: number | null    // null = source unavailable
  twap: number | null
  fetchedAt: Date
}

export interface PoolSignal {
  reserveInUsd: number
  msUsdRatio: number          // 0-1: proportion of msUSD in pool
  buys1h: number
  sells1h: number
  volume24h: number
  fetchedAt: Date
}

export interface SupplySignal {
  totalSupply: bigint
  previousSupply: bigint | null  // null on first reading
  fetchedAt: Date
}

export interface PositionSignal {
  netUsdValue: number
  previousNetUsdValue: number | null
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
