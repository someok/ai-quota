import { describe, expect, it, vi } from "vitest";

import { openCodeGoAdapter, parseOpenCodeGo } from "../src/providers/opencode-go.js";
import { renderResult } from "../src/render.js";

function statusSample() {
  return {
    subscriberUserId: "test-subscriber",
    paymentMethodId: "test-payment-method",
    product: "go",
    access: {
      meters: {
        fiveHour: { startsAt: null, resetsAt: null as string | null, limitMicroCents: "1200000000", usedMicroCents: "0" },
        week: { resetsAt: "2026-10-12T00:00:00.000Z", limitMicroCents: "3000000000", usedMicroCents: "438420791" },
        month: { resetsAt: "2026-10-24T06:41:28.000Z", limitMicroCents: "6000000000", usedMicroCents: "1226337482" },
      },
    },
  };
}

const account = { id: "go", provider: "opencode-go", enabled: true, authCookie: "test-go-cookie" } as const;
const source = "https://opencode.ai/console/api/go/status";
const context = { requestTimeoutMs: 1000, verbose: false };

describe("OpenCode Go JSON 接口", () => {
  it("按顺序解析三种额度，且仅输出额度窗口", () => {
    expect(parseOpenCodeGo(statusSample())).toEqual({
      windows: [
        { name: "5 小时额度", usedPercent: 0, remainingPercent: 100, resetsAt: null },
        { name: "周额度", usedPercent: 14.614, remainingPercent: 85.386, resetsAt: "2026-10-12T00:00:00.000Z" },
        { name: "月额度", usedPercent: 20.439, remainingPercent: 79.561, resetsAt: "2026-10-24T06:41:28.000Z" },
      ],
    });
  });

  it.each([
    ["1", "3", 33.3333, 66.6667],
    ["1", "2000000", 0.0001, 99.9999],
    ["0", "100", 0, 100],
    ["125", "100", 125, 0],
    ["100", "100", 100, 0],
    ["99999899999999999999", "200000000000000000000", 49.9999, 50.0001],
  ])("精确计算 %s / %s 并保留超额使用", (used, limit, usedPercent, remainingPercent) => {
    const sample = statusSample();
    sample.access.meters.fiveHour.usedMicroCents = used;
    sample.access.meters.fiveHour.limitMicroCents = limit;
    expect(parseOpenCodeGo(sample).windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "5 小时额度", usedPercent, remainingPercent }),
    ]));
  });

  it("将带时区的重置时间规范化", () => {
    const sample = statusSample();
    sample.access.meters.fiveHour.resetsAt = "2026-10-09T16:00:00+08:00";
    expect(parseOpenCodeGo(sample).windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "5 小时额度", resetsAt: "2026-10-09T08:00:00.000Z" }),
    ]));
  });

  it.each([null, [], {}, "<html>登录</html>", { access: null }, { access: { meters: {} } }])(
    "拒绝不兼容结构：%j", (value) => {
      expect(() => parseOpenCodeGo(value)).toThrow("结构不兼容");
    },
  );

  it.each(["fiveHour", "week", "month"] as const)("缺失 %s 窗口时拒绝部分结果", (key) => {
    const sample = statusSample();
    Reflect.deleteProperty(sample.access.meters, key);
    expect(() => parseOpenCodeGo(sample)).toThrow("结构不兼容");
  });

  it.each([
    ["limitMicroCents", "0"],
    ["limitMicroCents", "-1"],
    ["usedMicroCents", "-1"],
    ["usedMicroCents", "1.5"],
    ["usedMicroCents", "1e6"],
    ["usedMicroCents", ""],
    ["usedMicroCents", " "],
    ["usedMicroCents", 100],
    ["usedMicroCents", null],
    ["limitMicroCents", undefined],
    ["usedMicroCents", undefined],
    ["resetsAt", undefined],
    ["resetsAt", "not-a-date"],
    ["resetsAt", ""],
    ["resetsAt", 123],
  ])("拒绝非法或缺失字段 %s=%s", (field, value) => {
    const sample = statusSample();
    Object.assign(sample.access.meters.week, { [field]: value });
    expect(() => parseOpenCodeGo(sample)).toThrow("结构不兼容");
  });

  it("拒绝无法表示为有限百分比的结果", () => {
    const sample = statusSample();
    sample.access.meters.week.usedMicroCents = "1".padEnd(400, "0");
    expect(() => parseOpenCodeGo(sample)).toThrow("结构不兼容");
  });

  it("使用新地址和 auth Cookie 获取 JSON", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(statusSample()));
    const result = await openCodeGoAdapter.collect(account, { ...context, fetchFn });
    expect(result).toMatchObject({ ok: true, source, data: parseOpenCodeGo(statusSample()) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(source);
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("Cookie")).toBe(`auth=${account.authCookie}`);
    expect(headers.get("Accept")).toBe("application/json");
  });

  it.each([401, 403, 429, 500])("处理 HTTP %i 并脱敏", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(`denied ${account.authCookie}`, { status }));
    const result = await openCodeGoAdapter.collect(account, { ...context, fetchFn });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`HTTP ${status}`) });
    expect(JSON.stringify(result)).not.toContain(account.authCookie);
    expect(fetchFn).toHaveBeenCalledTimes(status >= 429 ? 3 : 1);
  });

  it.each([
    ["有效的 JSON", "<html>登录</html>"],
    ["结构不兼容", "{}"],
    ["响应体过大", "x".repeat(512 * 1024 + 1)],
  ])("拒绝无效响应且不重试：%s", async (message, body) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const result = await openCodeGoAdapter.collect(account, { ...context, fetchFn });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(message) });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("终端显示已用比例、中文对齐，并省略空重置时间", () => {
    const rendered = renderResult({
      accountId: "go", provider: "opencode-go", label: "Go", fromCache: false, stale: false, durationMs: 10,
      response: { ok: true, source, fetchedAt: "2026-10-09T08:00:00.000Z", data: parseOpenCodeGo(statusSample()) },
    });
    const lines = rendered.trimEnd().split("\n");
    expect(lines[1]).toMatch(/^5 小时额度:.*0\.0%/u);
    expect(lines[2]).toMatch(/^ {4}周额度:.*14\.6%/u);
    expect(lines[3]).toMatch(/^ {6}重置:/u);
    expect(lines[4]).toMatch(/^ {4}月额度:.*20\.4%/u);
    expect(rendered.match(/重置:/gu)).toHaveLength(2);
    expect(rendered).not.toContain("已用:");
    expect(rendered).not.toContain("test-payment-method");
    expect(rendered).not.toContain("test-subscriber");
  });
});
