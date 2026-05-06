/**
 * 一次性 Permit2 授权脚本
 *
 * 为 Universal Router 通过 Aerodrome Permit2 拉取 msUSD/USDC 设置所需的两层授权：
 *   ① token.approve(Permit2, MAX)          — ERC20 → Permit2
 *   ② Permit2.approve(token, Router, MAX, MAX_EXPIRY) — Permit2 → Router
 *
 * 脚本是幂等的：若当前状态已满足要求则跳过，不重复发交易。
 *
 * Usage:
 *   npx tsx scripts/setup-permit2.ts              # dry-run：仅打印操作计划
 *   npx tsx scripts/setup-permit2.ts --execute    # 实际发送交易
 *   npx tsx scripts/setup-permit2.ts --simulate-swap  # dry-run + 模拟一次 swap 验证授权
 */

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  maxUint160,
  maxUint256,
  numberToHex,
  concat,
  parseAbi,
  parseAbiParameters,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { loadConfig } from '../src/core/config.js'
import { check, toDate, sleep, ERC20_ABI, PERMIT2_ABI } from './utils.js'

const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
  'error AllowanceExpired(uint256 deadline)',
  'error InsufficientAllowance(uint256 amount)',
  'error V3InvalidSwap()',
  'error V3TooLittleReceived()',
])

const SWAP_INPUT_PARAMS = parseAbiParameters('address, uint256, uint256, bytes, bool, bool')

const MAX_EXPIRATION = 2n ** 48n - 1n

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const execute = process.argv.includes('--execute')
  const simulateSwap = process.argv.includes('--simulate-swap')

  const cfg = loadConfig('configs/monitor.yaml', 'configs/.env')
  const ae = cfg.protocols.aerodromeMusdUsdc

  const permit2 = ae.permit2Address as `0x${string}`
  const router = ae.routerAddress as `0x${string}`

  const tokens = [
    { name: 'msUSD', address: ae.msUsdAddress as `0x${string}` },
    { name: 'USDC',  address: ae.usdcAddress as `0x${string}`  },
  ]

  const account = privateKeyToAccount(cfg.secrets.privateKey as `0x${string}`)
  const transport = http(cfg.sources.rpc.base.url)
  const publicClient = createPublicClient({ chain: base, transport })
  const walletClient = execute
    ? createWalletClient({ account, chain: base, transport })
    : null

  // 开始时取一次 nonce，之后每发一笔交易手动 +1，避免 RPC 节点延迟返回旧值
  let nonce = execute
    ? await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
    : 0

  console.log(`\nSetup Permit2 for Aerodrome Universal Router`)
  console.log(`Wallet   : ${account.address}`)
  console.log(`Permit2  : ${permit2}  (Aerodrome fork — NOT 0x000…022D)`)
  console.log(`Router   : ${router}`)
  console.log(`Mode     : ${execute ? 'EXECUTE (will send transactions)' : 'DRY-RUN  (read-only, pass --execute to send)'}`)
  console.log()

  // ── Step 1 & 2 per token ───────────────────────────────────────────────────

  for (const tok of tokens) {
    console.log(`── ${tok.name} (${tok.address}) ──`)

    // Step 1: ERC20 → Permit2
    const erc20Allow = await publicClient.readContract({
      address: tok.address,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, permit2],
    })
    const erc20Ok = erc20Allow >= maxUint256 / 2n
    console.log(`  ${check(erc20Ok)} ERC20.allowance(wallet → Permit2) = ${erc20Ok ? 'MAX' : erc20Allow.toString()}`)

    if (!erc20Ok) {
      console.log(`  → NEED: ${tok.name}.approve(Permit2, MAX)`)
      if (execute && walletClient) {
        const tx = await walletClient.writeContract({
          address: tok.address, abi: ERC20_ABI, functionName: 'approve',
          args: [permit2, maxUint256], nonce,
        })
        nonce++
        console.log(`  → TX: ${tx}`)
        await publicClient.waitForTransactionReceipt({ hash: tx })
        console.log(`  → Confirmed`)
      }
    }

    // Step 2: Permit2 → Router
    const [p2Amount, p2Expiration] = await publicClient.readContract({
      address: permit2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [account.address, tok.address, router],
    })
    const p2Valid = p2Amount >= maxUint160 / 2n && BigInt(p2Expiration) > BigInt(Math.floor(Date.now() / 1000) + 86400)
    console.log(`  ${check(p2Valid)} Permit2.allowance(wallet, ${tok.name}, Router) = amount=${p2Amount} exp=${p2Expiration} (${toDate(p2Expiration)})`)

    if (!p2Valid) {
      console.log(`  → NEED: Permit2.approve(${tok.name}, Router, MAX, MAX_EXPIRY)`)
      if (execute && walletClient) {
        const tx = await walletClient.writeContract({
          address: permit2, abi: PERMIT2_ABI, functionName: 'approve',
          args: [tok.address, router, maxUint160, Number(MAX_EXPIRATION)], nonce,
        })
        nonce++
        console.log(`  → TX: ${tx}`)
        await publicClient.waitForTransactionReceipt({ hash: tx })
        console.log(`  → Confirmed`)
      }
    }
    console.log()
  }

  // ── Final status ───────────────────────────────────────────────────────────

  if (execute) {
    console.log('── Final allowance status (post-setup) ──')
    for (const tok of tokens) {
      try {
        await sleep(500)
        const [erc20Allow, [p2Amount, p2Expiration]] = await Promise.all([
          publicClient.readContract({ address: tok.address, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, permit2] }),
          publicClient.readContract({ address: permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account.address, tok.address, router] }),
        ])
        console.log(`  ${tok.name}: ERC20→P2=${erc20Allow >= maxUint256 / 2n ? 'MAX' : erc20Allow} | P2→Router amount=${p2Amount} exp=${toDate(p2Expiration)}`)
      } catch {
        console.log(`  ${tok.name}: (rate limited, skip verification — re-run without --execute to check)`)
      }
    }
    console.log()
  }

  // ── Optional: simulate swap ────────────────────────────────────────────────

  if (simulateSwap) {
    // Note: some public RPC nodes don't propagate inner-call reverts in eth_call,
    // so a "success" here may be a false positive. The real test is --execute.
    console.log('── Simulating 1 msUSD → USDC swap (false positives possible on public RPC) ──')
    const oneToken = 10n ** 18n // 1 msUSD (18 decimals)
    const path = concat([
      ae.msUsdAddress as `0x${string}`,
      numberToHex(ae.execution.swapPoolParam, { size: 3 }),
      ae.usdcAddress as `0x${string}`,
    ])
    const input = encodeAbiParameters(SWAP_INPUT_PARAMS, [account.address, oneToken, 0n, path, true, false])
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300)
    try {
      const result = await publicClient.simulateContract({
        address: router,
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: 'execute',
        args: ['0x00', [input], deadline],
        account: account.address,
      })
      console.log(`  ✓ Simulation succeeded, result:`, result.result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ✗ Simulation failed: ${msg}`)
    }
    console.log()
  }

  if (!execute) {
    console.log('Dry-run complete. Run with --execute to send the above transactions.')
  } else {
    console.log('Setup complete.')
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
