import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../src/cli.js";
import { loginCodex, loginXai, refreshOAuthAccount } from "../src/oauth.js";

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("OAuth 与命令接口", () => {
  it("完成 Codex 设备码流程", async () => {
    const access = jwt({ exp: 2_000_000_000 });
    const id = jwt({ email: "user@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct" } });
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ device_auth_id: "device", user_code: "ABCD", interval: "1" }))
      .mockResolvedValueOnce(Response.json({ authorization_code: "code", code_verifier: "verifier", code_challenge: "challenge" }))
      .mockResolvedValueOnce(Response.json({ access_token: access, refresh_token: "refresh", id_token: id }));
    const result = await loginCodex({ fetchFn, sleep: async () => undefined, notify: () => undefined });
    expect(result.accountId).toBe("acct");
    expect(result.email).toBe("user@example.com");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("完成 xAI 设备码流程", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        device_code: "device",
        user_code: "CODE",
        verification_uri: "https://x.ai/device",
        expires_in: 300,
        interval: 1,
      }))
      .mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
    const result = await loginXai({ fetchFn, sleep: async () => undefined, notify: () => undefined });
    expect(result.accessToken).toBe("access");
    expect(result.refreshToken).toBe("refresh");
  });

  it("OAuth 临近过期时刷新并保留轮换后的凭据", async () => {
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      access_token: access,
      refresh_token: "new-refresh",
      expires_in: 3600,
    }));
    const result = await refreshOAuthAccount(
      { id: "x", provider: "xai-supergrok", enabled: true, accessToken: "old", refreshToken: "old-refresh", expiresAt: 1 },
      { fetchFn },
    );
    expect(result.accessToken).toBe(access);
    expect(result.refreshToken).toBe("new-refresh");
  });

  it("命令不提供 --json", async () => {
    const program = createProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    await expect(program.parseAsync(["node", "ai-quota", "--json"])).rejects.toMatchObject({
      code: "commander.unknownOption",
    });
  });
});
