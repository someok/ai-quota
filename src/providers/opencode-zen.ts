import { request } from "../http.js";
import type { JsonValue, OpenCodeZenAccount, ProviderAdapter } from "../types.js";
import { failure, fetchOptions, success } from "./helpers.js";

const UNITS_PER_DOLLAR = 100_000_000;

export function parseOpenCodeZen(html: string): Record<string, JsonValue> {
  const fields: Record<string, number> = {};
  for (const match of html.matchAll(/\b(balance|monthlyLimit|monthlyUsage)\s*:\s*(\d+(?:\.\d+)?)\b/gu)) {
    fields[match[1]!] = Number(match[2]);
  }
  if (!Number.isFinite(fields.balance) || fields.balance! < 0) {
    for (const item of html.split(/data-slot="billing-item"/u).slice(1)) {
      const label = /data-slot="billing-label">([^<]+)/u.exec(item)?.[1]?.toLowerCase();
      const amount = Number(
        /data-slot="billing-value">[^$]*\$?(\d+(?:,\d{3})*(?:\.\d+)?)/u
          .exec(item)?.[1]
          ?.replace(/,/gu, ""),
      );
      if (!label || !Number.isFinite(amount) || amount < 0) continue;
      if (label.includes("balance")) fields.balance = amount * UNITS_PER_DOLLAR;
      else if (label.includes("monthly") && label.includes("limit")) fields.monthlyLimit = amount;
      else if (label.includes("monthly") && label.includes("usage")) {
        fields.monthlyUsage = amount * UNITS_PER_DOLLAR;
      }
    }
  }
  if (!Number.isFinite(fields.balance) || fields.balance! < 0) {
    throw new Error("OpenCode Zen 页面结构已变化，无法解析账单");
  }
  const paymentPatterns = [
    /"payment\.list"\]\s*=\s*\[\s*\{[\s\S]*?"amount"\s*:\s*(\d+)/u,
    /"payment\.list"\s*:\s*\[[\s\S]*?"amount"\s*:\s*(\d+)/u,
    /__\$S\["payment\.list"\][\s\S]*?"amount"\s*:\s*(\d+)/u,
  ];
  const payment = paymentPatterns.map((pattern) => pattern.exec(html)).find(Boolean) ?? null;
  return {
    balanceUsd: fields.balance! / UNITS_PER_DOLLAR,
    monthlyLimitUsd: Number.isFinite(fields.monthlyLimit) ? fields.monthlyLimit! : null,
    monthlyUsageUsd: Number.isFinite(fields.monthlyUsage)
      ? fields.monthlyUsage! / UNITS_PER_DOLLAR
      : null,
    lastPaymentUsd: payment ? Number(payment[1]) / UNITS_PER_DOLLAR : null,
  };
}

export const openCodeZenAdapter: ProviderAdapter<OpenCodeZenAccount> = {
  id: "opencode-zen",
  async collect(account, context) {
    const source = `https://opencode.ai/workspace/${encodeURIComponent(account.workspaceId)}/billing`;
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
      return success(source, parseOpenCodeZen(html));
    } catch (error) {
      return failure(source, error, account);
    }
  },
};
