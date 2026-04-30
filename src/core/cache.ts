// src/core/cache.ts
// 带并发请求去重的 TTL 缓存：同一 key 的多个并发调用共享同一个 in-flight Promise，
// 防止缓存过期瞬间的重复 HTTP 请求。

interface CacheEntry {
  data: unknown
  expiresAt: number
}

export class RequestCache {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor(private readonly ttlMs: number) {}

  async get<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.data as T

    const existing = this.inflight.get(key)
    if (existing) return existing as Promise<T>

    const promise = fn().then(
      data => {
        this.cache.set(key, { data, expiresAt: Date.now() + this.ttlMs })
        this.inflight.delete(key)
        return data
      },
      err => {
        this.inflight.delete(key)
        throw err
      },
    )
    this.inflight.set(key, promise)
    return promise
  }
}
