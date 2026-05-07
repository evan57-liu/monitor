/**
 * 完整撤出流程集成测试
 *
 * 按顺序调用真实的 LiveExecutor：unstake → remove_liquidity → swap
 * remove_liquidity 完成后自动读取链上实际 msUSD 余额，再生成精确的 swap 订单。
 *
 * Usage:
 *   npx tsx scripts/test-withdrawal.ts                        # 全流程（含确认提示）
 *   npx tsx scripts/test-withdrawal.ts --steps unstake        # 仅取消质押
 *   npx tsx scripts/test-withdrawal.ts --steps remove         # 仅移除流动性
 *   npx tsx scripts/test-withdrawal.ts --steps swap           # 仅 swap（读取当前钱包余额）
 *   npx tsx scripts/test-withdrawal.ts --steps swap --msUsd 100  # 指定 swap 金额
 *   npx tsx scripts/test-withdrawal.ts --no-confirm           # 跳过确认提示
 *   npx tsx scripts/test-withdrawal.ts --price 0.998          # 指定有效价格（用于 amountOutMin 计算）
 */

import { createPublicClient, http, parseAbi, formatUnits, parseUnits, nonceManager } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { resolve } from 'node:path'
import * as readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { loadConfig } from '../src/core/config.js'
import { initLogger } from '../src/core/logger.js'
import { LiveExecutor } from '../src/core/executor/index.js'
import { generateWithdrawalOrders } from '../src/protocols/aerodrome/orders.js'
import { AlertLevel, AlertType, OrderStatus } from '../src/core/types.js'
import type { Alert, ExecutionOrder } from '../src/core/types.js'

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const getArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i !== -1 ? argv[i + 1] : undefined
}

const stepsArg  = getArg('--steps') ?? 'all'   // 'all' | 'unstake' | 'remove' | 'swap'
const msUsdArg  = getArg('--msUsd')             // e.g. '100.5'（仅 swap 步骤使用）
const priceArg  = getArg('--price') ?? '1.0'    // 有效价格，用于 amountOutMin 计算
const noConfirm = argv.includes('--no-confirm')

const VALID_STEPS = ['all', 'unstake', 'remove', 'swap']
if (!VALID_STEPS.includes(stepsArg)) {
  console.error(`Unknown --steps value: ${stepsArg}. Valid: ${VALID_STEPS.join(', ')}`)
  process.exit(1)
}

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) external view returns (uint256)',
])

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAlert(): Alert {
  return {
    id: crypto.randomUUID(),
    type: AlertType.POSITION_DROP,
    level: AlertLevel.RED,
    protocol: 'aerodrome-msusd-usdc',
    title: '[test-withdrawal] manual withdrawal test',
    message: 'Manual withdrawal triggered via test-withdrawal.ts script',
    data: {},
    triggeredAt: new Date(),
    confirmations: 1,
    requiredConfirmations: 1,
    sustainedMs: 0,
    requiredSustainedMs: 0,
  }
}

async function confirm(rl: readline.Interface, prompt: string): Promise<boolean> {
  if (noConfirm) return true
  const answer = await rl.question(`${prompt} [y/N] `)
  return answer.trim().toLowerCase() === 'y'
}

