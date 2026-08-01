import pc from "picocolors";

import type { Account, AccountResult, JsonValue, ProviderId, ProviderSuccess } from "./types.js";
import { masked } from "./security.js";

const PROVIDER_LABELS: Record<ProviderId, string> = {
  deepseek: "DeepSeek",
  codex: "Codex",
  "opencode-go": "OpenCode Go",
  "opencode-zen": "OpenCode Zen",
  "kimi-code": "Kimi Code",
  "xai-supergrok": "xAI SuperGrok",
  "xai-api-platform": "xAI API Platform",
  "xiaomi-mimo": "Xiaomi MiMo",
};

function useColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

function color(text: string, fn: (value: string) => string): string {
  return useColor() ? fn(text) : text;
}

function displayWidth(text: string): number {
  const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
  let width = 0;
  for (const character of plain) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character)) continue;
    width +=
      codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff01 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6))
        ? 2
        : 1;
  }
  return width;
}

function alignColons(lines: readonly string[]): string[] {
  const labelWidths = lines.map((line) => {
    const colon = line.indexOf(":");
    return colon < 0 ? null : displayWidth(line.slice(0, colon));
  });
  const maximum = Math.max(0, ...labelWidths.filter((width): width is number => width !== null));
  return lines.map((line, index) => {
    const width = labelWidths[index];
    return width === null || width === undefined ? line : `${" ".repeat(maximum - width)}${line}`;
  });
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "未知";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "未知";
  const relativeSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  const absolute = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const relative =
    Math.abs(relativeSeconds) < 120
      ? formatter.format(relativeSeconds, "second")
      : Math.abs(relativeSeconds) < 7_200
        ? formatter.format(Math.round(relativeSeconds / 60), "minute")
        : Math.abs(relativeSeconds) < 172_800
          ? formatter.format(Math.round(relativeSeconds / 3_600), "hour")
          : formatter.format(Math.round(relativeSeconds / 86_400), "day");
  return `${absolute}（${relative}）`;
}

function bar(usedPercent: number): string {
  const safe = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round(safe / 5);
  const body = `${"█".repeat(filled)}${"░".repeat(20 - filled)}`;
  const colored = safe >= 90 ? color(body, pc.red) : safe >= 70 ? color(body, pc.yellow) : color(body, pc.green);
  return `${colored} ${safe.toFixed(1)}%`;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: JsonValue): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return typeof value === "string" ? value : JSON.stringify(value);
}

function genericLines(value: JsonValue, prefix = "", depth = 0): string[] {
  if (depth > 3) return [`${prefix}: …`];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => genericLines(item, `${prefix}[${index + 1}]`, depth + 1));
  }
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      genericLines(child, prefix ? `${prefix}.${key}` : key, depth + 1),
    );
  }
  return [`${prefix}: ${scalar(value)}`];
}

function windowLines(data: Record<string, JsonValue>): string[] | null {
  if (!Array.isArray(data.windows)) return null;
  return data.windows.flatMap((window) => {
    if (!isObject(window)) return [];
    const usedPercent =
      typeof window.usedPercent === "number"
        ? window.usedPercent
        : typeof window.used === "number" && typeof window.limit === "number" && window.limit > 0
          ? (window.used / window.limit) * 100
          : typeof window.remainingPercent === "number"
            ? 100 - window.remainingPercent
            : null;
    const lines = [`${String(window.name ?? "额度")}: ${usedPercent === null ? "—" : bar(usedPercent)}`];
    if (typeof window.used === "number" && typeof window.limit === "number") {
      lines.push(`  已用: ${window.used} / ${window.limit}`);
    }
    if (typeof window.resetsAt === "string") lines.push(`  重置: ${formatTime(window.resetsAt)}`);
    return lines;
  });
}

function dataLines(provider: ProviderId, response: ProviderSuccess): string[] {
  const data = response.data;
  const windows = windowLines(data);
  if (windows) return windows;
  if (provider === "deepseek" && Array.isArray(data.balances)) {
    return data.balances.flatMap((balance) => {
      if (!isObject(balance)) return [];
      return [
        `${String(balance.currency)} 总余额: ${String(balance.total)}`,
        `  充值: ${String(balance.toppedUp)}，赠送: ${String(balance.granted)}`,
      ];
    });
  }
  if (
    provider === "xai-supergrok" &&
    (typeof data.usedPercent === "number" || typeof data.remainingPercent === "number")
  ) {
    const usedPercent =
      typeof data.usedPercent === "number" ? data.usedPercent : 100 - Number(data.remainingPercent);
    return [
      `${String(data.period)}: ${bar(usedPercent)}`,
      `重置: ${formatTime(typeof data.resetsAt === "string" ? data.resetsAt : null)}`,
    ];
  }
  if (provider === "opencode-zen") {
    return [
      `余额: $${Number(data.balanceUsd ?? 0).toFixed(2)}`,
      `本月: $${Number(data.monthlyUsageUsd ?? 0).toFixed(2)} / ${data.monthlyLimitUsd === null ? "不限" : `$${Number(data.monthlyLimitUsd).toFixed(2)}`}`,
      `最近付款: ${data.lastPaymentUsd === null ? "—" : `$${Number(data.lastPaymentUsd).toFixed(2)}`}`,
    ];
  }
  return genericLines(data);
}

export function renderResult(result: AccountResult, options: { verbose?: boolean; statusOnly?: boolean } = {}): string {
  const title = `${PROVIDER_LABELS[result.provider]} · ${result.label} (${result.accountId})`;
  const lines = [color(title, (value) => pc.bold(pc.cyan(value)))];
  if (result.response.ok) {
    if (!options.statusOnly) lines.push(...dataLines(result.provider, result.response));
    lines.push(
      color(
        `采集: ${formatTime(result.response.fetchedAt)}${result.fromCache ? " · 缓存" : ` · ${result.durationMs}ms`}`,
        pc.gray,
      ),
    );
  } else {
    lines.push(color(`查询失败: ${result.response.error}`, pc.red));
    if (result.fallback && !options.statusOnly) {
      lines.push(color(`以下为过期缓存（${formatTime(result.fallback.fetchedAt)}）`, pc.yellow));
      lines.push(...dataLines(result.provider, result.fallback));
    }
  }
  if (options.verbose) lines.push(`来源: ${result.response.source}`);
  return `${[lines[0], ...alignColons(lines.slice(1))].join("\n")}\n`;
}

export function renderSeparator(): string {
  return color("─".repeat(72), pc.gray);
}

export function renderAccountList(accounts: readonly Account[]): string {
  if (accounts.length === 0) return "尚未配置账号。\n";
  const rows = accounts.map((account) => {
    const record = account as unknown as Record<string, unknown>;
    const auth =
      typeof record.apiKey === "string"
        ? `API Key ${masked(record.apiKey)}`
        : typeof record.managementKey === "string"
          ? `管理密钥 ${masked(record.managementKey)}`
          : typeof record.accessToken === "string"
            ? `OAuth ${masked(record.accessToken)}`
            : typeof record.cookie === "string" || typeof record.authCookie === "string"
              ? "Cookie（已配置）"
              : "未知";
    return `${account.enabled ? "●" : "○"} ${account.id.padEnd(22)} ${PROVIDER_LABELS[account.provider].padEnd(18)} ${(account.label ?? "—").padEnd(16)} ${auth}`;
  });
  return `${rows.join("\n")}\n`;
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
}
