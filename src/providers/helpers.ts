import { accountSecrets, redact } from "../security.js";
import type { Account, CollectContext, JsonValue, ProviderFailure, ProviderSuccess } from "../types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function isoTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
  }
  return null;
}

export function success(source: string, data: Record<string, JsonValue>): ProviderSuccess {
  return { ok: true, source, data, fetchedAt: new Date().toISOString() };
}

export function failure(source: string, error: unknown, account: Account): ProviderFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    source,
    error: redact(message, accountSecrets(account)),
    fetchedAt: new Date().toISOString(),
  };
}

export function fetchOptions(account: Account, context: CollectContext) {
  const base = {
    timeoutMs: context.requestTimeoutMs,
    retries: 2,
    secrets: accountSecrets(account),
  };
  return context.fetchFn ? { ...base, fetchFn: context.fetchFn } : base;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
