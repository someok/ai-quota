import { chmod, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ConfigError, createConfig, loadConfig, resolveConfigPath, saveConfig } from "../src/config.js";

describe("配置文件", () => {
  it("加载 Go 账号配置不改写文件并保留注释", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-go-config-"));
    const path = join(root, "config.jsonc");
    const account = {
      id: "go",
      provider: "opencode-go",
      enabled: true,
      workspaceId: "wrk_test_workspace",
      cookie: "auth=test; __Host-console_session=test",
    };
    const text = `// 保留配置注释\n${JSON.stringify({ version: 1, accounts: [account] })}\n`;
    await writeFile(path, text, { mode: 0o600 });
    const document = await loadConfig(path);
    expect(document.config.accounts).toEqual([account]);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("遵守路径优先级", () => {
    expect(resolveConfigPath({ cliPath: "./a.jsonc", env: { AI_QUOTA_CONFIG: "./b.jsonc" }, home: "/h" }))
      .toMatch(/a\.jsonc$/u);
    expect(resolveConfigPath({ env: { AI_QUOTA_CONFIG: "~/b.jsonc" }, home: "/h" })).toBe("/h/b.jsonc");
    expect(resolveConfigPath({ env: {}, home: "/h" })).toBe("/h/.config/ai-quota/config.jsonc");
  });

  it("原子写入、权限 0600，并在更新时保留顶层注释", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-config-"));
    const path = join(root, "config.jsonc");
    let document = await createConfig(path, { version: 1, accounts: [] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const decorated = document.text.replace("{", "{\n  // 账号列表说明\n");
    await writeFile(path, decorated, { mode: 0o600 });
    document = await loadConfig(path);
    await saveConfig(document, {
      version: 1,
      accounts: [{ id: "one", provider: "deepseek", enabled: true, apiKey: "secret" }],
    });
    expect(await readFile(path, "utf8")).toContain("// 账号列表说明");
  });

  it("编辑字段时保留账号内部注释", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-comments-"));
    const path = join(root, "config.jsonc");
    await writeFile(path, `{
  "version": 1,
  "accounts": [{
    // 这个注释必须留下
    "id": "one",
    "provider": "deepseek",
    "apiKey": "old"
  }]
}\n`, { mode: 0o600 });
    const document = await loadConfig(path);
    await saveConfig(document, {
      version: 1,
      accounts: [{ id: "one", provider: "deepseek", enabled: true, apiKey: "new" }],
    });
    const updated = await readFile(path, "utf8");
    expect(updated).toContain("// 这个注释必须留下");
    expect(updated).toContain('"apiKey": "new"');
  });

  it("发现并发修改时拒绝覆盖", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-race-"));
    const path = join(root, "config.jsonc");
    const document = await createConfig(path, { version: 1, accounts: [] });
    await writeFile(path, `${document.text}\n// 外部修改\n`);
    await expect(saveConfig(document, { version: 1, accounts: [] })).rejects.toBeInstanceOf(ConfigError);
    await chmod(path, 0o600);
  });

  it("拒绝重复账号 id", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-invalid-"));
    const path = join(root, "config.jsonc");
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: [
        { id: "same", provider: "deepseek", apiKey: "a" },
        { id: "same", provider: "kimi-code", apiKey: "b" },
      ],
    }));
    await expect(loadConfig(path)).rejects.toThrow("账号 id 重复");
  });

  it("迁移前确认并创建 0600 备份", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-quota-migrate-"));
    const path = join(root, "config.jsonc");
    await writeFile(path, '// 旧配置\n{"version":0,"accounts":[]}\n', { mode: 0o600 });
    await expect(loadConfig(path)).rejects.toThrow("需要迁移");
    const migrated = await loadConfig(path, { confirmMigration: () => true });
    expect(migrated.config.version).toBe(1);
    expect(migrated.text).toContain("// 旧配置");
    const backup = (await readdir(root)).find((name) => name.includes("backup-v0"));
    expect(backup).toBeTruthy();
    expect((await stat(join(root, backup!))).mode & 0o777).toBe(0o600);
  });
});
