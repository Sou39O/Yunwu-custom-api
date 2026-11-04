import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * 读取 Windows「系统代理」设置并转成 HTTP_PROXY / HTTPS_PROXY。
 *
 * 生成结果要落盘就得从上游图片 CDN 拉字节，而 Node 的 fetch 不读系统代理，
 * 只认这两组环境变量。很多用户只在代理软件里开了系统代理（没有设环境变量），
 * 服务进程就会直连境外 CDN 一直超时，作品于是只剩一个会过期的临时链接。
 */
export type SystemProxyEnv = {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY?: string;
  [key: string]: string | undefined;
};

/** 用户已经显式配置了代理时不再覆盖，尊重手动设置。 */
function hasConfiguredProxy(env: NodeJS.ProcessEnv) {
  return Boolean(
    env.HTTP_PROXY ||
      env.http_proxy ||
      env.HTTPS_PROXY ||
      env.https_proxy ||
      env.ALL_PROXY ||
      env.all_proxy,
  );
}

/**
 * 从注册表读 ProxyEnable / ProxyServer / ProxyOverride。
 * 读不到或没开启就返回空对象——绝不能让代理探测阻塞启动。
 */
export async function detectSystemProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SystemProxyEnv> {
  if (process.platform !== "win32" || hasConfiguredProxy(env)) {
    return {};
  }

  const settingsPath =
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const readValue = async (name: string) => {
    try {
      const { stdout } = await run("reg", ["query", settingsPath, "/v", name], {
        windowsHide: true,
        timeout: 5_000,
      });
      const match = stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "m"));
      return match?.[1]?.trim();
    } catch {
      return undefined;
    }
  };

  const [enabledRaw, serverRaw, overrideRaw] = await Promise.all([
    readValue("ProxyEnable"),
    readValue("ProxyServer"),
    readValue("ProxyOverride"),
  ]);

  if (enabledRaw !== "0x1" || !serverRaw) {
    return {};
  }

  const proxyUrl = toProxyUrl(serverRaw);
  if (!proxyUrl) {
    return {};
  }

  const result: SystemProxyEnv = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
  };

  // ProxyOverride 里常见的 <local> 表示内网直连；本地回环本来也不需要代理，
  // 但把 127.0.0.1/localhost 显式排除能避免个别代理软件劫持本机请求。
  const noProxy = buildNoProxy(overrideRaw);
  if (noProxy) {
    result.NO_PROXY = noProxy;
  }

  return result;
}

/** ProxyServer 可能是 "host:port"，也可能是 "http=host:port;https=host:port"。 */
function toProxyUrl(server: string) {
  const trimmed = server.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!trimmed.includes("=")) {
    return withScheme(trimmed);
  }

  const entries = new Map<string, string>();
  for (const part of trimmed.split(";")) {
    const [scheme, value] = part.split("=");
    if (scheme && value) {
      entries.set(scheme.trim().toLowerCase(), value.trim());
    }
  }

  const preferred = entries.get("https") ?? entries.get("http") ?? entries.get("socks");
  return preferred ? withScheme(preferred) : undefined;
}

function withScheme(value: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value;
  }
  return `http://${value}`;
}

function buildNoProxy(override: string | undefined) {
  const defaults = ["127.0.0.1", "localhost"];
  const extra = (override ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item && item !== "<local>");

  return [...new Set([...defaults, ...extra])].join(",");
}
