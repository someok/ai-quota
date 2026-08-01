import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";

import { proxyAwareFetch } from "./proxy.js";
import type { CodexAccount, XaiSuperGrokAccount } from "./types.js";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

interface OAuthOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  notify?: (message: string) => void;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function decodeJwt(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenMetadata(accessToken: string, idToken?: string, fallbackExpires = Date.now() + 3_600_000) {
  const accessClaims = decodeJwt(accessToken);
  const idClaims = decodeJwt(idToken);
  const authClaims = nestedRecord(idClaims?.["https://api.openai.com/auth"]);
  const profileClaims = nestedRecord(idClaims?.["https://api.openai.com/profile"]);
  const exp = typeof accessClaims?.exp === "number" ? accessClaims.exp * 1000 : fallbackExpires;
  const accountId =
    typeof authClaims?.chatgpt_account_id === "string"
      ? authClaims.chatgpt_account_id
      : typeof idClaims?.chatgpt_account_id === "string"
        ? idClaims.chatgpt_account_id
        : undefined;
  const email =
    typeof idClaims?.email === "string"
      ? idClaims.email
      : typeof profileClaims?.email === "string"
        ? profileClaims.email
        : undefined;
  return { expiresAt: exp, accountId, email };
}

async function oauthResponse(response: Response, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${operation}失败（HTTP ${response.status}）`);
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${operation}响应结构不兼容`);
  }
  return value as Record<string, unknown>;
}

