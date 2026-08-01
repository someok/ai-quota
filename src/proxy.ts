import {
  Agent,
  EnvHttpProxyAgent,
  Socks5ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";

function environmentValue(env: NodeJS.ProcessEnv, lower: string, upper: string): string | undefined {
  const value = env[lower] ?? env[upper];
  return value?.trim() || undefined;
}

function bypassesProxy(url: URL, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const hostname = url.hostname.toLowerCase();
  const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  return noProxy.split(/[,\s]+/u).some((rawEntry) => {
    if (!rawEntry) return false;
    if (rawEntry === "*") return true;
    const match = /^(.*?)(?::(\d+))?$/u.exec(rawEntry);
    if (!match) return false;
    const entryPort = match[2] ? Number(match[2]) : 0;
    if (entryPort && entryPort !== port) return false;
    const entry = (match[1] ?? "").replace(/^\*?\./u, "").toLowerCase();
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });
}

function fetchWithDispatcher(dispatcherForUrl: (url: URL) => Dispatcher): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const options = {
      ...(init ?? {}),
      dispatcher: dispatcherForUrl(url),
    } as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>;
    return undiciFetch(
      input as unknown as Parameters<typeof undiciFetch>[0],
      options,
    ) as unknown as Promise<Response>;
  };
}

export function createProxyAwareFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  let httpProxy = environmentValue(env, "http_proxy", "HTTP_PROXY");
  let httpsProxy = environmentValue(env, "https_proxy", "HTTPS_PROXY");
  const rawNoProxy = env.no_proxy ?? env.NO_PROXY;
  const noProxy = rawNoProxy?.trim();
  const allProxy = environmentValue(env, "all_proxy", "ALL_PROXY");

  if (!httpProxy && !httpsProxy && allProxy) {
    const protocol = new URL(allProxy).protocol;
    if (protocol === "socks:" || protocol === "socks5:") {
      const proxyAgent = new Socks5ProxyAgent(allProxy);
      const directAgent = new Agent();
      return fetchWithDispatcher((url) =>
        bypassesProxy(url, noProxy) ? directAgent : proxyAgent,
      );
    }
    if (protocol === "http:" || protocol === "https:") {
      httpProxy = allProxy;
      httpsProxy = allProxy;
    }
  }

  if (!httpProxy && !httpsProxy) return globalThis.fetch;
  const proxyAgent = new EnvHttpProxyAgent({
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy !== undefined ? { noProxy } : {}),
  });
  return fetchWithDispatcher(() => proxyAgent);
}

export const proxyAwareFetch = createProxyAwareFetch();
