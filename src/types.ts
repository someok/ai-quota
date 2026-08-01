import { z } from "zod";

export const PROVIDER_IDS = [
  "deepseek",
  "codex",
  "opencode-go",
  "opencode-zen",
  "kimi-code",
  "xai-supergrok",
  "xai-api-platform",
  "xiaomi-mimo",
] as const;

export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

const commonFields = {
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "账号 id 只能包含字母、数字、点、下划线和连字符"),
  label: z.string().min(1).max(100).optional(),
  enabled: z.boolean().default(true),
};

const apiKeySchema = z.string().min(1).max(16_384);
const tokenSchema = z.string().min(1).max(64 * 1024);

export const deepSeekAccountSchema = z.object({
  ...commonFields,
  provider: z.literal("deepseek"),
  apiKey: apiKeySchema,
});

export const codexAccountSchema = z.object({
  ...commonFields,
  provider: z.literal("codex"),
  accessToken: tokenSchema,
  refreshToken: tokenSchema.optional(),
  accountId: z.string().min(1).max(512).optional(),
  expiresAt: z.number().int().positive().optional(),
});

export const openCodeGoAccountSchema = z.object({
  ...commonFields,
  provider: z.literal("opencode-go"),
  workspaceId: z.string().min(1).max(512),
  authCookie: tokenSchema,
});

export const openCodeZenAccountSchema = z.object({
  ...commonFields,
  provider: z.literal("opencode-zen"),
  workspaceId: z.string().min(1).max(512),
  authCookie: tokenSchema,
});

export const kimiCodeAccountSchema = z.object({
  ...commonFields,
  provider: z.literal("kimi-code"),
  apiKey: apiKeySchema,
});

export const xaiSuperGrokAccountSchema = z.object({
  ...commonFields,
  provider: z.literal("xai-supergrok"),
  accessToken: tokenSchema,
  refreshToken: tokenSchema.optional(),
  expiresAt: z.number().int().positive().optional(),
});

export const xaiApiPlatformAccountSchema = z.object({
  ...commonFields,
  provider: z.literal("xai-api-platform"),
  managementKey: apiKeySchema,
  teamId: z.string().min(1).max(512),
});

export const xiaomiMimoAccountSchema = z.object({
  ...commonFields,
  provider: z.literal("xiaomi-mimo"),
  cookie: tokenSchema,
});

export const accountSchema = z.discriminatedUnion("provider", [
  deepSeekAccountSchema,
  codexAccountSchema,
  openCodeGoAccountSchema,
  openCodeZenAccountSchema,
  kimiCodeAccountSchema,
  xaiSuperGrokAccountSchema,
  xaiApiPlatformAccountSchema,
  xiaomiMimoAccountSchema,
]);

export type Account = z.infer<typeof accountSchema>;
export type DeepSeekAccount = z.infer<typeof deepSeekAccountSchema>;
export type CodexAccount = z.infer<typeof codexAccountSchema>;
export type OpenCodeGoAccount = z.infer<typeof openCodeGoAccountSchema>;
export type OpenCodeZenAccount = z.infer<typeof openCodeZenAccountSchema>;
export type KimiCodeAccount = z.infer<typeof kimiCodeAccountSchema>;
export type XaiSuperGrokAccount = z.infer<typeof xaiSuperGrokAccountSchema>;
export type XaiApiPlatformAccount = z.infer<typeof xaiApiPlatformAccountSchema>;
export type XiaomiMimoAccount = z.infer<typeof xiaomiMimoAccountSchema>;

export const configSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(accountSchema),
  })
  .superRefine((config, context) => {
    const seen = new Set<string>();
    config.accounts.forEach((account, index) => {
      if (seen.has(account.id)) {
        context.addIssue({
          code: "custom",
          message: `账号 id 重复：${account.id}`,
          path: ["accounts", index, "id"],
        });
      }
      seen.add(account.id);
    });
  });

export type Config = z.infer<typeof configSchema>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ProviderSuccess {
  ok: true;
  source: string;
  data: Record<string, JsonValue>;
  fetchedAt: string;
}

export interface ProviderFailure {
  ok: false;
  source: string;
  error: string;
  fetchedAt: string;
}

export type ProviderResponse = ProviderSuccess | ProviderFailure;

export interface AccountResult {
  accountId: string;
  provider: ProviderId;
  label: string;
  response: ProviderResponse;
  fromCache: boolean;
  stale: boolean;
  durationMs: number;
  fallback?: ProviderSuccess;
}

export interface CollectContext {
  requestTimeoutMs: number;
  verbose: boolean;
  fetchFn?: typeof fetch;
}

export interface ProviderAdapter<TAccount extends Account = Account> {
  id: ProviderId;
  collect(account: TAccount, context: CollectContext): Promise<ProviderResponse>;
}

export function accountDisplayName(account: Account): string {
  return account.label ?? account.id;
}
