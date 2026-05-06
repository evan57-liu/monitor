import { parseAbi } from 'viem'

export const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
])

export const PERMIT2_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
])

export const check = (cond: boolean) => (cond ? '✓' : '✗')

export const toDate = (ts: number | bigint) => {
  if (!ts) return 'NEVER_SET'
  const ms = Number(ts) * 1000
  if (ms > 8_640_000_000_000_000) return 'MAX (never expires)'
  return new Date(ms).toISOString()
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
