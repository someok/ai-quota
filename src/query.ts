import {
  getCachedResult,
  loadCache,
  resolveCachePath,
  storeSuccessfulResult,
} from "./cache.js";
import { accountDisplayName, type Account, type AccountResult, type CollectContext } from "./types.js";
import { getAdapter } from "./providers/registry.js";

export interface QueryOptions {
  refresh: boolean;
  verbose: boolean;
  concurrency?: number;
  cachePath?: string;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
  writeCache?: boolean;
  onResult(result: AccountResult): void | Promise<void>;
}

export async function queryAccounts(accounts: readonly Account[], options: QueryOptions): Promise<AccountResult[]> {
  const concurrency = Math.max(1, Math.min(accounts.length || 1, options.concurrency ?? 4));
  const cachePath = options.cachePath ?? resolveCachePath();
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const cache = await loadCache(cachePath);
  const results: AccountResult[] = [];
  let nextIndex = 0;
  let cacheWrite = Promise.resolve();

  const context: CollectContext = {
    requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
    verbose: options.verbose,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  };

  async function runAccount(account: Account): Promise<AccountResult> {
    const cached = getCachedResult(cache, account.provider, account.id, cacheTtlMs);
    if (!options.refresh && cached?.fresh) {
      return { ...cached.result, label: accountDisplayName(account), provider: account.provider };
    }

    const startedAt = performance.now();
    const response = await getAdapter(account).collect(account, context);
    const result: AccountResult = {
      accountId: account.id,
      provider: account.provider,
      label: accountDisplayName(account),
      response,
      fromCache: false,
      stale: false,
      durationMs: Math.round(performance.now() - startedAt),
      ...(!response.ok && cached ? { fallback: cached.result.response as Extract<typeof cached.result.response, { ok: true }> } : {}),
    };
    if (response.ok) {
      if (options.writeCache !== false) {
        cacheWrite = cacheWrite.then(() => storeSuccessfulResult(cachePath, cache, result));
      }
    } else if (cached) {
      result.stale = true;
    }
    return result;
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const account = accounts[index];
      if (!account) return;
      const result = await runAccount(account);
      results.push(result);
      await options.onResult(result);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await cacheWrite;
  return results;
}

export function exitCodeForResults(results: readonly AccountResult[]): 0 | 1 | 2 {
  if (results.length === 0) return 1;
  const successCount = results.filter((result) => result.response.ok).length;
  if (successCount === results.length) return 0;
  if (successCount === 0) return 1;
  return 2;
}
