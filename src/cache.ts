import { randomUUID } from "node:crypto";
import { mkdir, chmod, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { AccountResult, ProviderSuccess } from "./types.js";

const cachedSuccessSchema = z.object({
  accountId: z.string(),
  provider: z.string(),
  label: z.string(),
  response: z.object({
    ok: z.literal(true),
    source: z.string(),
    data: z.record(z.string(), z.unknown()),
    fetchedAt: z.string(),
  }),
});

const cacheSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), cachedSuccessSchema),
});

type CacheFile = z.infer<typeof cacheSchema>;

export function resolveCachePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "ai-quota", "results.json");
}

export function cacheKey(provider: string, accountId: string): string {
  return `${provider}:${accountId}`;
}

export async function loadCache(path: string): Promise<CacheFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = cacheSchema.safeParse(parsed);
    return result.success ? result.data : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

async function writeCache(path: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.results.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(cache, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function getCachedResult(
  cache: CacheFile,
  provider: string,
  accountId: string,
  ttlMs: number,
): { result: AccountResult; fresh: boolean } | null {
  const entry = cache.entries[cacheKey(provider, accountId)];
  if (!entry) return null;
  const age = Date.now() - Date.parse(entry.response.fetchedAt);
  const response = entry.response as ProviderSuccess;
  return {
    result: {
      accountId: entry.accountId,
      provider: provider as AccountResult["provider"],
      label: entry.label,
      response,
      fromCache: true,
      stale: age >= ttlMs,
      durationMs: 0,
    },
    fresh: age < ttlMs,
  };
}

export async function storeSuccessfulResult(
  path: string,
  cache: CacheFile,
  result: AccountResult,
): Promise<void> {
  if (!result.response.ok) return;
  cache.entries[cacheKey(result.provider, result.accountId)] = {
    accountId: result.accountId,
    provider: result.provider,
    label: result.label,
    response: result.response,
  };
  await writeCache(path, cache);
}

export async function removeCachedAccount(
  path: string,
  cache: CacheFile,
  provider: string,
  accountId: string,
): Promise<void> {
  delete cache.entries[cacheKey(provider, accountId)];
  await writeCache(path, cache);
}
