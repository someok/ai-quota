import type { Account } from "./types.js";

const SECRET_FIELD_NAMES = new Set([
  "apiKey",
  "managementKey",
  "accessToken",
  "refreshToken",
  "authCookie",
  "cookie",
]);

export function accountSecrets(account: Account): string[] {
  const record = account as unknown as Record<string, unknown>;
  return [...SECRET_FIELD_NAMES]
    .map((name) => record[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  const candidates = [...secrets]
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of candidates) {
    result = result.split(secret).join("[已脱敏]");
  }
  result = result
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [已脱敏]")
    .replace(/(?:sk|tp|xai|oc)[-_][A-Za-z0-9._-]{8,}/gu, "[已脱敏]")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return result.slice(0, 400) || "未知错误";
}

export function masked(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}
