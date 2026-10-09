import type { ConfigDocument } from "./config.js";
import { saveConfig } from "./config.js";
import { loginCodex, loginXai, refreshOAuthAccount } from "./oauth.js";
import { PromptSession } from "./prompt.js";
import { accountSchema, PROVIDER_IDS, type Account, type ProviderId } from "./types.js";
import { providerLabel } from "./render.js";

const PROVIDER_OPTIONS = PROVIDER_IDS.map((provider) => ({ value: provider, label: providerLabel(provider) }));

function uniqueId(document: ConfigDocument, id: string, currentId?: string): void {
  if (document.config.accounts.some((account) => account.id === id && account.id !== currentId)) {
    throw new Error(`账号 id 已存在：${id}`);
  }
}

async function credentials(provider: ProviderId, prompt: PromptSession): Promise<Record<string, unknown>> {
  switch (provider) {
    case "deepseek":
    case "kimi-code":
      return { apiKey: await prompt.secret("API Key") };
    case "codex": {
      const tokens = await loginCodex({ notify: (message) => process.stdout.write(`${message}\n`) });
      return {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
        expiresAt: tokens.expiresAt,
        ...(tokens.email ? { suggestedLabel: tokens.email } : {}),
      };
    }
    case "opencode-go":
      return {
        authCookie: await prompt.secret("auth Cookie 值"),
      };
    case "xai-supergrok": {
      const tokens = await loginXai({ notify: (message) => process.stdout.write(`${message}\n`) });
      return {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        expiresAt: tokens.expiresAt,
        ...(tokens.email ? { suggestedLabel: tokens.email } : {}),
      };
    }
    case "xai-api-platform":
      return {
        managementKey: await prompt.secret("管理 API Key"),
        teamId: await prompt.text("团队编号", { required: true }),
      };
    case "xiaomi-mimo":
      return { cookie: await prompt.secret("完整 Cookie") };
  }
}

export async function addAccount(document: ConfigDocument, prompt: PromptSession): Promise<ConfigDocument> {
  const provider = await prompt.choose("选择服务", PROVIDER_OPTIONS);
  const id = await prompt.text("账号 id", { required: true });
  uniqueId(document, id);
  const auth = await credentials(provider, prompt);
  const suggestedLabel = typeof auth.suggestedLabel === "string" ? auth.suggestedLabel : undefined;
  delete auth.suggestedLabel;
  const label = await prompt.text("显示名称（可选）", suggestedLabel ? { defaultValue: suggestedLabel } : {});
  const account = accountSchema.parse({ id, provider, enabled: true, ...(label ? { label } : {}), ...auth });
  return saveConfig(document, { ...document.config, accounts: [...document.config.accounts, account] });
}

async function selectAccount(document: ConfigDocument, prompt: PromptSession, requested?: string): Promise<Account> {
  if (requested) {
    const account = document.config.accounts.find((candidate) => candidate.id === requested);
    if (!account) throw new Error(`未找到账号：${requested}`);
    return account;
  }
  if (document.config.accounts.length === 0) throw new Error("尚未配置账号");
  const id = await prompt.choose(
    "选择账号",
    document.config.accounts.map((account) => ({
      value: account.id,
      label: `${account.id} · ${providerLabel(account.provider)}${account.label ? ` · ${account.label}` : ""}`,
    })),
  );
  return document.config.accounts.find((account) => account.id === id)!;
}

async function editCredentials(account: Account, prompt: PromptSession): Promise<Record<string, unknown>> {
  switch (account.provider) {
    case "deepseek":
    case "kimi-code": {
      const apiKey = await prompt.secret("新 API Key", { keepExisting: true });
      return apiKey ? { apiKey } : {};
    }
    case "codex":
    case "xai-supergrok":
      if (await prompt.confirm("重新进行 OAuth 授权？")) return credentials(account.provider, prompt);
      return {};
    case "opencode-go": {
      const authCookie = await prompt.secret("新 auth Cookie 值", { keepExisting: true });
      return authCookie ? { authCookie } : {};
    }
    case "xai-api-platform": {
      const teamId = await prompt.text("团队编号", { defaultValue: account.teamId });
      const managementKey = await prompt.secret("新管理 API Key", { keepExisting: true });
      return { teamId, ...(managementKey ? { managementKey } : {}) };
    }
    case "xiaomi-mimo": {
      const cookie = await prompt.secret("新完整 Cookie", { keepExisting: true });
      return cookie ? { cookie } : {};
    }
  }
}

export async function editAccount(
  document: ConfigDocument,
  prompt: PromptSession,
  requested?: string,
): Promise<ConfigDocument> {
  const current = await selectAccount(document, prompt, requested);
  const id = await prompt.text("账号 id", { defaultValue: current.id });
  uniqueId(document, id, current.id);
  const label = await prompt.text("显示名称（输入 - 清除）", { defaultValue: current.label ?? "" });
  const auth = await editCredentials(current, prompt);
  delete auth.suggestedLabel;
  const edited = accountSchema.parse({
    ...current,
    ...auth,
    id,
    ...(label && label !== "-" ? { label } : { label: undefined }),
  });
  return saveConfig(document, {
    ...document.config,
    accounts: document.config.accounts.map((account) => (account.id === current.id ? edited : account)),
  });
}

export async function removeAccount(
  document: ConfigDocument,
  prompt: PromptSession,
  requested?: string,
): Promise<{ document: ConfigDocument; removed: Account | null }> {
  const account = await selectAccount(document, prompt, requested);
  if (!(await prompt.confirm(`确认删除账号 ${account.id}？`))) return { document, removed: null };
  const next = await saveConfig(document, {
    ...document.config,
    accounts: document.config.accounts.filter((candidate) => candidate.id !== account.id),
  });
  return { document: next, removed: account };
}

export async function setAccountEnabled(
  document: ConfigDocument,
  prompt: PromptSession,
  enabled: boolean,
  requested?: string,
): Promise<ConfigDocument> {
  const selected = await selectAccount(document, prompt, requested);
  return saveConfig(document, {
    ...document.config,
    accounts: document.config.accounts.map((account) =>
      account.id === selected.id ? accountSchema.parse({ ...account, enabled }) : account,
    ),
  });
}

export async function refreshConfiguredOAuthAccounts(
  document: ConfigDocument,
): Promise<{ document: ConfigDocument; warnings: string[] }> {
  const warnings: string[] = [];
  let changed = false;
  const accounts: Account[] = [];
  for (const account of document.config.accounts) {
    if (account.provider !== "codex" && account.provider !== "xai-supergrok") {
      accounts.push(account);
      continue;
    }
    try {
      const refreshed = await refreshOAuthAccount(account);
      changed ||= refreshed !== account;
      accounts.push(refreshed);
    } catch (error) {
      warnings.push(`${account.id}：${error instanceof Error ? error.message : String(error)}`);
      accounts.push(account);
    }
  }
  if (!changed) return { document, warnings };
  return { document: await saveConfig(document, { ...document.config, accounts }), warnings };
}
