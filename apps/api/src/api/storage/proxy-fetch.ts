import { request as httpRequest } from "node:http";
import { connect as connectRaw } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

/**
 * 支持 HTTP(S)_PROXY 的图片下载器。
 *
 * 为什么不用全局 fetch：Node 内置 fetch（undici）**不读**代理环境变量，
 * 只在调用方显式传 dispatcher 时才走代理。很多用户只开了系统代理而没有
 * 给 undici 配置 dispatcher，于是 fetch 直连境外 CDN 一直超时——作品
 * 因此只能退化成会过期的上游临时链接，这就是「生成后没落盘」的根因。
 *
 * 默认的 http 模块在「自己接管的 socket」上行为不稳定（实测 https.request /
 * http.request 复用预握手 socket 都会 ETIMEDOUT），所以隧道内直接手写
 * HTTP/1.1 报文。只用 Node 标准库，不引入新依赖（https-proxy-agent 在本
 * 仓库只是间接依赖，不能直接 require）。
 */

export interface ProxyFetchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** 从一组环境变量里挑出代理地址；大小写都认，并遵守 NO_PROXY。 */
export function resolveProxyUrl(
  targetUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return undefined;
  }

  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  if (
    noProxy.some(
      (entry) =>
        entry === "*" ||
        host === entry ||
        (entry.startsWith("*.") && host.endsWith(entry.slice(1))) ||
        (entry.startsWith(".") && host.endsWith(entry)),
    )
  ) {
    return undefined;
  }

  const isHttps = parsed.protocol === "https:";
  const candidates = isHttps
    ? [
        env.HTTPS_PROXY,
        env.https_proxy,
        env.ALL_PROXY,
        env.all_proxy,
        env.HTTP_PROXY,
        env.http_proxy,
      ]
    : [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];

  return candidates.find((value) => Boolean(value?.trim()))?.trim();
}

/** 建立到目标主机的可读写连接：走代理时先 CONNECT 再按需 TLS。 */
async function openConnection(
  target: URL,
  proxy: string | undefined,
  timeoutMs: number,
): Promise<Duplex> {
  const raw = proxy
    ? await openTunnel(proxy, target, timeoutMs)
    : await openDirect(target, timeoutMs);

  if (target.protocol !== "https:") {
    return raw;
  }

  return await upgradeToTls(raw, target.hostname, timeoutMs);
}

