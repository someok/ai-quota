import { describe, expect, it, vi } from "vitest";

import { HttpError, readBoundedJson, request } from "../src/http.js";
import { masked, redact } from "../src/security.js";

describe("脱敏与 HTTP", () => {
  it("不会在错误中泄露凭据", () => {
    const secret = "sk-very-secret-value";
    expect(redact(`Bearer ${secret} ${secret}`, [secret])).not.toContain(secret);
    expect(masked(secret)).toBe("sk-…lue");
  });

  it("仅重试网络、429 和 5xx", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(request("https://example.test", {}, (response) => response.json(), {
      fetchFn,
      retries: 2,
      timeoutMs: 100,
    })).resolves.toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 401 }));
    await expect(request("https://example.test", {}, (response) => response.text(), {
      fetchFn: denied,
      retries: 2,
    })).rejects.toBeInstanceOf(HttpError);
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("整个响应消费都受超时约束", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    await expect(request("https://example.test", {}, (response) => response.text(), {
      fetchFn,
      retries: 0,
      timeoutMs: 10,
    })).rejects.toThrow("请求超时");
  });

  it("拒绝超大响应", async () => {
    const response = new Response(JSON.stringify({ value: "x".repeat(100) }));
    await expect(readBoundedJson(response, 20)).rejects.toThrow("响应体过大");
  });
});
