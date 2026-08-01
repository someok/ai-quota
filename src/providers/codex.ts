import { readBoundedJson, request } from "../http.js";
import type { CodexAccount, JsonValue, ProviderAdapter } from "../types.js";
import { clampPercent, failure, fetchOptions, finiteNumber, isRecord, isoTime, success } from "./helpers.js";

const SOURCE = "https://chatgpt.com/backend-api/wham/usage";

function parseWindow(value: unknown, name: string): Record<string, JsonValue> | null {
  if (!isRecord(value)) return null;
  const used = finiteNumber(value.used_percent);
  if (used === null) return null;
  const durationSeconds = finiteNumber(value.limit_window_seconds);
  const reset = isoTime(value.reset_at);
  return {
    name,
    usedPercent: clampPercent(used),
    remainingPercent: clampPercent(100 - used),
    durationSeconds,
    resetsAt: reset,
  };
}

function parseRemainingWindow(value: unknown, name: string): Record<string, JsonValue> | null {
  if (!isRecord(value)) return null;
  const remaining = finiteNumber(value.remaining_percent);
  if (remaining === null) return null;
  return {
    name,
    remainingPercent: clampPercent(remaining),
    usedPercent: clampPercent(100 - remaining),
    resetsAt: isoTime(value.reset_at),
  };
}

export function parseCodexUsage(payload: unknown): Record<string, JsonValue> {
  if (!isRecord(payload)) throw new Error("Codex 用量响应结构不兼容");
  const rateLimit = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const spendControl = isRecord(payload.spend_control) ? payload.spend_control : {};
  const codeReview = isRecord(payload.code_review_rate_limit) ? payload.code_review_rate_limit : {};
  const windows = [
    parseWindow(rateLimit.primary_window, "主要窗口"),
    parseWindow(rateLimit.secondary_window, "次要窗口"),
    parseRemainingWindow(spendControl.individual_limit, "月度额度"),
    parseWindow(codeReview.primary_window, "代码审查"),
  ].filter((window): window is Record<string, JsonValue> => window !== null);
  if (windows.length === 0) throw new Error("Codex 用量响应中没有可识别的额度窗口");
  const credits = isRecord(payload.credits)
    ? {
        hasCredits: Boolean(payload.credits.has_credits),
        unlimited: Boolean(payload.credits.unlimited),
        balance:
          typeof payload.credits.balance === "string" || typeof payload.credits.balance === "number"
            ? String(payload.credits.balance)
            : null,
      }
    : null;
  return {
    planType: typeof payload.plan_type === "string" ? payload.plan_type : null,
    windows,
    credits,
  };
}

export const codexAdapter: ProviderAdapter<CodexAccount> = {
  id: "codex",
  async collect(account, context) {
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${account.accessToken}`,
        "User-Agent": "ai-quota/0.1",
      };
      if (account.accountId) headers["ChatGPT-Account-Id"] = account.accountId;
      const payload = await request(
        SOURCE,
        { method: "GET", headers },
        async (response) => readBoundedJson(response),
        fetchOptions(account, context),
      );
      return success(SOURCE, parseCodexUsage(payload));
    } catch (error) {
      return failure(SOURCE, error, account);
    }
  },
};
