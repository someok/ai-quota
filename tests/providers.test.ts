import { describe, expect, it, vi } from "vitest";

import { codexAdapter, parseCodexUsage } from "../src/providers/codex.js";
import { deepSeekAdapter } from "../src/providers/deepseek.js";
import { parseKimiUsage } from "../src/providers/kimi-code.js";
import { parseOpenCodeGo } from "../src/providers/opencode-go.js";
import { parseOpenCodeZen } from "../src/providers/opencode-zen.js";
import { parseSuperGrok } from "../src/providers/xai-supergrok.js";
import { parseXaiManagementResponse } from "../src/providers/xai-api-platform.js";
import { parseMimoBalance, parseMimoDetail, parseMimoUsage } from "../src/providers/xiaomi-mimo.js";

describe("服务响应解析器", () => {
  it("解析 DeepSeek 官方余额并识别认证失败", async () => {
    const successFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "12.34", granted_balance: "2", topped_up_balance: "10.34" }],
    }));
    const account = { id: "d", provider: "deepseek", enabled: true, apiKey: "secret-key" } as const;
    const success = await deepSeekAdapter.collect(account, { requestTimeoutMs: 50, verbose: false, fetchFn: successFetch });
    expect(success.ok && success.data.balances).toHaveLength(1);
    const denied = await deepSeekAdapter.collect(account, {
      requestTimeoutMs: 50,
      verbose: false,
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-key denied", { status: 401 })),
    });
    expect(denied.ok).toBe(false);
    expect(denied.ok ? "" : denied.error).not.toContain("secret-key");
  });

  it("解析 Codex 多种额度窗口并拒绝结构变化", () => {
    const data = parseCodexUsage({
      plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 2_000_000_000 } },
      spend_control: { individual_limit: { remaining_percent: 80, reset_at: "2030-01-01T00:00:00Z" } },
    });
    expect(data.windows).toHaveLength(2);
    expect(() => parseCodexUsage({ unknown: true })).toThrow("没有可识别");
  });

  it("Codex 请求附带独立账号头", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      rate_limit: { primary_window: { used_percent: 1 } },
    }));
    await codexAdapter.collect(
      { id: "c", provider: "codex", enabled: true, accessToken: "token", accountId: "acct" },
      { requestTimeoutMs: 50, verbose: false, fetchFn },
    );
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("ChatGPT-Account-Id")).toBe("acct");
  });

  it("解析 OpenCode Go SSR 与 data-slot", () => {
    const ssr = "rollingUsage:$R[1]={usagePercent:25,resetInSec:3600} weeklyUsage:$R[2]={resetInSec:7200,usagePercent:50}";
    expect(parseOpenCodeGo(ssr).windows).toHaveLength(2);
    const html = '<div data-slot="usage-item"><span data-slot="usage-label">Monthly Usage</span><span data-slot="usage-value">12.5%</span><span data-slot="reset-time">Resets in 2 days 1 hour</span></div>';
    expect(parseOpenCodeGo(html).windows).toHaveLength(1);
    expect(() => parseOpenCodeGo("changed")).toThrow("结构已变化");
  });

  it("解析 OpenCode Zen 账单", () => {
    const data = parseOpenCodeZen("balance:250000000 monthlyLimit:10 monthlyUsage:50000000 $R[\"payment.list\"]=[{\"amount\":100000000}]");
    expect(data.balanceUsd).toBe(2.5);
    expect(data.monthlyUsageUsd).toBe(0.5);
    expect(data.lastPaymentUsd).toBe(1);
    expect(() => parseOpenCodeZen("changed")).toThrow("结构已变化");
  });

  it("解析 Kimi 用量", () => {
    const data = parseKimiUsage({ data: { usage: { used: 2, limit: 10, reset_in: 100 }, limits: [{ name: "5h", detail: { used: 1, limit: 5 } }] } });
    expect(data.windows).toHaveLength(2);
    expect(() => parseKimiUsage({ data: {} })).toThrow("没有可识别");
  });

  it("解析 SuperGrok 并验证百分比", () => {
    expect(parseSuperGrok({ config: { creditUsagePercent: 20, currentPeriod: { type: "WEEKLY", end: "2030-01-01" } } }).remainingPercent).toBe(80);
    expect(() => parseSuperGrok({ config: { creditUsagePercent: "bad" } })).toThrow();
  });

  it("验证 xAI 管理平台响应", () => {
    expect(parseXaiManagementResponse({ balance: "12.00" }, "余额")).toEqual({ balance: "12.00" });
    expect(() => parseXaiManagementResponse([], "余额")).toThrow("结构不兼容");
  });

  it("解析 MiMo 三个控制台接口", () => {
    expect(parseMimoUsage({ code: 0, data: { monthUsage: { items: [{ name: "month_total_token", used: 20, limit: 100 }] } } }).remainingPercent).toBe(80);
    expect(parseMimoDetail({ code: 0, data: { expired: false, planName: "Pro" } }).expired).toBe(false);
    expect(parseMimoBalance({ code: 0, data: { balance: "1.5", cashBalance: 1, giftBalance: 0, currency: "cny" } }).currency).toBe("CNY");
    expect(() => parseMimoUsage({ code: 1 })).toThrow("结构不兼容");
  });
});
