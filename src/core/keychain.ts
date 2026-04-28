// src/core/keychain.ts
import { execSync } from 'node:child_process'

export interface KeychainReader {
  read(service: string, account: string): string | null
}

/**
 * 从 macOS Keychain 读取密码。
 * 调用 `security find-generic-password -s <service> -a <account> -w`。
 * 找不到或出错时返回 null，不抛异常。
 */
export function readFromKeychain(service: string, account: string): string | null {
  try {
    const value = execSync(
      `security find-generic-password -s ${service} -a ${account} -w`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

export class MacKeychainReader implements KeychainReader {
  read(service: string, account: string): string | null {
    return readFromKeychain(service, account)
  }
}
