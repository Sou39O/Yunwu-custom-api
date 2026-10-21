import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Asset, Prisma } from "@prisma/client";
import type {
  AssetContentResolution,
  StoreAssetInput,
  StoredAssetLocation,
} from "./asset-storage.types";
import { LocalAssetStorageService } from "./local-asset-storage.service";
import { S3AssetStorageService } from "./s3-asset-storage.service";

@Injectable()
export class AssetStorageService {
  constructor(
    private readonly config: ConfigService,
    private readonly localStorage: LocalAssetStorageService,
    private readonly s3Storage: S3AssetStorageService,
  ) {}

  async store(input: StoreAssetInput): Promise<StoredAssetLocation> {
    if (this.shouldUseS3()) {
      return this.s3Storage.store(input);
    }

    return this.localStorage.store(input);
  }

  async resolveContent(
    asset: Pick<Asset, "storageKey" | "metadata" | "url">,
  ): Promise<AssetContentResolution | undefined> {
    const metadata = this.readMetadata(asset.metadata);

    // 早期生成的资产可能只留了上游 URL（下载字节失败时退化成 remote-url），
    // 没有 storageKey 也要能用上游地址兜底，否则这些作品在批量下载里会被整片跳过。
    if (!asset.storageKey) {
      return asset.url && /^https?:\/\//i.test(asset.url)
        ? { kind: "upstream-url", upstreamUrl: asset.url }
        : undefined;
    }

    if (metadata.storage === "s3") {
      return this.s3Storage.resolve(asset.storageKey, metadata.objectUrl);
    }

    return this.localStorage.resolve(asset.storageKey);
  }

  getPublicUrl(storageKey: string, stored: StoredAssetLocation) {
    if (stored.kind === "s3" && stored.objectUrl) {
      return stored.objectUrl;
    }

    return this.localStorage.getPublicUrl(storageKey);
  }

  private readMetadata(metadata: Prisma.JsonValue | null | undefined) {
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
      return {};
    }

    const record = metadata as Record<string, unknown>;
    return {
      storage: typeof record.storage === "string" ? record.storage : undefined,
      objectUrl: typeof record.objectUrl === "string" ? record.objectUrl : undefined,
    };
  }

  private shouldUseS3() {
    const mode = this.config.get<string>("storage.mode");
    if (mode === "local") {
      return false;
    }

    return this.s3Storage.isEnabled();
  }
}
