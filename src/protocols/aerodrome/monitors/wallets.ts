// src/protocols/aerodrome/monitors/wallets.ts
import type { DeBankClient } from '../../../core/clients/debank.js'
import type { WalletSignal } from '../types.js'

interface WalletMonitorConfig {
  teamWallets: string[]
  msUsdAddress: string
  msUsdSymbol: string
  chain: string
}

export class WalletMonitor {
  private previousAmounts = new Map<string, number>()

  constructor(private readonly cfg: WalletMonitorConfig, private readonly debank: DeBankClient) {}

  async check(): Promise<WalletSignal[]> {
    if (this.cfg.teamWallets.length === 0) return []

    const results = await Promise.allSettled(
      this.cfg.teamWallets.map(wallet => this.checkWallet(wallet)),
    )

    return results
      .filter((r): r is PromiseFulfilledResult<WalletSignal> => r.status === 'fulfilled')
      .map(r => r.value)
  }

  private async checkWallet(walletAddress: string): Promise<WalletSignal> {
    const tokens = await this.debank.getWalletTokens(walletAddress, this.cfg.chain)
    const msUsdToken = tokens.find(t => t.symbol === this.cfg.msUsdSymbol)
    const msUsdAmount = msUsdToken?.amount ?? 0
    const msUsdUsdValue = msUsdToken?.usdValue ?? 0
    const previous = this.previousAmounts.get(walletAddress) ?? null
    this.previousAmounts.set(walletAddress, msUsdAmount)
    return { walletAddress, msUsdAmount, msUsdUsdValue, previousMsUsdAmount: previous, fetchedAt: new Date() }
  }
}