async function execAndReport(
  executor: LiveExecutor,
  order: ExecutionOrder,
  label: string,
): Promise<boolean> {
  console.log(`\n→ Executing: ${label}`)
  const result = await executor.execute(order)
  const ok = result.status === OrderStatus.CONFIRMED
  if (ok) {
    const txInfo = result.txHash ? `  TX: https://basescan.org/tx/${result.txHash}` : '  (no tx)'
    const gasInfo = result.gasUsed ? `  Gas: ${result.gasUsed}` : ''
    console.log(`  Status: CONFIRMED${txInfo ? '\n' + txInfo : ''}${gasInfo ? '\n' + gasInfo : ''}`)
  } else {
    console.error(`  Status: FAILED — ${result.error ?? 'unknown error'}`)
  }
  return ok
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig(
    resolve('configs', 'monitor.yaml'),
    resolve('configs', '.env'),
  )
  const ae  = cfg.protocols.aerodromeMusdUsdc
  const log = initLogger('info')

  const account = privateKeyToAccount(cfg.secrets.privateKey as `0x${string}`, { nonceManager })
  const transport = http(cfg.sources.rpc.base.url, { timeout: cfg.sources.rpc.base.timeoutMs })
  const publicClient = createPublicClient({ chain: base, transport })
  const executor = new LiveExecutor({
    privateKey: cfg.secrets.privateKey,
    rpcUrl: cfg.sources.rpc.base.url,
    rpcTimeoutMs: cfg.sources.rpc.base.timeoutMs,
    gasMultiplier: ae.execution.gasMultiplier,
  }, log)

  const effectivePrice = parseFloat(priceArg)
  if (isNaN(effectivePrice) || effectivePrice <= 0) {
    console.error(`Invalid --price: ${priceArg}`)
    process.exit(1)
  }

  // ── 启动摘要 ────────────────────────────────────────────────────────────────

  console.log('\n── Aerodrome Withdrawal Test ──')
  console.log(`Wallet        : ${account.address}`)
  console.log(`Steps         : ${stepsArg}`)
  console.log(`Effective price: ${effectivePrice}`)
  console.log(`Token ID      : ${ae.lpTokenId}`)
  console.log(`Gauge         : ${ae.gaugeAddress}`)
  console.log(`PositionMgr   : ${ae.positionManagerAddress}`)
  console.log(`Swap batches  : ${ae.execution.swapBatchCount}`)
  console.log(`Slippage      : ${ae.execution.swapSlippageBps} bps`)

  const [msUsdBefore, usdcBefore] = await Promise.all([
    publicClient.readContract({ address: ae.msUsdAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: ae.usdcAddress  as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ])
  console.log(`\nWallet balances:`)
  console.log(`  msUSD : ${formatUnits(msUsdBefore, 18)}`)
  console.log(`  USDC  : ${formatUnits(usdcBefore, 6)}`)

  const rl = readline.createInterface({ input, output })

  try {
    const alert = makeAlert()

    // ── Step: UNSTAKE ────────────────────────────────────────────────────────

    if (stepsArg === 'all' || stepsArg === 'unstake') {
      // 生成一个临时订单组（msUsdBalance 任意值，只取 UNSTAKE 订单）
      const dummyOrders = generateWithdrawalOrders(alert, ae, 1_000_000n * 10n ** 18n, effectivePrice)
      const unstakeOrder = dummyOrders.find(o => o.type === 'unstake')!

      const ok = await confirm(rl, `\nStep 1/3 — UNSTAKE (tokenId=${ae.lpTokenId}).\nThis will call gauge.withdraw(). Continue?`)
      if (!ok) { console.log('Aborted.'); return }

      const success = await execAndReport(executor, unstakeOrder, 'UNSTAKE')
      if (!success && stepsArg === 'all') {
        console.error('\nUnstake failed — aborting remaining steps.')
        return
      }
    }

    // ── Step: REMOVE_LIQUIDITY ───────────────────────────────────────────────

    if (stepsArg === 'all' || stepsArg === 'remove') {
      const dummyOrders = generateWithdrawalOrders(alert, ae, 1_000_000n * 10n ** 18n, effectivePrice)
      const removeOrder = dummyOrders.find(o => o.type === 'remove_liquidity')!

      const ok = await confirm(rl, `\nStep 2/3 — REMOVE_LIQUIDITY + COLLECT + BURN.\nThis will remove all liquidity from the NFT position. Continue?`)
      if (!ok) { console.log('Aborted.'); return }

      const success = await execAndReport(executor, removeOrder, 'REMOVE_LIQUIDITY')
      if (!success && stepsArg === 'all') {
        console.error('\nRemove liquidity failed — aborting remaining steps.')
        return
      }
    }

    // ── Step: SWAP ───────────────────────────────────────────────────────────

    if (stepsArg === 'all' || stepsArg === 'swap') {
      // 读取真实 msUSD 余额（remove_liquidity 完成后或用户手动指定）
      let swapBalance: bigint
      if (msUsdArg) {
        swapBalance = parseUnits(msUsdArg, 18)
        console.log(`\nUsing --msUsd ${msUsdArg} → ${swapBalance} wei`)
      } else if (stepsArg === 'all') {
        // 刚执行过 remove_liquidity：公共 RPC 节点可能对 eth_call 仍返回旧 block 的缓存。
        // 轮询直到余额超过 remove 之前的值，最多等 15 秒，每次间隔 3 秒（避免限速）。
        const POLL_INTERVAL_MS = 3_000
        const POLL_TIMEOUT_MS  = 15_000
        const pollStart = Date.now()
        console.log('\nPolling chain for updated msUSD balance after remove_liquidity...')
        while (true) {
          swapBalance = await publicClient.readContract({
            address: ae.msUsdAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [account.address],
          })
          const elapsed = Date.now() - pollStart
          if (swapBalance > msUsdBefore) {
            console.log(`  Balance: ${formatUnits(swapBalance, 18)} msUSD (confirmed after ${elapsed}ms)`)
            break
          }
          if (elapsed >= POLL_TIMEOUT_MS) {
            console.warn(`  Timed out after ${POLL_TIMEOUT_MS}ms — balance still ${formatUnits(swapBalance, 18)} msUSD`)
            console.warn('  Possible causes: position had 0 liquidity, or RPC lag.')
            break
          }
          await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        }
      } else {
        // --steps swap 单独执行：直接读一次当前余额，不需要轮询
        swapBalance = await publicClient.readContract({
          address: ae.msUsdAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [account.address],
        })
        console.log(`\nWallet msUSD balance: ${formatUnits(swapBalance, 18)}`)
      }

      if (swapBalance === 0n) {
        console.error('No msUSD in wallet. Run unstake+remove first, or pass --msUsd <amount>.')
        return
      }

      // 用真实余额重新生成订单组（只取 PRICE_FLOOR_GUARD 和 SWAP 订单）
      const swapOrders = generateWithdrawalOrders(alert, ae, swapBalance, effectivePrice)
        .filter(o => o.type === 'price_floor_guard' || o.type === 'swap')

      const batchCount = ae.execution.swapBatchCount
      const slippage   = ae.execution.swapSlippageBps
      const ok = await confirm(
        rl,
        `\nStep 3/3 — PRICE_FLOOR_GUARD + SWAP (${batchCount} batch${batchCount > 1 ? 'es' : ''}).\n` +
        `  msUSD in : ${formatUnits(swapBalance, 18)}\n` +
        `  Slippage : ${slippage} bps\n` +
        `  Floor    : ${ae.execution.minPriceToSwap}\n` +
        `  Orders   : ${swapOrders.length}\nContinue?`,
      )
      if (!ok) { console.log('Aborted.'); return }

      for (const order of swapOrders.sort((a, b) => a.sequence - b.sequence)) {
        const label = order.type === 'price_floor_guard'
          ? `PRICE_FLOOR_GUARD (batch ${Math.ceil(order.sequence / 2)})`
          : `SWAP batch ${(order as { params: { batchIndex?: number } }).params.batchIndex !== undefined
              ? ((order.params as { batchIndex: number }).batchIndex + 1)
              : '?'}/${batchCount}`
        const success = await execAndReport(executor, order, label)
        if (!success) {
          console.error('\nOrder failed — aborting remaining swap orders.')
          break
        }
      }
    }

    // ── 最终余额 ────────────────────────────────────────────────────────────

    if (stepsArg === 'all' || stepsArg === 'swap') {
      try {
        const [msUsdAfter, usdcAfter] = await Promise.all([
          publicClient.readContract({ address: ae.msUsdAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
          publicClient.readContract({ address: ae.usdcAddress  as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
        ])
        console.log('\n── Final balances ──')
        console.log(`  msUSD : ${formatUnits(msUsdAfter, 18)} (Δ ${formatUnits(msUsdAfter - msUsdBefore, 18)})`)
        console.log(`  USDC  : ${formatUnits(usdcAfter, 6)} (Δ +${formatUnits(usdcAfter - usdcBefore, 6)})`)
      } catch {
        console.log('\n(Rate-limited reading final balances — check Basescan for final state)')
      }
    }

  } finally {
    rl.close()
  }
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
