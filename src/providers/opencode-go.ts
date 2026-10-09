import { HttpError, readBoundedJson, request } from "../http.js";
import type { JsonValue, OpenCodeGoAccount, ProviderAdapter } from "../types.js";
import { clampPercent, failure, fetchOptions, isRecord, success } from "./helpers.js";

function invalidResponse(): Error {
  return new Error("OpenCode Go 响应结构不兼容，无法解析额度窗口");
}

// 把服务端的状态码翻译成可操作的中文提示，其它错误保持原样（调用方仍会脱敏）。
function describeError(error: unknown): unknown {
  if (error instanceof HttpError && error.status !== undefined) {
    if (error.status === 400 && error.message.includes("org_required")) {
      return new Error("工作区编号缺失或无效：请填写控制台 URL 中 wrk_ 开头的工作区编号");
    }
    if (error.status === 401) {
      return new Error("Cookie 无效或已过期：需要包含控制台会话 __Host-console_session");
    }
    if (error.status === 404) {
      return new Error("工作区不存在，或当前 Cookie 无权访问该工作区");
    }
  }
  return error;
}

function microCents(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw invalidResponse();
  return BigInt(value);
}

export function parseOpenCodeGo(value: unknown): Record<string, JsonValue> {
  if (!isRecord(value) || !isRecord(value.access) || !isRecord(value.access.meters)) {
    throw invalidResponse();
  }
  const meters = value.access.meters;
  const windows = ([
    ["fiveHour", "5 小时额度"],
    ["week", "周额度"],
    ["month", "月额度"],
  ] as const).map(([key, name]) => {
    const meter = meters[key];
    if (!isRecord(meter)) throw invalidResponse();
    const limit = microCents(meter.limitMicroCents);
    const used = microCents(meter.usedMicroCents);
    if (limit === 0n) throw invalidResponse();

    // 先用整数运算四舍五入，避免大额微美分转换为浮点数时丢失精度。
    const rounded = (used * 1_000_000n + limit / 2n) / limit;
    const usedPercent = Number(rounded) / 10_000;
    if (!Number.isFinite(usedPercent)) throw invalidResponse();
    let resetsAt: string | null = null;
    if (meter.resetsAt !== null) {
      if (typeof meter.resetsAt !== "string") throw invalidResponse();
      const timestamp = Date.parse(meter.resetsAt);
      if (!Number.isFinite(timestamp)) throw invalidResponse();
      resetsAt = new Date(timestamp).toISOString();
    }
    return {
      name,
      usedPercent,
      remainingPercent: clampPercent(Number(1_000_000n - rounded) / 10_000),
      resetsAt,
    };
  });
  return { windows };
}

export const openCodeGoAdapter: ProviderAdapter<OpenCodeGoAccount> = {
  id: "opencode-go",
  async collect(account, context) {
    const source = "https://opencode.ai/console/api/go/status";
    // 用户粘贴的整段 Cookie 直接转发，只把可能存在的换行、制表符归一化成空格。
    const cookie = account.cookie.replace(/[\r\n\t]+/gu, " ").trim();
    try {
      const data = await request(
        source,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Cookie: cookie,
            "x-org-id": account.workspaceId.trim(),
            "User-Agent": "Mozilla/5.0 ai-quota/0.1",
          },
        },
        async (response) => {
          try {
            return await readBoundedJson(response);
          } catch (error) {
            if (error instanceof SyntaxError) throw new Error("OpenCode Go 响应不是有效的 JSON");
            throw error;
          }
        },
        fetchOptions(account, context),
      );
      return success(source, parseOpenCodeGo(data));
    } catch (error) {
      return failure(source, describeError(error), account);
    }
  },
};
