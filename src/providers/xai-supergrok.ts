import { readBoundedJson, request } from "../http.js";
import type { JsonValue, ProviderAdapter, XaiSuperGrokAccount } from "../types.js";
import { clampPercent, failure, fetchOptions, finiteNumber, isRecord, isoTime, success } from "./helpers.js";

const SOURCE = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export function parseSuperGrok(payload: unknown): Record<string, JsonValue> {
  if (!isRecord(payload) || !isRecord(payload.config)) {
    throw new Error("SuperGrok 用量响应结构不兼容");
  }
  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : {};
  const hasUsage = Object.prototype.hasOwnProperty.call(config, "creditUsagePercent");
  const parsedUsage = finiteNumber(config.creditUsagePercent);
  if (hasUsage && parsedUsage === null) throw new Error("SuperGrok 用量百分比无效");
  if (!hasUsage && Object.keys(period).length === 0) throw new Error("SuperGrok 响应中没有额度周期");
  const used = parsedUsage ?? 0;
  const type = typeof period.type === "string" ? period.type.toUpperCase() : "PERIOD";
  return {
    period: type.includes("WEEK")
      ? "weekly"
      : type.includes("MONTH")
        ? "monthly"
        : type.includes("DAY")
          ? "daily"
          : "period",
    usedPercent: clampPercent(used),
    remainingPercent: clampPercent(100 - used),
    startsAt: isoTime(period.start),
    resetsAt: isoTime(period.end) ?? isoTime(config.billingPeriodEnd),
  };
}

export const xaiSuperGrokAdapter: ProviderAdapter<XaiSuperGrokAccount> = {
  id: "xai-supergrok",
  async collect(account, context) {
    try {
      const payload = await request(
        SOURCE,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${account.accessToken}`,
            "User-Agent": "ai-quota/0.1",
            "x-grok-client-surface": "grok-build",
            "x-grok-client-version": "1.0.0",
          },
        },
        async (response) => readBoundedJson(response),
        fetchOptions(account, context),
      );
      return success(SOURCE, parseSuperGrok(payload));
    } catch (error) {
      return failure(SOURCE, error, account);
    }
  },
};
