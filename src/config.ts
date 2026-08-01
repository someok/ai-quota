import { createHash, randomUUID } from "node:crypto";
import { mkdir, chmod, copyFile, open, readFile, rename, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

import { configSchema, type Config } from "./types.js";

export interface ConfigDocument {
  path: string;
  text: string;
  config: Config;
  fingerprint: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export interface LoadConfigOptions {
  confirmMigration?: (fromVersion: number, toVersion: number) => boolean | Promise<boolean>;
}

export function resolveConfigPath(options: {
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const raw = options.cliPath ?? env.AI_QUOTA_CONFIG;
  if (raw) return resolve(raw.replace(/^~(?=\/)/u, options.home ?? homedir()));
  const configHome = env.XDG_CONFIG_HOME ?? join(options.home ?? homedir(), ".config");
  return join(configHome, "ai-quota", "config.jsonc");
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseConfigValue(text: string, path: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new ConfigError(
      `配置文件语法错误：${path}:${first.offset} ${printParseErrorCode(first.error)}`,
    );
  }
  return value;
}

function validateConfig(value: unknown): Config {
  const result = configSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "配置"}: ${issue.message}`)
      .join("；");
    throw new ConfigError(`配置文件校验失败：${details}`);
  }
  return result.data;
}

export async function loadConfig(path: string, options: LoadConfigOptions = {}): Promise<ConfigDocument> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError(`配置文件不存在：${path}\n请先运行 ai-quota account add`);
    }
    throw error;
  }
  const value = parseConfigValue(text, path);
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  const version = record?.version;
  if (version === 0) {
    if (!options.confirmMigration) {
      throw new ConfigError("配置版本 0 需要迁移到版本 1；请通过交互式命令确认迁移");
    }
    if (!(await options.confirmMigration(0, 1))) throw new ConfigError("已取消配置迁移");
    const migrated = validateConfig({ ...record, version: 1 });
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const backup = `${path}.backup-v0-${stamp}`;
    await copyFile(path, backup, fsConstants.COPYFILE_EXCL);
    await chmod(backup, 0o600);
    const migratedText = updateTextPreservingComments(text, migrated, migrated);
    await atomicWrite(path, migratedText);
    return { path, text: migratedText, config: migrated, fingerprint: fingerprint(migratedText) };
  }
  if (version !== 1) {
    throw new ConfigError(`不支持的配置版本：${String(version ?? "缺失")}`);
  }
  const config = validateConfig(value);
  return { path, text, config, fingerprint: fingerprint(text) };
}

export async function inspectConfigPermissions(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.mode & 0o077 ? `配置文件权限过宽（${(info.mode & 0o777).toString(8)}），建议设置为 600` : null;
  } catch {
    return null;
  }
}

function renderInitialConfig(config: Config): string {
  return `// ai-quota 统一账号配置。此文件可能包含明文凭据。\n${JSON.stringify(config, null, 2)}\n`;
}

function updateAccountFields(
  text: string,
  index: number,
  current: Config["accounts"][number],
  next: Config["accounts"][number],
  formattingOptions: { insertSpaces: boolean; tabSize: number; eol: string },
): string {
  let updated = text;
  const currentRecord = current as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(currentRecord), ...Object.keys(nextRecord)]);
  for (const key of keys) {
    if (Object.is(currentRecord[key], nextRecord[key])) continue;
    updated = applyEdits(
      updated,
      modify(updated, ["accounts", index, key], nextRecord[key], { formattingOptions }),
    );
  }
  return updated;
}

function updateTextPreservingComments(text: string, config: Config, current?: Config): string {
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  let updated = applyEdits(text, modify(text, ["version"], config.version, { formattingOptions }));
  if (!current) {
    updated = applyEdits(updated, modify(updated, ["accounts"], config.accounts, { formattingOptions }));
  } else if (config.accounts.length === current.accounts.length) {
    config.accounts.forEach((account, index) => {
      updated = updateAccountFields(updated, index, current.accounts[index]!, account, formattingOptions);
    });
  } else if (
    config.accounts.length > current.accounts.length &&
    current.accounts.every((account, index) => config.accounts[index]?.id === account.id)
  ) {
    for (const [offset, account] of config.accounts.slice(current.accounts.length).entries()) {
      updated = applyEdits(
        updated,
        modify(updated, ["accounts", current.accounts.length + offset], account, {
          formattingOptions,
          isArrayInsertion: true,
        }),
      );
    }
  } else if (config.accounts.length === current.accounts.length - 1) {
    const removedIndex = current.accounts.findIndex(
      (_account, index) => current.accounts[index + 1]?.id === config.accounts[index]?.id,
    );
    const index = removedIndex >= 0 ? removedIndex : current.accounts.length - 1;
    const without = current.accounts.filter((_account, candidate) => candidate !== index);
    if (without.every((account, candidate) => account.id === config.accounts[candidate]?.id)) {
      updated = applyEdits(updated, modify(updated, ["accounts", index], undefined, { formattingOptions }));
    } else {
      updated = applyEdits(updated, modify(updated, ["accounts"], config.accounts, { formattingOptions }));
    }
  } else {
    updated = applyEdits(updated, modify(updated, ["accounts"], config.accounts, { formattingOptions }));
  }
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.config.jsonc.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function createConfig(path: string, config: Config): Promise<ConfigDocument> {
  const validated = configSchema.parse(config);
  const text = renderInitialConfig(validated);
  await atomicWrite(path, text);
  return { path, text, config: validated, fingerprint: fingerprint(text) };
}

export async function saveConfig(document: ConfigDocument, next: Config): Promise<ConfigDocument> {
  const validated = configSchema.parse(next);
  const currentText = await readFile(document.path, "utf8");
  if (fingerprint(currentText) !== document.fingerprint) {
    throw new ConfigError("配置文件在操作期间已被修改，已拒绝覆盖；请重新执行命令");
  }
  const text = updateTextPreservingComments(currentText, validated, document.config);
  await atomicWrite(document.path, text);
  return { path: document.path, text, config: validated, fingerprint: fingerprint(text) };
}

export async function loadOrCreateEmptyConfig(
  path: string,
  options: LoadConfigOptions = {},
): Promise<ConfigDocument> {
  try {
    return await loadConfig(path, options);
  } catch (error) {
    if (error instanceof ConfigError && error.message.startsWith("配置文件不存在")) {
      return createConfig(path, { version: 1, accounts: [] });
    }
    throw error;
  }
}
