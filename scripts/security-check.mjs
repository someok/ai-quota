import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoredDirectories = new Set([".git", "node_modules"]);
const inspectedExtensions = new Set([".ts", ".js", ".mjs", ".json", ".jsonc", ".md", ".map"]);
const findings = [];

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (inspectedExtensions.has(extname(entry.name)) && entry.name !== "pnpm-lock.yaml") result.push(path);
  }
  return result;
}

const externalSecrets = [];
for (const path of [
  "/Users/wjx/.config/opencode/opencode-quota/opencode-go.json",
  "/Users/wjx/.local/share/opencode/auth.json",
]) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const visit = (item, key = "") => {
      if (typeof item === "string" && item.length >= 12 && /key|token|cookie|access|refresh|auth/i.test(key)) {
        externalSecrets.push(item);
      } else if (item && typeof item === "object") {
        for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
      }
    };
    visit(value);
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) {
        if (entry?.type === "api" && typeof entry.key === "string" && entry.key.length >= 12) {
          externalSecrets.push(entry.key);
        }
      }
    }
  } catch {
    // 持续集成环境不需要这些本机文件。
  }
}

const patterns = [
  { name: "疑似 JWT", pattern: /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/u },
  { name: "疑似长 API Key", pattern: /(?:sk|xai|ds|oc)[-_][A-Za-z0-9_-]{28,}/iu },
  { name: "疑似硬编码 Bearer", pattern: /Bearer\s+[A-Za-z0-9._~+/-]{24,}/iu },
];

for (const path of await files(root)) {
  const content = await readFile(path, "utf8");
  for (const { name, pattern } of patterns) {
    if (pattern.test(content)) findings.push(`${relative(root, path)}：${name}`);
  }
  if (externalSecrets.some((secret) => content.includes(secret))) {
    findings.push(`${relative(root, path)}：包含本机凭据`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`安全检查失败：\n${findings.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("安全检查通过：未发现硬编码凭据或本机授权秘密。\n");
}