function openDirect(target: URL, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connectRaw({
      host: target.hostname,
      port: Number(target.port || 443),
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`Connect timed out after ${timeoutMs}ms.`));
    });
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function openTunnel(proxy: string, target: URL, timeoutMs: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
    if (proxyUrl.protocol.startsWith("socks")) {
      reject(new Error("SOCKS 代理暂不支持，请在代理软件里开启 HTTP 代理。"));
      return;
    }

    const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
    const connectReq = httpRequest({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port || 80),
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: { Host: `${target.hostname}:${targetPort}` },
    });

    connectReq.setTimeout(timeoutMs, () => {
      connectReq.destroy(new Error("Proxy CONNECT timed out."));
    });
    connectReq.on("error", reject);
    connectReq.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with status ${response.statusCode}.`));
        return;
      }
      // CONNECT 请求的超时会残留在 socket 上，接管后必须清掉。
      connectReq.setTimeout(0);
      socket.setTimeout(0);
      resolve(socket);
    });
    connectReq.end();
  });
}

function upgradeToTls(
  socket: Duplex,
  servername: string,
  timeoutMs: number,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket: socket as never, servername });
    tlsSocket.setTimeout(timeoutMs, () => {
      tlsSocket.destroy(new Error("TLS handshake timed out."));
    });
    tlsSocket.once("secureConnect", () => {
      tlsSocket.setTimeout(0);
      resolve(tlsSocket);
    });
    tlsSocket.once("error", reject);
  });
}

/** 在已建立的连接上手写一次 HTTP/1.1 请求并解析响应。 */
function requestOverConnection(
  connection: Duplex,
  target: URL,
  timeoutMs: number,
  headOnly: boolean,
): Promise<ProxyFetchResult> {
  return new Promise((resolve, reject) => {
    const path = `${target.pathname}${target.search}`;
    const head = [
      `${headOnly ? "HEAD" : "GET"} ${path || "/"} HTTP/1.1`,
      `Host: ${target.host}`,
      "User-Agent: yunwu-desktop/1.0",
      "Accept: image/*,*/*",
      "Accept-Encoding: identity",
      "Connection: close",
      "",
      "",
    ].join("\r\n");

    let buffered = Buffer.alloc(0);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      connection.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Request timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    connection.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_BODY_BYTES) {
        clearTimeout(timer);
        finish(() => reject(new Error("Response body too large.")));
      }
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      finish(() => reject(error));
    });
    connection.on("end", () => {
      clearTimeout(timer);
      finish(() => {
        try {
          resolve(parseHttpResponse(buffered));
        } catch (error) {
          reject(error);
        }
      });
    });
    connection.on("close", () => {
      // 有些实现只发 close 不发 end。
      if (!settled) {
        clearTimeout(timer);
        finish(() => {
          try {
            resolve(parseHttpResponse(buffered));
          } catch (error) {
            reject(error);
          }
        });
      }
    });

    connection.write(head, "latin1");
  });
}

export function parseHttpResponse(buffer: Buffer): ProxyFetchResult {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    throw new Error("Incomplete HTTP response (no header terminator).");
  }

  const headerText = buffer.subarray(0, headerEnd).toString("latin1");
  const lines = headerText.split("\r\n");
  const statusLine = lines.shift() ?? "";
  const status = Number(statusLine.split(" ")[1] ?? 0);
  if (!status) {
    throw new Error(`Malformed HTTP status line: ${statusLine}`);
  }

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  let body = buffer.subarray(headerEnd + 4);

  if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
    body = decodeChunked(body);
  } else if (headers["content-length"]) {
    const length = Number(headers["content-length"]);
    if (Number.isFinite(length)) {
      body = body.subarray(0, length);
    }
  }

  return { status, headers, body };
}

function decodeChunked(input: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < input.length) {
    const lineEnd = input.indexOf("\r\n", offset);
    if (lineEnd < 0) break;

    const sizeText = input.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) break;
    offset = lineEnd + 2;
    if (size === 0) break;

    chunks.push(input.subarray(offset, offset + size));
    offset += size + 2;
  }

  return Buffer.concat(chunks);
}

/** 下载一个远端资源，自动跟随重定向，走代理时不额外依赖任何库。 */
export async function fetchViaProxy(
  rawUrl: string,
  options: { timeoutMs?: number; headOnly?: boolean } = {},
): Promise<ProxyFetchResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid asset url: ${rawUrl}`);
  }

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const proxy = resolveProxyUrl(url.toString());
    const connection = await openConnection(url, proxy, timeoutMs);
    const result = await requestOverConnection(
      connection,
      url,
      timeoutMs,
      options.headOnly ?? false,
    );

    if (![301, 302, 303, 307, 308].includes(result.status)) {
      return result;
    }

    const location = result.headers.location;
    if (!location) {
      return result;
    }
    url = new URL(location, url);
  }

  throw new Error("Too many redirects while downloading asset.");
}

/** 便捷封装：拿到字节，非 2xx 或空 body 返回 undefined。 */
export async function downloadImageViaProxy(
  url: string,
  timeoutMs = 45_000,
): Promise<Buffer | undefined> {
  try {
    const result = await fetchViaProxy(url, { timeoutMs });
    if (result.status < 200 || result.status >= 300) {
      return undefined;
    }
    return result.body.length ? result.body : undefined;
  } catch {
    return undefined;
  }
}
