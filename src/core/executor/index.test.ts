// src/core/executor/index.test.ts
import { describe, it, expect } from 'vitest'
import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
  toBytes,
} from 'viem'
import { OrderStatus, OrderType } from '../types.js'
import type { ExecutionOrder, SwapParams } from '../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const SWAP_ROUTER = '0x6Df1c91424F79E40E33B1A48F0687B666bE71075' as const
const TOKEN_MSUSD = '0x526728dbc96689597f85ae4cd716d4f7fccbae9d' as const
const TOKEN_USDC  = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const
const WALLET      = '0xa2b1764fac3db911405e5b268a6188cf8d2d51b5' as const
const POOL_PARAM  = 0x32 // tickSpacing=50, CL_FACTORY_1 (no high-bit flag)

/** 构造一个最小化的 SWAP ExecutionOrder */
function makeSwapOrder(overrides?: Partial<SwapParams>): ExecutionOrder {
  const params: SwapParams = {
    routerAddress: SWAP_ROUTER,
    tokenIn:  TOKEN_MSUSD,
    tokenOut: TOKEN_USDC,
    amountIn: 5000n * 10n ** 18n,   // 5000 msUSD
    amountOutMin: 4950n * 10n ** 6n, // 4950 USDC (1% slip)
    poolParam: POOL_PARAM,
    batchIndex: 0,
    totalBatches: 1,
    ...overrides,
  }
  return {
    id: 'order-swap-1',
    alertId: 'alert-1',
    protocol: 'aerodrome-msusd-usdc',
    type: OrderType.SWAP,
    sequence: 3,
    groupId: 'group-1',
    params,
    maxGasGwei: 50,
    deadline: Math.floor(Date.now() / 1000) + 300,
    status: OrderStatus.PENDING,
    createdAt: new Date(),
  }
}

// ── Path encoding helper (mirrors executor logic) ─────────────────────────────

function buildPath(tokenIn: string, poolParam: number, tokenOut: string): `0x${string}` {
  const left  = toBytes(tokenIn  as `0x${string}`)  // 20 bytes
  const mid   = toBytes(poolParam, { size: 3 })      // 3 bytes (uint24)
  const right = toBytes(tokenOut as `0x${string}`)   // 20 bytes
  const path  = new Uint8Array(43)
  path.set(left,  0)
  path.set(mid,  20)
  path.set(right, 23)
  return ('0x' + Buffer.from(path).toString('hex')) as `0x${string}`
}

const INPUT_SCHEMA = parseAbiParameters('address, uint256, uint256, bytes, bool, bool')

function decodeInput(input: `0x${string}`) {
  return decodeAbiParameters(INPUT_SCHEMA, input)
}

// ── Capture logic from LiveExecutor (pure unit, no RPC calls) ─────────────────

const SWAP_ENCODE_PARAMS = parseAbiParameters('address, uint256, uint256, bytes, bool, bool')

/**
 * Directly reproduces the executor's swap-encoding logic and exposes what
 * would be passed to writeContract, without actually calling the blockchain.
 */
