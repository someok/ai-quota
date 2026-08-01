import { readBoundedJson, request } from "../http.js";
import type { JsonValue, ProviderAdapter, XaiApiPlatformAccount } from "../types.js";
import { failure, fetchOptions, isRecord, success } from "./helpers.js";

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, label));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, label)]));
  }
  throw new Error(`xAI ${label}响应包含无效字段`);
}

export function parseXaiManagementResponse(payload: unknown, label: string): JsonValue {
  if (!isRecord(payload) || Object.keys(payload).length === 0) {
    throw new Error(`xAI ${label}响应结构不兼容`);
  }
  return jsonValue(payload, label);
}

function monthRange(): { startTime: string; endTime: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    startTime: start.toISOString().replace("T", " ").replace(/\.\d{3}Z$/u, ""),
    endTime: now.toISOString().replace("T", " ").replace(/\.\d{3}Z$/u, ""),
  };
}

export const xaiApiPlatformAdapter: ProviderAdapter<XaiApiPlatformAccount> = {
  id: "xai-api-platform",
  async collect(account, context) {
    const base = `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(account.teamId)}`;
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${account.managementKey}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-quota/0.1",
    };
    try {
      const options = fetchOptions(account, context);
      const [balance, limits, usage] = await Promise.all([
        request(`${base}/prepaid/balance`, { method: "GET", headers }, (response) => readBoundedJson(response), options),
        request(`${base}/postpaid/spending-limits`, { method: "GET", headers }, (response) => readBoundedJson(response), options),
        request(
          `${base}/usage`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              analyticsRequest: {
                timeRange: { ...monthRange(), timezone: "Etc/UTC" },
                timeUnit: "TIME_UNIT_DAY",
                values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
                groupBy: [],
              },
            }),
          },
          (response) => readBoundedJson(response),
          options,
        ),
      ]);
      return success(base, {
        prepaidBalance: parseXaiManagementResponse(balance, "余额"),
        postpaidLimits: parseXaiManagementResponse(limits, "月限额"),
        currentMonthUsage: parseXaiManagementResponse(usage, "用量"),
      });
    } catch (error) {
      return failure(base, error, account);
    }
  },
};
