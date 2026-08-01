import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { exitCodeForResults, queryAccounts } from "../src/query.js";
import type { AccountResult, DeepSeekAccount } from "../src/types.js";

function account(id: string): DeepSeekAccount {
  return { id, provider: "deepseek", enabled: true, apiKey: `key-${id}` };
}

function deepSeekResponse(): Response {
  return Response.json({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "1", granted_balance: "0", topped_up_balance: "1" }],
  });
}

describe("查询协调与缓存", () => {
  it("限制并发为四并按完成顺序输出", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-query-"));
    let active = 0;
    let maximum = 0;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const key = new Headers(init?.headers).get("authorization")?.replace("Bearer key-", "") ?? "0";
      await new Promise((resolve) => setTimeout(resolve, key === "0" ? 40 : 5));
      active -= 1;
      return deepSeekResponse();
    });
    const completed: string[] = [];
    const accounts = Array.from({ length: 7 }, (_, index) => account(String(index)));
    await queryAccounts(accounts, {
      refresh: true,
      verbose: false,
      cachePath: join(root, "cache.json"),
      fetchFn,
      onResult: (result) => {
        completed.push(result.accountId);
      },
    });
    expect(maximum).toBe(4);
    expect(completed).toHaveLength(7);
    expect(completed[0]).not.toBe("0");
  });

  it("一分钟复用成功缓存且缓存权限为 0600", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-cache-"));
    const cachePath = join(root, "results.json");
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(deepSeekResponse());
    const options = { refresh: false, verbose: false, cachePath, fetchFn, onResult: () => undefined };
    await queryAccounts([account("one")], options);
    const cached = await queryAccounts([account("one")], options);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cached[0]?.fromCache).toBe(true);
    expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
  });

  it("实时失败时提供过期回退并仍计失败", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-stale-"));
    const cachePath = join(root, "results.json");
    await queryAccounts([account("one")], {
      refresh: true,
      verbose: false,
      cachePath,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(deepSeekResponse()),
      onResult: () => undefined,
    });
    const results = await queryAccounts([account("one")], {
      refresh: true,
      verbose: false,
      cachePath,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response("down", { status: 500 })),
      onResult: () => undefined,
    });
    expect(results[0]?.fallback?.ok).toBe(true);
    expect(exitCodeForResults(results)).toBe(1);
  });

  it("退出码区分全部成功、部分失败和全部失败", () => {
    const success = { response: { ok: true } } as AccountResult;
    const failure = { response: { ok: false } } as AccountResult;
    expect(exitCodeForResults([success])).toBe(0);
    expect(exitCodeForResults([success, failure])).toBe(2);
    expect(exitCodeForResults([failure])).toBe(1);
  });
});