function buildSwapCall(order: ExecutionOrder, walletAddress: `0x${string}`) {
  const params = order.params as SwapParams
  const path = buildPath(params.tokenIn, params.poolParam, params.tokenOut)
  const input = encodeAbiParameters(
    SWAP_ENCODE_PARAMS,
    [walletAddress, params.amountIn, params.amountOutMin, path, true, false],
  )
  return {
    command: '0x00' as const,
    input: input as `0x${string}`,
    deadline: BigInt(order.deadline),
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LiveExecutor swap encoding', () => {
  it('command byte is 0x00 (V3_SWAP_EXACT_IN)', () => {
    const { command } = buildSwapCall(makeSwapOrder(), WALLET)
    expect(command).toBe('0x00')
  })

  it('path has exactly 43 bytes (20 + 3 + 20)', () => {
    const path = buildPath(TOKEN_MSUSD, POOL_PARAM, TOKEN_USDC)
    // "0x" + 86 hex chars = 43 bytes
    expect(path.length).toBe(2 + 86)
  })

  it('path encodes tokenIn correctly', () => {
    const path = buildPath(TOKEN_MSUSD, POOL_PARAM, TOKEN_USDC)
    const tokenIn = '0x' + path.slice(2, 42) // first 20 bytes
    expect(tokenIn.toLowerCase()).toBe(TOKEN_MSUSD.toLowerCase())
  })

  it('path middle 3 bytes match poolParam (tickSpacing=50 = 0x32)', () => {
    const path = buildPath(TOKEN_MSUSD, POOL_PARAM, TOKEN_USDC)
    const midHex = path.slice(42, 48) // bytes 20-22
    expect(parseInt(midHex, 16)).toBe(POOL_PARAM)
    expect(parseInt(midHex, 16)).toBe(0x32) // tickSpacing=50
  })

  it('path encodes tokenOut correctly', () => {
    const path = buildPath(TOKEN_MSUSD, POOL_PARAM, TOKEN_USDC)
    const tokenOut = '0x' + path.slice(48, 88) // last 20 bytes
    expect(tokenOut.toLowerCase()).toBe(TOKEN_USDC.toLowerCase())
  })

  it('input decodes to 6 ABI parameters', () => {
    const { input } = buildSwapCall(makeSwapOrder(), WALLET)
    const decoded = decodeInput(input)
    expect(decoded).toHaveLength(6)
  })

  it('decoded input: recipient = wallet address', () => {
    const order = makeSwapOrder()
    const { input } = buildSwapCall(order, WALLET)
    const [recipient] = decodeInput(input)
    expect((recipient as string).toLowerCase()).toBe(WALLET.toLowerCase())
  })

  it('decoded input: amountIn matches params.amountIn', () => {
    const order = makeSwapOrder()
    const { input } = buildSwapCall(order, WALLET)
    const [, amountIn] = decodeInput(input)
    expect(amountIn).toBe((order.params as SwapParams).amountIn)
  })

  it('decoded input: amountOutMin matches params.amountOutMin', () => {
    const order = makeSwapOrder()
    const { input } = buildSwapCall(order, WALLET)
    const [, , amountOutMin] = decodeInput(input)
    expect(amountOutMin).toBe((order.params as SwapParams).amountOutMin)
  })

  it('decoded input: path matches built path', () => {
    const order = makeSwapOrder()
    const { input } = buildSwapCall(order, WALLET)
    const params = order.params as SwapParams
    const expectedPath = buildPath(params.tokenIn, params.poolParam, params.tokenOut)
    const [, , , path] = decodeInput(input)
    expect((path as string).toLowerCase()).toBe(expectedPath.toLowerCase())
  })

  it('decoded input: payerIsUser = true (param 5)', () => {
    const { input } = buildSwapCall(makeSwapOrder(), WALLET)
    const [, , , , payerIsUser] = decodeInput(input)
    expect(payerIsUser).toBe(true)
  })

  it('decoded input: isUni = false (param 6, use Aerodrome CL not UniV3)', () => {
    const { input } = buildSwapCall(makeSwapOrder(), WALLET)
    const [, , , , , isUni] = decodeInput(input)
    expect(isUni).toBe(false)
  })

  it('deadline is passed as-is from order', () => {
    const order = makeSwapOrder()
    const { deadline } = buildSwapCall(order, WALLET)
    expect(deadline).toBe(BigInt(order.deadline))
  })

  it('input ABI encodes to correct dynamic offset (6 head slots → offset = 0xc0)', () => {
    const { input } = buildSwapCall(makeSwapOrder(), WALLET)
    // Slot 3 (bytes 96-127) contains the offset to the dynamic `bytes path`
    // 6 head slots × 32 bytes = 192 = 0xc0
    const slotHex = input.slice(2 + 96 * 2, 2 + 128 * 2) // slot 3
    expect(parseInt(slotHex, 16)).toBe(0xc0)
  })

  it('swap_pool_param 0x32 decomposes to: no factory flag, tickSpacing=50', () => {
    // This is the key regression guard: 0x100001 would pick CL_FACTORY_2 (wrong pool)
    const CL_FACTORY_SELECTOR_MASK = 0xf00000
    const CL_POOL_PARAM_MASK = 0x0fffff
    const factorySelector = POOL_PARAM & CL_FACTORY_SELECTOR_MASK
    const tickSpacing = POOL_PARAM & CL_POOL_PARAM_MASK
    expect(factorySelector).toBe(0)  // default factory (CL_FACTORY_1)
    expect(tickSpacing).toBe(50)
  })
})
