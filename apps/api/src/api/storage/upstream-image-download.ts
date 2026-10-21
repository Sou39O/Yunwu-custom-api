/**
 * 下载上游返回的图片字节。
 *
 * 生成阶段和后台补存都依赖这段逻辑，抽出来是为了让重试语义只有一份：
 * 上游图片 CDN 偶发超时/5xx 时重试，4xx 直接判定链接失效（临时链接过期就是 403/404）。
 */

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
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        // 4xx 是链接本身无效，重试没有意义。
        if (response.status >= 400 && response.status < 500) {
          return undefined;
        }
        continue;
      }

      return Buffer.from(await response.arrayBuffer());
    } catch {
      // 超时/连接中断走下一轮重试。
    }
  }

  return undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
