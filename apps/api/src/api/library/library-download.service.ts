import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Asset, User } from "@prisma/client";
import { AssetStorageService } from "../storage/asset-storage.service";
import { downloadImageViaProxy } from "../storage/proxy-fetch";
import { PrismaService } from "../../prisma/prisma.service";
import { ZipWriter } from "./zip-writer";

/** 单个文件名的日期部分长度，YYYY-MM-DD。 */
const DATE_PREFIX_LENGTH = 10;
/** 资产 id 哈希取前几位，足以区分又不至于文件名过长。 */
const HASH_PREFIX_LENGTH = 8;
const MAX_BATCH_DOWNLOAD = 200;
/** 同时拉取的远端作品数量上限。 */
const DOWNLOAD_CONCURRENCY = 8;
/** 单个远端作品的下载超时；失效的上游链接不能无限期占住下载。 */
const ASSET_FETCH_TIMEOUT_MS = 20_000;

export interface LibraryDownloadEntry {
  assetId: string;
  fileName: string;
}

@Injectable()
export class LibraryDownloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly assetStorage: AssetStorageService,
  ) {}

  /**
   * 文件名规则：日期 + 哈希前几位 + 原扩展名，例如
   * `2026-10-09_a1b2c3d4.png`。
   * 日期取作品生成日期，哈希由资产 id 派生（稳定、可复现、不暴露内容）。
   */
  buildFileName(asset: Pick<Asset, "id" | "createdAt" | "storageKey" | "mimeType">) {
    const createdAt = asset.createdAt instanceof Date ? asset.createdAt : new Date(asset.createdAt);
    const date = isValidDate(createdAt)
      ? createdAt.toISOString().slice(0, DATE_PREFIX_LENGTH)
      : new Date().toISOString().slice(0, DATE_PREFIX_LENGTH);
    const hash = createHash("sha256").update(asset.id).digest("hex").slice(0, HASH_PREFIX_LENGTH);
    return `${date}_${hash}${resolveExtension(asset)}`;
  }

  /** 预览本次批量下载会生成的文件名（不落盘、不读文件内容）。 */
  async planDownload(
    user: Pick<User, "id" | "role">,
    assetIds: string[],
  ): Promise<LibraryDownloadEntry[]> {
    const assets = await this.resolveAssets(user, assetIds);
    return assets.map((asset) => ({
      assetId: asset.id,
      fileName: this.buildFileName(asset),
    }));
  }

  /**
   * 以异步生成器方式产出 ZIP 字节块，边读边发，避免把整包攒在内存里。
   * 已在调用方保证 assetIds 非空且归属当前用户。
   */
  async *streamDownload(
    user: Pick<User, "id" | "role">,
    assetIds: string[],
  ): AsyncGenerator<Buffer> {
    const assets = await this.resolveAssets(user, assetIds);
    if (!assets.length) {
      throw new BadRequestException("没有可下载的作品。");
    }

    const writer = new ZipWriter();
    let skipped = 0;

    // 先按并发窗口把字节取回来，再按原顺序写入 zip。
    // 远端链接失效时单次连接要等满超时，串行逐个取会让整个下载看起来像卡死
    // （153 张 × 10 秒 ≈ 25 分钟），并发取能把这段等待压到一两轮。
    const pending = new Map<number, Promise<Buffer | undefined>>();
    let nextIndex = 0;
    const prefetch = () => {
      while (nextIndex < assets.length && pending.size < DOWNLOAD_CONCURRENCY) {
        const index = nextIndex;
        nextIndex += 1;
        pending.set(
          index,
          this.readAssetBytes(assets[index]).catch(() => undefined),
        );
      }
    };

    prefetch();
    for (let index = 0; index < assets.length; index += 1) {
      const bytes = await pending.get(index);
      pending.delete(index);
      prefetch();

      if (!bytes) {
        // 单个资产读不到不应让整包失败，跳过并继续。
        skipped += 1;
        continue;
      }
      writer.add(this.buildFileName(assets[index]), bytes, toDate(assets[index].createdAt));
      for (const chunk of writer.drain()) {
        yield chunk;
      }
    }

    if (skipped > 0) {
      // 在收尾前补一个说明文件，让用户知道有作品没进包，而不是少了几张却无提示。
      writer.add(
        "README.txt",
        Buffer.from(
          `有 ${skipped} 个作品读取失败，未包含在本包中。\n可稍后重试，或改用单个下载。\n`,
          "utf8",
        ),
        new Date(),
      );
    }

    writer.finish();
    for (const chunk of writer.drain()) {
      yield chunk;
    }

    if (!writer.fileCount) {
      throw new BadRequestException("所选作品当前都无法读取，下载已取消。");
    }
  }

  /** 读取单个资产的字节；本地存储直接读文件，远端地址走 HTTP 拉取。 */
  private async readAssetBytes(asset: Asset): Promise<Buffer | undefined> {
    const resolution = await this.assetStorage.resolveContent(asset);
    if (!resolution) {
      return undefined;
    }

    if (resolution.kind === "local") {
      return readFile(resolution.filePath).catch(() => undefined);
    }

    if (resolution.kind === "remote") {
      return resolution.buffer;
    }

    if (resolution.kind === "redirect") {
      return fetchAssetBytes(resolution.redirectUrl);
    }

    if (resolution.kind === "upstream-url") {
      return fetchAssetBytes(resolution.upstreamUrl);
    }

    return undefined;
  }

  private async resolveAssets(
    user: Pick<User, "id" | "role">,
    assetIds: string[],
  ): Promise<Asset[]> {
    const uniqueIds = [...new Set(assetIds.map((id) => id.trim()).filter(Boolean))];
    if (!uniqueIds.length) {
      throw new BadRequestException("请选择要下载的作品。");
    }
    if (uniqueIds.length > MAX_BATCH_DOWNLOAD) {
      throw new BadRequestException(
        `一次最多下载 ${MAX_BATCH_DOWNLOAD} 个作品，请分批选择。`,
      );
    }

    const assets = await this.prisma.asset.findMany({
      where: { id: { in: uniqueIds } },
    });

    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const ordered: Asset[] = [];
    for (const id of uniqueIds) {
      const asset = byId.get(id);
      if (!asset) {
        throw new BadRequestException(`作品不存在：${id}`);
      }
      // 与单文件下载保持一致：非管理员只能取自己的作品。
      if (user.role !== "admin" && asset.userId !== user.id) {
        throw new ForbiddenException("你只能下载自己的作品。");
      }
      ordered.push(asset);
    }

    return ordered;
  }
}

function toDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return isValidDate(date) ? date : new Date();
}

function isValidDate(date: Date) {
  return !Number.isNaN(date.getTime());
}

function resolveExtension(asset: Pick<Asset, "storageKey" | "mimeType">) {
  const fromKey = /\.[a-zA-Z0-9]{2,5}$/.exec(asset.storageKey ?? "")?.[0];
  if (fromKey) {
    return fromKey.toLowerCase();
  }

  switch (asset.mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

async function fetchAssetBytes(url: string) {
  // 必须带超时并走代理：上游临时链接失效时连接会一直挂着，
  // 而只能经系统代理出网时全局 fetch 又根本不走代理。
  return downloadImageViaProxy(url, ASSET_FETCH_TIMEOUT_MS);
}
