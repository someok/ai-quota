import { readBoundedJson, request } from "../http.js";
import type { JsonValue, KimiCodeAccount, ProviderAdapter } from "../types.js";
import { clampPercent, failure, fetchOptions, finiteNumber, isRecord, isoTime, success } from "./helpers.js";

const SOURCE = "https://api.kimi.com/coding/v1/usages";

function resetTime(data: Record<string, unknown>): string | null {
  for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
    const parsed = isoTime(data[key]);
    if (parsed) return parsed;
  }
  for (const key of ["reset_in", "resetIn", "ttl"]) {
    const seconds = finiteNumber(data[key]);
    if (seconds !== null && seconds >= 0) return new Date(Date.now() + seconds * 1000).toISOString();
  }
  return null;
}

function usageRow(data: Record<string, unknown>, label: string): Record<string, JsonValue> | null {
  const limit = finiteNumber(data.limit);
  let used = finiteNumber(data.used);
  if (used === null && limit !== null) {
    const remaining = finiteNumber(data.remaining);
    if (remaining !== null) used = limit - remaining;
  }
  if (limit === null || used === null || limit <= 0) return null;
  return {
    name:
      typeof data.name === "string"
        ? data.name
        : typeof data.title === "string"
          ? data.title
          : label,
    used,
    limit,
    remainingPercent: clampPercent(((limit - used) / limit) * 100),
    resetsAt: resetTime(data),
  };
}

export function parseKimiUsage(payload: unknown): Record<string, JsonValue> {
  if (!isRecord(payload)) throw new Error("Kimi Code 用量响应结构不兼容");
  const body = isRecord(payload.data) ? payload.data : payload;
  const windows: Record<string, JsonValue>[] = [];
  if (isRecord(body.usage)) {
    const row = usageRow(body.usage, "周额度");
    if (row) windows.push(row);
  }
  if (Array.isArray(body.limits)) {
    body.limits.forEach((value, index) => {
      if (!isRecord(value)) return;
      const detail = isRecord(value.detail) ? value.detail : value;
      const row = usageRow(detail, `额度 ${index + 1}`);
      if (row) windows.push(row);
    });
  }
  if (windows.length === 0) throw new Error("Kimi Code 响应中没有可识别的额度窗口");
  return { windows };
}

export const kimiCodeAdapter: ProviderAdapter<KimiCodeAccount> = {
  id: "kimi-code",
  async collect(account, context) {
    try {
      const payload = await request(
        SOURCE,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${account.apiKey}`,
            "User-Agent": "ai-quota/0.1",
          },
        },
        async (response) => readBoundedJson(response),
        fetchOptions(account, context),
      );
      return success(SOURCE, parseKimiUsage(payload));
    } catch (error) {
      return failure(SOURCE, error, account);
    }
  },
};
