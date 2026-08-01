import type { Account, ProviderAdapter, ProviderId } from "../types.js";
import { codexAdapter } from "./codex.js";
import { deepSeekAdapter } from "./deepseek.js";
import { kimiCodeAdapter } from "./kimi-code.js";
import { openCodeGoAdapter } from "./opencode-go.js";
import { openCodeZenAdapter } from "./opencode-zen.js";
import { xaiApiPlatformAdapter } from "./xai-api-platform.js";
import { xaiSuperGrokAdapter } from "./xai-supergrok.js";
import { xiaomiMimoAdapter } from "./xiaomi-mimo.js";

const adapters = new Map<ProviderId, ProviderAdapter>([
  ["deepseek", deepSeekAdapter as ProviderAdapter],
  ["codex", codexAdapter as ProviderAdapter],
  ["opencode-go", openCodeGoAdapter as ProviderAdapter],
  ["opencode-zen", openCodeZenAdapter as ProviderAdapter],
  ["kimi-code", kimiCodeAdapter as ProviderAdapter],
  ["xai-supergrok", xaiSuperGrokAdapter as ProviderAdapter],
  ["xai-api-platform", xaiApiPlatformAdapter as ProviderAdapter],
  ["xiaomi-mimo", xiaomiMimoAdapter as ProviderAdapter],
]);

export function getAdapter(account: Account): ProviderAdapter {
  const adapter = adapters.get(account.provider);
  if (!adapter) throw new Error(`未实现的服务：${account.provider}`);
  return adapter;
}

export function hasProvider(provider: string): provider is ProviderId {
  return adapters.has(provider as ProviderId);
}
