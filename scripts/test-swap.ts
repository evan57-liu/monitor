/**
 * 真实 msUSD → USDC swap 测试脚本
 *
 * 执行顺序：
 *   1. 读链上 allowance，打印两层授权状态
 *   2. simulateContract 预检（不发交易，捕获可解码的 revert）
 *   3. --execute 时发真实交易，等待 receipt
 *
 * Usage:
 *   npx tsx scripts/test-swap.ts                     # dry-run：模拟 + 打印
 *   npx tsx scripts/test-swap.ts --execute           # 真实 swap
 *   npx tsx scripts/test-swap.ts --amount 10         # 指定 msUSD 金额（默认 1）
 *   npx tsx scripts/test-swap.ts --execute --amount 5
 */

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  maxUint160,
  maxUint256,
  parseAbi,
  parseAbiParameters,
  concat,
  numberToHex,
  parseUnits,
  formatUnits,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { loadConfig } from '../src/core/config.js'
import { check, toDate, sleep, ERC20_ABI, PERMIT2_ABI } from './utils.js'

// ── ABIs ──────────────────────────────────────────────────────────────────────

const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  'error V3InvalidSwap()',
  'error V3TooLittleReceived()',
  'error V3TooMuchRequested()',
  'error V3InvalidAmountOut()',
  'error V3InvalidCaller()',
  'error TransactionDeadlinePassed()',
  'error ExecutionFailed(uint256 commandIndex, bytes message)',
  'error BalanceTooLow()',
])

const SWAP_INPUT_PARAMS = parseAbiParameters('address, uint256, uint256, bytes, bool, bool')

