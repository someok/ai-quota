#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, InvalidArgumentError } from "commander";

import packageJson from "../package.json" with { type: "json" };

import {
  addAccount,
  editAccount,
  refreshConfiguredOAuthAccounts,
  removeAccount,
  setAccountEnabled,
} from "./accounts.js";
import { loadCache, removeCachedAccount, resolveCachePath } from "./cache.js";
import {
  ConfigError,
  inspectConfigPermissions,
  loadConfig,
  loadOrCreateEmptyConfig,
  resolveConfigPath,
} from "./config.js";
import { PromptSession } from "./prompt.js";
import { exitCodeForResults, queryAccounts } from "./query.js";
import { renderAccountList, renderResult, renderSeparator } from "./render.js";
import { PROVIDER_IDS, providerIdSchema, type Account, type ProviderId } from "./types.js";

interface GlobalOptions {
  account?: string;
  config?: string;
  refresh?: boolean;
  verbose?: boolean;
}

function providerArgument(value: string): ProviderId {
  const parsed = providerIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidArgumentError(`未知服务 ${value}；可用值：${PROVIDER_IDS.join(", ")}`);
  }
  return parsed.data;
}

function configPath(program: Command): string {
  const configured = (program.opts() as GlobalOptions).config;
  return resolveConfigPath(configured ? { cliPath: configured } : {});
}

async function warnPermissions(path: string): Promise<void> {
  const warning = await inspectConfigPermissions(path);
  if (warning) process.stderr.write(`警告：${warning}\n`);
}

async function loadWithMigration(path: string) {
  const prompt = new PromptSession();
  try {
    return await loadConfig(path, {
      confirmMigration: (from, to) => prompt.confirm(`配置需要从版本 ${from} 迁移到 ${to}；将先创建备份，是否继续？`),
    });
  } finally {
    prompt.close();
  }
}

async function loadOrCreateWithMigration(path: string) {
  const prompt = new PromptSession();
  try {
    return await loadOrCreateEmptyConfig(path, {
      confirmMigration: (from, to) => prompt.confirm(`配置需要从版本 ${from} 迁移到 ${to}；将先创建备份，是否继续？`),
    });
  } finally {
    prompt.close();
  }
}

function filterAccounts(accounts: readonly Account[], options: GlobalOptions, provider?: ProviderId): Account[] {
  return accounts.filter(
    (account) =>
      account.enabled &&
      (!provider || account.provider === provider) &&
      (!options.account || account.id === options.account),
  );
}

async function loadForQuery(program: Command) {
  const path = configPath(program);
  await warnPermissions(path);
  const refreshed = await refreshConfiguredOAuthAccounts(await loadWithMigration(path));
  refreshed.warnings.forEach((warning) => process.stderr.write(`OAuth 刷新警告：${warning}\n`));
  return refreshed.document;
}

async function runQuery(program: Command, provider?: ProviderId, statusOnly = false): Promise<void> {
  const options = program.opts() as GlobalOptions;
  const document = await loadForQuery(program);
  const accounts = filterAccounts(document.config.accounts, options, provider);
  if (accounts.length === 0) {
    throw new ConfigError("没有符合条件的已启用账号；可运行 ai-quota list 查看配置");
  }
  let renderedCount = 0;
  const results = await queryAccounts(accounts, {
    refresh: statusOnly || Boolean(options.refresh),
    verbose: Boolean(options.verbose),
    writeCache: !statusOnly,
    onResult(result) {
      const rendered = renderResult(result, { verbose: Boolean(options.verbose), statusOnly });
      const separator = renderedCount > 0 ? `\n${renderSeparator()}\n\n` : "";
      renderedCount += 1;
      (result.response.ok ? process.stdout : process.stderr).write(`${separator}${rendered}`);
    },
  });
  process.exitCode = exitCodeForResults(results);
}

async function withPrompt(action: (prompt: PromptSession) => Promise<void>): Promise<void> {
  const prompt = new PromptSession();
  try {
    await action(prompt);
  } finally {
    prompt.close();
  }
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("ai-quota")
    .description("统一查看多个 AI 服务账号的额度、余额和用量")
    .version(packageJson.version)
    .argument("[provider]", "仅查询指定服务", providerArgument)
    .option("--account <id>", "仅查询指定账号")
    .option("--config <path>", "配置文件路径")
    .option("--refresh", "忽略一分钟成功缓存")
    .option("--verbose", "显示采集来源和诊断信息")
    .action(async (provider?: ProviderId) => runQuery(program, provider));

  program
    .command("list")
    .description("本地列出所有账号及脱敏认证状态")
    .action(async () => {
      const path = configPath(program);
      await warnPermissions(path);
      const document = await loadWithMigration(path);
      process.stdout.write(renderAccountList(document.config.accounts));
    });

  program
    .command("status")
    .description("绕过缓存，只读验证账号认证和采集接口")
    .action(async () => runQuery(program, undefined, true));

  const account = program.command("account").description("交互式管理账号");
  account
    .command("add")
    .description("添加账号")
    .action(async () => {
      const initial = await loadOrCreateWithMigration(configPath(program));
      await withPrompt(async (prompt) => {
        const document = await addAccount(initial, prompt);
        process.stdout.write(`已添加账号，配置已安全写入 ${document.path}\n`);
      });
    });
  account
    .command("edit [id]")
    .description("编辑账号")
    .action(async (id?: string) => {
      const initial = await loadWithMigration(configPath(program));
      await withPrompt(async (prompt) => {
        const document = await editAccount(initial, prompt, id);
        process.stdout.write(`已更新账号，配置已安全写入 ${document.path}\n`);
      });
    });
  account
    .command("remove [id]")
    .description("删除账号")
    .action(async (id?: string) => {
      const initial = await loadWithMigration(configPath(program));
      await withPrompt(async (prompt) => {
        const result = await removeAccount(initial, prompt, id);
        if (!result.removed) {
          process.stdout.write("未做修改。\n");
          return;
        }
        const cachePath = resolveCachePath();
        await removeCachedAccount(
          cachePath,
          await loadCache(cachePath),
          result.removed.provider,
          result.removed.id,
        );
        process.stdout.write(`已删除账号 ${result.removed.id}。\n`);
      });
    });
  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    account
      .command(`${name} [id]`)
      .description(`${enabled ? "启用" : "禁用"}账号`)
      .action(async (id?: string) => {
        const initial = await loadWithMigration(configPath(program));
        await withPrompt(async (prompt) => {
          await setAccountEnabled(initial, prompt, enabled, id);
          process.stdout.write(`已${enabled ? "启用" : "禁用"}账号。\n`);
        });
      });
  }
  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({
    outputError(message, write) {
      write(`错误：${message.replace(/^error:\s*/iu, "")}`);
    },
  });
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) return;
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode || 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`错误：${message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  await runCli();
}
