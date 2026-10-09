import { readFile } from "node:fs/promises";

import { deepSeekAdapter } from "../dist/providers/deepseek.js";
import { kimiCodeAdapter } from "../dist/providers/kimi-code.js";
import { openCodeGoAdapter } from "../dist/providers/opencode-go.js";

const goPath = "/Users/wjx/.config/opencode/opencode-quota/opencode-go.json";
const authPath = "/Users/wjx/.local/share/opencode/auth.json";

function apiKey(auth, provider) {
  const entry = auth[provider];
  return entry?.type === "api" && typeof entry.key === "string" ? entry.key : null;
}

async function main() {
  const [go, auth] = await Promise.all([
    readFile(goPath, "utf8").then(JSON.parse),
    readFile(authPath, "utf8").then(JSON.parse),
  ]);
  const checks = [];
  const goCookie = typeof go.cookie === "string" ? go.cookie : go.authCookie;
  if (typeof goCookie === "string" && typeof go.workspaceId === "string") {
    checks.push([
      "opencode-go",
      openCodeGoAdapter,
      { id: "live-go", provider: "opencode-go", enabled: true, workspaceId: go.workspaceId, cookie: goCookie },
    ]);
  }
  const deepseek = apiKey(auth, "deepseek");
  if (deepseek) {
    checks.push([
      "deepseek",
      deepSeekAdapter,
      { id: "live-deepseek", provider: "deepseek", enabled: true, apiKey: deepseek },
    ]);
  }
  const kimi = apiKey(auth, "kimi-for-coding");
  if (kimi) {
    checks.push([
      "kimi-code",
      kimiCodeAdapter,
      { id: "live-kimi", provider: "kimi-code", enabled: true, apiKey: kimi },
    ]);
  }
  if (checks.length === 0) throw new Error("没有找到可用于只读验证的授权凭据");

  let failures = 0;
  for (const [name, adapter, account] of checks) {
    const result = await adapter.collect(account, { requestTimeoutMs: 10_000, verbose: false });
    if (result.ok) process.stdout.write(`${name}: 只读验证成功\n`);
    else {
      failures += 1;
      process.stderr.write(`${name}: 只读验证失败：${result.error}\n`);
    }
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