const CMD_V3_SWAP_EXACT_IN = '0x00' as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAmountArg(args: string[]): number {
  const idx = args.indexOf('--amount')
  if (idx !== -1 && args[idx + 1]) return parseFloat(args[idx + 1]!)
  return 1
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const execute = args.includes('--execute')
  const amountMsUsd = parseAmountArg(args)

  const cfg = loadConfig('configs/monitor.yaml', 'configs/.env')
  const ae = cfg.protocols.aerodromeMusdUsdc

  const permit2 = ae.permit2Address as `0x${string}`
  const router  = ae.routerAddress  as `0x${string}`
  const msUsd   = ae.msUsdAddress   as `0x${string}`
  const usdc    = ae.usdcAddress    as `0x${string}`
  const poolParam = ae.execution.swapPoolParam // 0x32

  const account = privateKeyToAccount(cfg.secrets.privateKey as `0x${string}`)
  const transport = http(cfg.sources.rpc.base.url)
  const publicClient = createPublicClient({ chain: base, transport })
  const walletClient = execute
    ? createWalletClient({ account, chain: base, transport })
    : null

  const amountIn    = parseUnits(String(amountMsUsd), 18) // msUSD 18 decimals
  const amountOutMin = 0n // 测试用，接受任意输出；生产中应设 1% 滑点下限

  console.log(`\n── Aerodrome swap test: ${amountMsUsd} msUSD → USDC ──`)
  console.log(`Wallet  : ${account.address}`)
  console.log(`Permit2 : ${permit2}`)
  console.log(`Router  : ${router}`)
  console.log(`Mode    : ${execute ? 'EXECUTE (real transaction)' : 'DRY-RUN  (simulate only)'}`)
  console.log()

  // ── 1. Balance check ─────────────────────────────────────────────────────

  const [msUsdBalance, usdcBalance] = await Promise.all([
    publicClient.readContract({ address: msUsd, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: usdc,  abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])
  console.log(`── Balances ──`)
  console.log(`  msUSD : ${formatUnits(msUsdBalance, 18)}`)
  console.log(`  USDC  : ${formatUnits(usdcBalance,  6)}`)

  if (msUsdBalance < amountIn) {
    console.error(`  ✗ Insufficient msUSD: have ${formatUnits(msUsdBalance, 18)}, need ${amountMsUsd}`)
    process.exit(1)
  }
  console.log()

  // ── 2. Allowance check ───────────────────────────────────────────────────

  const [erc20Allow, [p2Amount, p2Expiration]] = await Promise.all([
    publicClient.readContract({ address: msUsd, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, permit2] }),
    publicClient.readContract({ address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, msUsd, router] }),
  ])

  const erc20Ok = erc20Allow >= maxUint256 / 2n
  const p2Ok    = p2Amount >= maxUint160 / 2n && BigInt(p2Expiration) > BigInt(Math.floor(Date.now() / 1000) + 86400)

  console.log(`── Permit2 allowance (msUSD) ──`)
  console.log(`  ${check(erc20Ok)} ERC20  → Permit2 : ${erc20Ok ? 'MAX' : erc20Allow.toString()}`)
  console.log(`  ${check(p2Ok)}   Permit2 → Router  : amount=${p2Amount} exp=${p2Expiration} (${toDate(p2Expiration)})`)

  if (!erc20Ok || !p2Ok) {
    console.error(`\n  ✗ Permit2 not set up. Run: npx tsx scripts/setup-permit2.ts --execute`)
    process.exit(1)
  }
  console.log()

  // ── 3. Build swap call ───────────────────────────────────────────────────

  const path = concat([
    msUsd,
    numberToHex(poolParam, { size: 3 }),
    usdc,
  ])

  const input = encodeAbiParameters(SWAP_INPUT_PARAMS, [
    account.address, amountIn, amountOutMin, path, true, false,
  ])

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)

  const callArgs = {
    address: router,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute' as const,
    args: [CMD_V3_SWAP_EXACT_IN, [input], deadline] as const,
    account: account.address,
  }

  // ── 4. Simulate ──────────────────────────────────────────────────────────

  console.log(`── Simulating swap ──`)
  console.log(`  amountIn    : ${amountMsUsd} msUSD (${amountIn.toString()} wei)`)
  console.log(`  amountOutMin: 0 (test mode, no slippage guard)`)
  console.log(`  poolParam   : 0x${poolParam.toString(16)} (tickSpacing=50, CL_FACTORY_1)`)
  console.log(`  deadline    : ${new Date(Number(deadline) * 1000).toISOString()}`)

  try {
    await publicClient.simulateContract(callArgs)
    console.log(`  ✓ Simulation succeeded`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`  ✗ Simulation failed: ${msg}`)
    if (!execute) {
      console.log(`\nDry-run ended (simulation failed). Check allowances and pool status.`)
      process.exit(1)
    }
    console.log(`  ⚠️  Simulation failed but --execute passed — proceeding anyway (simulation on public RPC can be unreliable)`)
  }
  console.log()

  // ── 5. Execute ───────────────────────────────────────────────────────────

  if (!execute || !walletClient) {
    console.log(`Dry-run complete. Pass --execute to send real transaction.`)
    return
  }

  console.log(`── Sending transaction ──`)
  const txHash = await walletClient.writeContract({
    address: router,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: [CMD_V3_SWAP_EXACT_IN, [input], deadline],
    account,
  })
  console.log(`  TX: https://basescan.org/tx/${txHash}`)
  console.log(`  Waiting for receipt...`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
  console.log(`  Status : ${receipt.status}`)
  console.log(`  Gas    : ${receipt.gasUsed.toString()}`)

  console.log(`\n── Result ──`)
  if (receipt.status === 'success') {
    try {
      await sleep(1000)
      const [msUsdAfter, usdcAfter] = await Promise.all([
        publicClient.readContract({ address: msUsd, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
        publicClient.readContract({ address: usdc,  abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
      ])
      const usdcReceived = usdcAfter - usdcBalance
      console.log(`  msUSD spent   : ${formatUnits(msUsdBalance - msUsdAfter, 18)}`)
      console.log(`  USDC received : ${formatUnits(usdcReceived, 6)}`)
      console.log(`  Effective rate: ${(Number(formatUnits(usdcReceived, 6)) / amountMsUsd).toFixed(6)}`)
    } catch {
      console.log(`  ✓ Swap confirmed (rate limited when reading final balances — check Basescan)`)
    }
  } else {
    console.error(`  ✗ Transaction reverted`)
  }
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