function tokenSet(payload: Record<string, unknown>, now: number, priorRefresh?: string): TokenSet {
  if (typeof payload.access_token !== "string") throw new Error("OAuth 响应缺少 access_token");
  const refreshToken =
    typeof payload.refresh_token === "string" ? payload.refresh_token : priorRefresh;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : undefined;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3_600;
  const metadata = tokenMetadata(payload.access_token, idToken, now + expiresIn * 1000);
  return {
    accessToken: payload.access_token,
    expiresAt: metadata.expiresAt,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(metadata.accountId ? { accountId: metadata.accountId } : {}),
    ...(metadata.email ? { email: metadata.email } : {}),
  };
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function codexDeviceLogin(options: OAuthOptions): Promise<TokenSet> {
  const fetchFn = options.fetchFn ?? proxyAwareFetch;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const codeResponse = await fetchFn(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (codeResponse.status === 404) throw new Error("CODEX_DEVICE_UNAVAILABLE");
  const code = await oauthResponse(codeResponse, "Codex 设备码申请");
  if (typeof code.device_auth_id !== "string" || typeof code.user_code !== "string") {
    throw new Error("Codex 设备码响应结构不兼容");
  }
  const interval = Math.max(1, Number.parseInt(String(code.interval ?? "5"), 10) || 5);
  options.notify?.(`请打开 ${CODEX_ISSUER}/codex/device 并输入一次性代码：${code.user_code}`);
  const deadline = now() + 15 * 60_000;
  let exchange: Record<string, unknown> | null = null;
  while (now() < deadline) {
    const response = await fetchFn(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: code.device_auth_id, user_code: code.user_code }),
    });
    if (response.ok) {
      exchange = await oauthResponse(response, "Codex 设备授权");
      break;
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Codex 设备授权失败（HTTP ${response.status}）`);
    }
    await wait(interval * 1000);
  }
  if (!exchange) throw new Error("Codex 设备授权已超时");
  for (const field of ["authorization_code", "code_verifier"] as const) {
    if (typeof exchange[field] !== "string") throw new Error("Codex 设备授权响应结构不兼容");
  }
  const response = await fetchFn(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: exchange.authorization_code as string,
      redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: exchange.code_verifier as string,
    }),
  });
  return tokenSet(await oauthResponse(response, "Codex 令牌交换"), now());
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

async function codexBrowserLogin(options: OAuthOptions): Promise<TokenSet> {
  const fetchFn = options.fetchFn ?? proxyAwareFetch;
  const now = options.now ?? Date.now;
  const codes = pkce();
  const state = randomBytes(32).toString("base64url");
  let settle!: (value: { code: string } | { error: Error }) => void;
  const callback = new Promise<{ code: string } | { error: Error }>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (error || !code || returnedState !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("授权失败，可以关闭此页面。");
      settle({ error: new Error(error ?? "Codex OAuth 回调校验失败") });
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("授权成功，可以关闭此页面。");
    settle({ code });
  });
  let port: number;
  try {
    port = await listen(server, 1455);
  } catch {
    port = await listen(server, 1457);
  }
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const authorize = new URL(`${CODEX_ISSUER}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    code_challenge: codes.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "ai-quota",
  }).toString();
  options.notify?.(`设备码不可用，已切换浏览器授权：${authorize.toString()}`);
  openBrowser(authorize.toString());
  const timeout = new Promise<{ error: Error }>((resolve) =>
    setTimeout(() => resolve({ error: new Error("Codex 浏览器授权已超时") }), 5 * 60_000),
  );
  const result = await Promise.race([callback, timeout]);
  server.close();
  if ("error" in result) throw result.error;
  const response = await fetchFn(`${CODEX_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: result.code,
      redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: codes.verifier,
    }),
  });
  return tokenSet(await oauthResponse(response, "Codex 令牌交换"), now());
}

export async function loginCodex(options: OAuthOptions = {}): Promise<TokenSet> {
  try {
    return await codexDeviceLogin(options);
  } catch (error) {
    if (error instanceof Error && error.message === "CODEX_DEVICE_UNAVAILABLE") {
      return codexBrowserLogin(options);
    }
    throw error;
  }
}

async function xaiBrowserLogin(options: OAuthOptions): Promise<TokenSet> {
  const fetchFn = options.fetchFn ?? proxyAwareFetch;
  const now = options.now ?? Date.now;
  const codes = pkce();
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  let settle!: (value: { code: string } | { error: Error }) => void;
  const callback = new Promise<{ code: string } | { error: Error }>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:56121");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (error || !code || returnedState !== state) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("授权失败，可以关闭此页面。");
      settle({ error: new Error(error ?? "xAI OAuth 回调校验失败") });
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("授权成功，可以关闭此页面。");
    settle({ code });
  });
  await listen(server, 56121);
  const redirectUri = "http://127.0.0.1:56121/callback";
  const authorize = new URL("https://auth.x.ai/oauth2/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: XAI_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: XAI_SCOPE,
    code_challenge: codes.challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    plan: "generic",
    referrer: "ai-quota",
  }).toString();
  options.notify?.(`设备码不可用，已切换浏览器授权：${authorize.toString()}`);
  openBrowser(authorize.toString());
  const timeout = new Promise<{ error: Error }>((resolve) =>
    setTimeout(() => resolve({ error: new Error("xAI 浏览器授权已超时") }), 5 * 60_000),
  );
  const result = await Promise.race([callback, timeout]);
  server.close();
  if ("error" in result) throw result.error;
  const response = await fetchFn(XAI_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: result.code,
      redirect_uri: redirectUri,
      client_id: XAI_CLIENT_ID,
      code_verifier: codes.verifier,
    }),
  });
  return tokenSet(await oauthResponse(response, "xAI 令牌交换"), now());
}

export async function loginXai(options: OAuthOptions = {}): Promise<TokenSet> {
  const fetchFn = options.fetchFn ?? proxyAwareFetch;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  const deviceResponse = await fetchFn(XAI_DEVICE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }),
  });
  if (deviceResponse.status === 404 || deviceResponse.status === 405) {
    return xaiBrowserLogin(options);
  }
  const code = await oauthResponse(deviceResponse, "xAI 设备码申请");
  if (
    typeof code.device_code !== "string" ||
    typeof code.user_code !== "string" ||
    typeof code.verification_uri !== "string"
  ) {
    throw new Error("xAI 设备码响应结构不兼容");
  }
  options.notify?.(
    `请打开 ${String(code.verification_uri_complete ?? code.verification_uri)} 并输入一次性代码：${code.user_code}`,
  );
  let interval = Math.max(1, Number(code.interval) || 5) * 1000;
  const deadline = now() + Math.max(1, Number(code.expires_in) || 300) * 1000;
  while (now() < deadline) {
    const response = await fetchFn(XAI_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: XAI_CLIENT_ID,
        device_code: code.device_code,
      }),
    });
    if (response.ok) return tokenSet(await oauthResponse(response, "xAI 令牌交换"), now());
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (body.error === "slow_down") interval += 5_000;
    else if (body.error !== "authorization_pending") {
      throw new Error(`xAI 设备授权失败（${String(body.error ?? `HTTP ${response.status}`)}）`);
    }
    await wait(interval);
  }
  throw new Error("xAI 设备授权已超时");
}

export function oauthAccountNeedsRefresh(
  account: CodexAccount | XaiSuperGrokAccount,
  now = Date.now(),
): boolean {
  if (!account.refreshToken) return false;
  const claims = decodeJwt(account.accessToken);
  const jwtExpiry = typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
  const expiry = account.expiresAt ?? jwtExpiry;
  return expiry !== undefined && expiry <= now + 2 * 60_000;
}

export async function refreshOAuthAccount<T extends CodexAccount | XaiSuperGrokAccount>(
  account: T,
  options: OAuthOptions = {},
): Promise<T> {
  if (!oauthAccountNeedsRefresh(account, options.now?.() ?? Date.now())) return account;
  const fetchFn = options.fetchFn ?? proxyAwareFetch;
  const now = options.now?.() ?? Date.now();
  const isCodex = account.provider === "codex";
  const response = await fetchFn(isCodex ? `${CODEX_ISSUER}/oauth/token` : XAI_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": isCodex ? "application/json" : "application/x-www-form-urlencoded" },
    body: isCodex
      ? JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: account.refreshToken })
      : new URLSearchParams({ client_id: XAI_CLIENT_ID, grant_type: "refresh_token", refresh_token: account.refreshToken! }),
  });
  const tokens = tokenSet(await oauthResponse(response, `${isCodex ? "Codex" : "xAI"} 令牌刷新`), now, account.refreshToken);
  return {
    ...account,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? account.refreshToken,
    expiresAt: tokens.expiresAt,
    ...(isCodex && tokens.accountId ? { accountId: tokens.accountId } : {}),
  } as T;
}
