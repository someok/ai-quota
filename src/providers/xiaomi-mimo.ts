import { readBoundedJson, request } from "../http.js";
import type { JsonValue, ProviderAdapter, XiaomiMimoAccount } from "../types.js";
import { failure, fetchOptions, finiteNumber, isRecord, success } from "./helpers.js";

function envelope(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) {
    throw new Error("MiMo 控制台响应结构不兼容");
  }
  return payload.data;
}

export function parseMimoUsage(payload: unknown): Record<string, JsonValue> {
  const data = envelope(payload);
  if (!isRecord(data.monthUsage) || !Array.isArray(data.monthUsage.items)) {
    throw new Error("MiMo 响应缺少月度套餐用量");
  }
  const item = data.monthUsage.items.find(
    (value) => isRecord(value) && value.name === "month_total_token",
  );
  if (!isRecord(item)) throw new Error("MiMo 响应缺少月度令牌额度");
  const used = finiteNumber(item.used);
  const limit = finiteNumber(item.limit);
  if (used === null || limit === null || limit <= 0) throw new Error("MiMo 月度额度无效");
  return { used, limit, remainingPercent: Math.max(0, ((limit - used) / limit) * 100) };
}

export function parseMimoDetail(payload: unknown): Record<string, JsonValue> {
  const data = envelope(payload);
  if (typeof data.expired !== "boolean") throw new Error("MiMo 套餐状态无效");
  return {
    planName: typeof data.planName === "string" ? data.planName : null,
    planCode: typeof data.planCode === "string" ? data.planCode : null,
    expired: data.expired,
  };
}

export function parseMimoBalance(payload: unknown): Record<string, JsonValue> {
  const data = envelope(payload);
  const parseAmount = (value: unknown): number | null => {
    const parsed = finiteNumber(value);
    return parsed !== null && parsed >= 0 ? parsed : null;
  };
  return {
    total: parseAmount(data.balance),
    cash: parseAmount(data.cashBalance),
    gift: parseAmount(data.giftBalance),
    currency: typeof data.currency === "string" ? data.currency.toUpperCase() : null,
  };
}

type EndpointResult =
  | { ok: true; name: string; data: Record<string, JsonValue> }
  | { ok: false; name: string; error: string };

export const xiaomiMimoAdapter: ProviderAdapter<XiaomiMimoAccount> = {
  id: "xiaomi-mimo",
  async collect(account, context) {
    const source = "https://platform.xiaomimimo.com/api/v1";
    const timezoneMinutes = -new Date().getTimezoneOffset();
    const sign = timezoneMinutes >= 0 ? "+" : "-";
    const absolute = Math.abs(timezoneMinutes);
    const timezone = `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
    const headers = {
      Accept: "application/json, text/plain, */*",
      Cookie: account.cookie,
      Origin: "https://platform.xiaomimimo.com",
      Referer: "https://platform.xiaomimimo.com/#/console/balance",
      "User-Agent": "Mozilla/5.0 ai-quota/0.1",
      "x-timeZone": timezone,
    };
    const endpoints = [
      ["usage", `${source}/tokenPlan/usage`, parseMimoUsage],
      ["detail", `${source}/tokenPlan/detail`, parseMimoDetail],
      ["balance", `${source}/balance`, parseMimoBalance],
    ] as const;
    const options = fetchOptions(account, context);
    const results = await Promise.all(
      endpoints.map(async ([name, url, parser]): Promise<EndpointResult> => {
        try {
          const data = await request(
            url,
            { method: "GET", redirect: "manual", headers },
            async (response) => parser(await readBoundedJson(response, 256 * 1024)),
            options,
          );
          return { ok: true, name, data };
        } catch (error) {
          const failed = failure(url, error, account);
          return { ok: false, name, error: failed.error };
        }
      }),
    );
    const successful = results.filter((result): result is Extract<EndpointResult, { ok: true }> => result.ok);
    if (successful.length === 0) {
      return failure(source, results.map((result) => (result.ok ? "" : `${result.name}: ${result.error}`)).join("；"), account);
    }
    const data: Record<string, JsonValue> = {};
    successful.forEach((result) => {
      data[result.name] = result.data;
    });
    const errors = results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.error}`);
    if (errors.length) data.warnings = errors;
    return success(source, data);
  },
};
