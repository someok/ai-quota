import { createServer } from "node:http";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createProxyAwareFetch } from "../src/proxy.js";
import { loginCodex, loginXai } from "../src/oauth.js";

const servers: ReturnType<typeof createServer>[] = [];

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得测试端口");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("环境代理", () => {
  it("HTTP_PROXY 会让请求经过代理", async () => {
    const targetPort = await listen(createServer((_request, response) => response.end("target")));
    let proxyConnections = 0;
    const proxy = createServer();
    proxy.on("connect", (request, client) => {
      proxyConnections += 1;
      const [host, port] = (request.url ?? "").split(":");
      const upstream = connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
    });
    proxy.on("request", (_request, response) => {
      proxyConnections += 1;
      response.end("proxy");
    });
    const proxyPort = await listen(proxy);
    const proxyFetch = createProxyAwareFetch({
      http_proxy: `http://127.0.0.1:${proxyPort}`,
      https_proxy: `http://127.0.0.1:${proxyPort}`,
      no_proxy: "",
    });
    const response = await proxyFetch(`http://127.0.0.1:${targetPort}`);
    expect(await response.text()).toBe("target");
    expect(proxyConnections).toBeGreaterThan(0);
  });

  it("HTTPS_PROXY 会承载 Codex 和 xAI OAuth 请求", async () => {
    let proxyConnections = 0;
    const proxy = createServer();
    proxy.on("connect", (_request, client) => {
      proxyConnections += 1;
      client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    const proxyPort = await listen(proxy);
    const proxyFetch = createProxyAwareFetch({
      https_proxy: `http://127.0.0.1:${proxyPort}`,
      no_proxy: "",
    });
    await expect(loginCodex({ fetchFn: proxyFetch })).rejects.toThrow();
    await expect(loginXai({ fetchFn: proxyFetch })).rejects.toThrow();
    expect(proxyConnections).toBe(2);
  });

  it("NO_PROXY 会绕过代理", async () => {
    const targetPort = await listen(createServer((_request, response) => response.end("target")));
    let proxyConnections = 0;
    const proxyPort = await listen(createServer((_request, response) => {
      proxyConnections += 1;
      response.end("proxy");
    }));
    const proxyFetch = createProxyAwareFetch({
      HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: "127.0.0.1",
    });
    const response = await proxyFetch(`http://127.0.0.1:${targetPort}`);
    expect(await response.text()).toBe("target");
    expect(proxyConnections).toBe(0);
  });
});
