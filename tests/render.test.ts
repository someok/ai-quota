import { describe, expect, it } from "vitest";

import { renderResult, renderSeparator } from "../src/render.js";
import type { AccountResult } from "../src/types.js";

function kimiResult(): AccountResult {
  return {
    accountId: "kimi",
    provider: "kimi-code",
    label: "Kimi Code Plan",
    response: {
      ok: true,
      source: "https://api.kimi.com/coding/v1/usages",
      fetchedAt: "2030-01-01T00:00:00.000Z",
      data: {
        windows: [
          {
            name: "5 小时额度",
            used: 20,
            limit: 100,
            remainingPercent: 80,
            resetsAt: "2030-01-02T00:00:00.000Z",
          },
        ],
      },
    },
    fromCache: false,
    stale: false,
    durationMs: 123,
  };
}

describe("终端结果渲染", () => {
  it("标题后直接显示数据且不再显示成功提示", () => {
    const rendered = renderResult(kimiResult());
    const lines = rendered.trimEnd().split("\n");

    expect(lines[0]).toBe("Kimi Code · Kimi Code Plan (kimi)");
    expect(lines[1]).toContain("5 小时额度:");
    expect(rendered).not.toContain("查询成功");
    expect(rendered).not.toContain("缓存结果");
    expect(rendered).not.toContain("─");
  });

  it("进度条展示已用百分比而不是剩余百分比", () => {
    const rendered = renderResult(kimiResult());

    expect(rendered).toContain("████░░░░░░░░░░░░░░░░ 20.0%");
    expect(rendered).not.toContain("80.0%");
    expect(rendered).not.toContain("已用:");
  });

  it("按照中文双宽字符计算并对齐冒号", () => {
    const lines = renderResult(kimiResult()).trimEnd().split("\n");

    expect(lines[1]).toMatch(/^5 小时额度:/u);
    expect(lines[2]).toMatch(/^ {6}重置:/u);
    expect(lines[3]).toMatch(/^ {6}采集:/u);
  });

  it("提供独立的账号区块分隔线", () => {
    expect(renderSeparator()).toBe("─".repeat(72));
  });
});
