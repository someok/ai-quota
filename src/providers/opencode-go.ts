import { request } from "../http.js";
import type { JsonValue, OpenCodeGoAccount, ProviderAdapter } from "../types.js";
import { clampPercent, failure, fetchOptions, success } from "./helpers.js";

interface WindowUsage {
  usedPercent: number;
  resetSeconds: number;
}

const NUMBER = String.raw`(-?\d+(?:\.\d+)?)`;

function hydrationWindow(html: string, key: string): WindowUsage | null {
  const percentFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*usagePercent:${NUMBER}[^}]*resetInSec:${NUMBER}[^}]*\}`,
  ).exec(html);
  if (percentFirst) {
    return { usedPercent: Number(percentFirst[1]), resetSeconds: Number(percentFirst[2]) };
  }
  const resetFirst = new RegExp(
    String.raw`${key}:\$R\[\d+\]=\{[^}]*resetInSec:${NUMBER}[^}]*usagePercent:${NUMBER}[^}]*\}`,
  ).exec(html);
  return resetFirst
    ? { usedPercent: Number(resetFirst[2]), resetSeconds: Number(resetFirst[1]) }
    : null;
}

function durationSeconds(value: string): number | null {
  const normalized = value
    .toLowerCase()
    .replace(/<!--\$-->|<!--\/-->/gu, "")
    .replace(/resets?\s*in/iu, "")
    .trim();
  if (/\bnow\b/u.test(normalized)) return 0;
  const units = [
    [/([\d.]+)\s*days?/u, 86_400],
    [/([\d.]+)\s*hours?/u, 3_600],
    [/([\d.]+)\s*minutes?/u, 60],
    [/([\d.]+)\s*seconds?/u, 1],
  ] as const;
  let total = 0;
  let found = false;
  for (const [pattern, multiplier] of units) {
    const match = pattern.exec(normalized);
    if (match) {
      found = true;
      total += Number(match[1]) * multiplier;
    }
  }
  return found ? total : null;
}

function dataSlotWindows(html: string): Partial<Record<string, WindowUsage>> {
  const result: Partial<Record<string, WindowUsage>> = {};
  for (const item of html.split(/data-slot="usage-item"/u).slice(1)) {
    const label = /data-slot="usage-label">([^<]+)/u.exec(item)?.[1]?.toLowerCase();
    const used = Number(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/u.exec(item)?.[1]);
    const resetMatch = /data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/u.exec(item);
    const reset = resetMatch?.[1] === "reset-now"
      ? 0
      : resetMatch?.[2]
        ? durationSeconds(resetMatch[2])
        : null;
    if (!label || !Number.isFinite(used) || reset === null) continue;
    const key = label.includes("rolling")
      ? "rolling"
      : label.includes("weekly")
        ? "weekly"
        : label.includes("monthly")
          ? "monthly"
          : null;
    if (key) result[key] = { usedPercent: used, resetSeconds: reset };
  }
  return result;
}

export function parseOpenCodeGo(html: string): Record<string, JsonValue> {
  let windows: Partial<Record<string, WindowUsage>> = {
    rolling: hydrationWindow(html, "rollingUsage") ?? undefined,
    weekly: hydrationWindow(html, "weeklyUsage") ?? undefined,
    monthly: hydrationWindow(html, "monthlyUsage") ?? undefined,
  };
  if (!windows.rolling && !windows.weekly && !windows.monthly) windows = dataSlotWindows(html);
  const now = Date.now();
  const labels = { rolling: "5 小时额度", weekly: "周额度", monthly: "月额度" } as const;
  const rows = (["rolling", "weekly", "monthly"] as const).flatMap((key) => {
    const value = windows[key];
    if (!value) return [];
    return [
      {
        name: labels[key],
        usedPercent: Math.max(0, value.usedPercent),
        remainingPercent: clampPercent(100 - value.usedPercent),
        resetsAt: new Date(now + Math.max(0, value.resetSeconds) * 1000).toISOString(),
      },
    ];
  });
  if (rows.length === 0) throw new Error("OpenCode Go 页面结构已变化，无法解析额度窗口");
  return { windows: rows };
}

export const openCodeGoAdapter: ProviderAdapter<OpenCodeGoAccount> = {
  id: "opencode-go",
  async collect(account, context) {
    const source = `https://opencode.ai/workspace/${encodeURIComponent(account.workspaceId)}/go`;
    try {
      const html = await request(
        source,
        {
          method: "GET",
          headers: {
            Accept: "text/html",
            Cookie: `auth=${account.authCookie}`,
            "User-Agent": "Mozilla/5.0 ai-quota/0.1",
          },
        },
        async (response) => response.text(),
        fetchOptions(account, context),
      );
      return success(source, parseOpenCodeGo(html));
    } catch (error) {
      return failure(source, error, account);
    }
  },
};
