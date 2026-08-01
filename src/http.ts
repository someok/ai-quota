import { setTimeout as delay } from "node:timers/promises";

import { proxyAwareFetch } from "./proxy.js";

export interface RequestOptions {
  timeoutMs?: number;
  retries?: number;
  fetchFn?: typeof fetch;
  secrets?: readonly string[];
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

class RequestTimeoutError extends Error {
  override readonly name = "AbortError";
}

function retryable(error: unknown): boolean {
  if (error instanceof HttpError && error.status !== undefined) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

export async function request<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  options: RequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  const fetchFn = options.fetchFn ?? proxyAwareFetch;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      const transaction = (async () => {
        const response = await fetchFn(url, { ...init, signal: controller.signal });
        if (!response.ok) {
          let detail = "";
          try {
            detail = (await response.text()).replace(/[\r\n\t]+/gu, " ").slice(0, 200);
          } catch {
            // 保留状态码作为主要错误。
          }
          throw new HttpError(`HTTP ${response.status}${detail ? `：${detail}` : ""}`, response.status);
        }
        return consume(response, controller.signal);
      })();
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new RequestTimeoutError(`请求超时（${timeoutMs}ms）`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      return await Promise.race([transaction, timedOut]);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !retryable(error)) throw lastError;
      await delay(250 * 2 ** attempt + Math.floor(Math.random() * 100));
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  throw lastError;
}

export async function readBoundedJson(response: Response, maxBytes = 512 * 1024): Promise<unknown> {
  if (!response.body) throw new Error("响应体为空");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("响应体过大");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("响应体过大");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
