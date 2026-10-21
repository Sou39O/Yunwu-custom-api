import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Asset, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AssetStorageService } from "./asset-storage.service";
import { downloadUpstreamImage } from "./upstream-image-download";

/** 每轮最多补存多少个资产，避免启动瞬间打满上游带宽。 */
const BACKFILL_BATCH_SIZE = 20;
/** 扫描间隔：生成阶段已经会落盘，这里只是兜底。 */
const BACKFILL_INTERVAL_MS = 10 * 60 * 1000;
/** 单轮内最多连续补几批，避免启动时长时间占用带宽。 */
const BACKFILL_MAX_ROUNDS = 10;
/** 单个资产的下载超时。上游临时链接常常已经失效，别让一个卡住整轮。 */
const BACKFILL_FETCH_TIMEOUT_MS = 45_000;

/**
 * 把只存了上游 URL 的作品补下载到本地。
 *
 * 生成阶段如果上游图片 CDN 下载失败，作品会退化成 `storage: "remote-url"`
 * 且没有 storageKey——这类作品的 URL 大多会过期，过期后既下载不了也看不了。
 * 这里在服务启动后和运行期间定期把还能拉到的补回本地存储。
 */
@Injectable()
export class AssetPersistenceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AssetPersistenceService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly assetStorage: AssetStorageService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap() {
    if ((this.config.get<string>("assetBackfill.enabled") ?? "true") === "false") {
      return;
    }

    // 启动后稍等一下，让迁移与健康检查先跑完。
    this.timer = setTimeout(() => void this.runOnce(), 15_000);
    this.timer.unref?.();
  }

  async runOnce(): Promise<{ persisted: number; failed: number }> {
    if (this.running) {
      return { persisted: 0, failed: 0 };
    }
    this.running = true;

    let persisted = 0;
    let failed = 0;

    try {
      // 积压可能上百个，一轮 20 个要等到下一轮才继续太慢；
      // 只要本批还捞到可下载的就接着跑，直到没有更多。
      for (let round = 0; round < BACKFILL_MAX_ROUNDS; round += 1) {
        const candidates = await this.prisma.asset.findMany({
          where: {
            storageKey: null,
            type: "generated",
            status: "ready",
            url: { not: null },
          },
          orderBy: { createdAt: "desc" },
          take: BACKFILL_BATCH_SIZE,
        });

        if (!candidates.length) {
          break;
        }

        let roundPersisted = 0;
        for (const asset of candidates) {
          if (!asset.url || !/^https?:\/\//i.test(asset.url)) {
            continue;
          }

          const buffer = await this.download(asset.url);
          if (!buffer) {
            failed += 1;
            continue;
          }

          try {
            await this.persist(asset, buffer);
            persisted += 1;
            roundPersisted += 1;
          } catch (error) {
            failed += 1;
            this.logger.warn(
              `Failed to persist asset ${asset.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        if (roundPersisted > 0) {
          this.logger.log(
            `Asset backfill: persisted ${roundPersisted} in round ${round + 1}.`,
          );
        }

        // 一个都没成功说明剩下的都拉不到，再用同样条件查下去只会空转。
        if (roundPersisted === 0) {
          break;
        }
        if (candidates.length < BACKFILL_BATCH_SIZE) {
          break;
        }
      }

      return { persisted, failed };
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  private scheduleNext() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.runOnce(), BACKFILL_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async download(url: string) {
    return downloadUpstreamImage(url, { timeoutMs: BACKFILL_FETCH_TIMEOUT_MS });
  }

  private async persist(asset: Asset, buffer: Buffer) {
    const mimeType = asset.mimeType ?? "image/png";
    const storageKey = `${Date.now()}-${asset.id}-${randomSuffix()}.${extensionFromMimeType(
      mimeType,
    )}`;
    const storage = await this.assetStorage.store({ buffer, storageKey, mimeType });
    const url = this.assetStorage.getPublicUrl(storageKey, storage);

    const metadata = readMetadata(asset.metadata);
    await this.prisma.asset.update({
      where: { id: asset.id },
      data: {
        storageKey,
        url,
        metadata: {
          ...metadata,
          storage: storage.kind,
          ...(storage.objectUrl ? { objectUrl: storage.objectUrl } : {}),
          backfilledAt: new Date().toISOString(),
          upstreamUrl: asset.url ?? undefined,
        } as Prisma.InputJsonObject,
      },
    });
  }
}

function readMetadata(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

function extensionFromMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}
