import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import type { AssetRecord } from "./api.types";
import { AssetStorageService } from "./storage/asset-storage.service";
import type { UploadedAssetFile } from "./upload.types";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;

interface ImageInfo {
  mimeType: string;
  extension: string;
  width: number;
  height: number;
}

@Injectable()
export class AssetUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: AssetStorageService,
  ) {}

  async upload(
    user: AuthenticatedUser,
    file: UploadedAssetFile,
  ): Promise<AssetRecord> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException("A single image file is required.");
    }

    const size = file.size ?? file.buffer.length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException("File size must be less than 20MB.");
    }

    const image = this.readImageInfo(file.buffer);
    if (!image) {
      throw new BadRequestException("Only png, jpeg, gif, or webp images are supported.");
    }
    if (file.mimetype && file.mimetype !== image.mimeType) {
      throw new BadRequestException("File MIME type does not match image content.");
    }
    if (image.mimeType === "image/png" && size >= MAX_PNG_BYTES) {
      throw new BadRequestException("PNG uploads must be smaller than 4MB.");
    }
    if (
      image.width < 1 ||
      image.height < 1 ||
      image.width > MAX_IMAGE_DIMENSION ||
      image.height > MAX_IMAGE_DIMENSION
    ) {
      throw new BadRequestException(
        `Image dimensions must be between 1 and ${MAX_IMAGE_DIMENSION}px.`,
      );
    }

    const storageKey = this.createStorageKey(file.originalname, image.extension);
    const storedAsset = await this.storage.store({
      buffer: file.buffer,
      storageKey,
      mimeType: image.mimeType,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown storage error.";
      throw new InternalServerErrorException(`Failed to store uploaded asset. ${message}`);
    });

    const asset = await this.prisma.asset.create({
      data: {
        userId: user.id,
        type: "upload",
        mimeType: image.mimeType,
        storageKey,
        url: this.storage.getPublicUrl(storageKey, storedAsset),
        status: "ready",
        metadata: {
          width: image.width,
          height: image.height,
          size,
          originalName: file.originalname,
          storage: storedAsset.kind,
          ...(storedAsset.objectUrl ? { objectUrl: storedAsset.objectUrl } : {}),
        } satisfies Prisma.InputJsonObject,
      },
    });

    return {
      id: asset.id,
      taskId: asset.taskId ?? "",
      type: "upload",
      url: asset.url ?? "",
      storageKey: asset.storageKey ?? undefined,
      mimeType: asset.mimeType ?? undefined,
      width: image.width,
      height: image.height,
      createdAt: asset.createdAt.toISOString(),
    };
  }

  async getAssetContent(user: AuthenticatedUser, storageKey: string) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(storageKey)) {
      throw new BadRequestException("Invalid asset storage key.");
    }

    const asset = await this.prisma.asset.findFirst({
      where:
        user.role === "admin"
          ? { storageKey }
          : { storageKey, userId: user.id },
      select: { storageKey: true, metadata: true, url: true, userId: true },
      orderBy: { createdAt: "desc" },
    });
    if (!asset) {
      return undefined;
    }
    if (user.role !== "admin" && asset.userId && asset.userId !== user.id) {
      throw new ForbiddenException("You do not have access to this asset.");
    }

    return this.storage.resolveContent(asset);
  }

  private createStorageKey(originalName: string | undefined, extension: string) {
    const safeBaseName = (originalName ?? "upload")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const baseName = safeBaseName || "upload";

    return `${Date.now()}-${randomUUID()}-${baseName}.${extension}`;
  }

  private readImageInfo(buffer: Buffer): ImageInfo | undefined {
    return (
      this.readPngInfo(buffer) ??
      this.readJpegInfo(buffer) ??
      this.readGifInfo(buffer) ??
      this.readWebpInfo(buffer)
    );
  }

  private readPngInfo(buffer: Buffer): ImageInfo | undefined {
    if (
      buffer.length < 24 ||
      buffer.readUInt32BE(0) !== 0x89504e47 ||
      buffer.readUInt32BE(4) !== 0x0d0a1a0a
    ) {
      return undefined;
    }

    return {
      mimeType: "image/png",
      extension: "png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  private readJpegInfo(buffer: Buffer): ImageInfo | undefined {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      return undefined;
    }

    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) {
        return undefined;
      }
      if (
        marker >= 0xc0 &&
        marker <= 0xc3 &&
        offset + 8 < buffer.length
      ) {
        return {
          mimeType: "image/jpeg",
          extension: "jpg",
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }

      offset += 2 + length;
    }

    return undefined;
  }

  private readGifInfo(buffer: Buffer): ImageInfo | undefined {
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (buffer.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) {
      return undefined;
    }

    return {
      mimeType: "image/gif",
      extension: "gif",
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  private readWebpInfo(buffer: Buffer): ImageInfo | undefined {
    if (
      buffer.length < 30 ||
      buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
      buffer.subarray(8, 12).toString("ascii") !== "WEBP"
    ) {
      return undefined;
    }

    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        mimeType: "image/webp",
        extension: "webp",
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return {
        mimeType: "image/webp",
        extension: "webp",
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return {
        mimeType: "image/webp",
        extension: "webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }

    return undefined;
  }
}
