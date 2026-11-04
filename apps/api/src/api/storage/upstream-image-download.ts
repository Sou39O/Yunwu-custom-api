/**
 * 下载上游返回的图片字节。
 *
 * 生成阶段和后台补存都依赖这段逻辑，抽出来是为了让重试语义只有一份：
 * 上游图片 CDN 偶发超时/5xx 时重试，4xx 直接判定链接失效（临时链接过期就是 403/404）。
 *
 * 必须走 proxy-fetch 而不是全局 fetch：Node 内置 fetch 不读代理环境变量，
 * 在只能通过系统代理访问境外 CDN 的机器上会一直直连超时，作品于是存不下来。
 */

import { fetchViaProxy } from "./proxy-fetch";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 800;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface DownloadUpstreamImageOptions {
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export async function downloadUpstreamImage(
  url: string,
  options: DownloadUpstreamImageOptions = {},
): Promise<Buffer | undefined> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await delay(retryDelayMs * attempt);
    }

    try {
      const result = await fetchViaProxy(url, { timeoutMs });
      if (result.status >= 200 && result.status < 300) {
        return result.body.length ? result.body : undefined;
      }
      // 4xx 是链接本身无效（临时链接过期就是 403/404），重试没有意义。
      if (result.status >= 400 && result.status < 500) {
        return undefined;
      }
    } catch {
      // 连接中断/超时走下一轮重试。
    }
  }

  return undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
