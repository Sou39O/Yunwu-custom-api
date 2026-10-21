import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssetPersistenceService } from "../src/api/storage/asset-persistence.service";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withUpstream(handler: Handler, run: (url: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const PAYLOAD = Buffer.from("persisted-image-bytes", "utf8");

test("只存上游 URL 的作品会被补下载到本地存储", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yunwu-backfill-"));

  try {
    await withUpstream(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(PAYLOAD);
      },
      async (upstreamUrl) => {
        const asset = {
          id: "asset-remote",
          url: `${upstreamUrl}/xai-tmp-imgen.png`,
          mimeType: "image/png",
          metadata: { storage: "remote-url" },
        };

        const updates: Array<Record<string, any>> = [];
        const prisma = {
          asset: {
            findMany: async () => [asset],
            update: async (input: Record<string, any>) => {
              updates.push(input);
              return asset;
            },
          },
        };

        const assetStorage = {
          store: async (input: { buffer: Buffer; storageKey: string }) => {
            await (await import("node:fs/promises")).writeFile(
              join(dir, input.storageKey),
              input.buffer,
            );
            return { kind: "local" as const };
          },
          getPublicUrl: (storageKey: string) => `/api/assets/${storageKey}/content`,
        };

        const service = new AssetPersistenceService(
          prisma as never,
          assetStorage as never,
          { get: () => "true" } as never,
        );

        const result = await service.runOnce();
        assert.deepEqual(result, { persisted: 1, failed: 0 });
        assert.equal(updates.length, 1);

        const data = updates[0].data as Record<string, any>;
        assert.ok(data.storageKey, "应写入 storageKey");
        assert.match(String(data.url), /^\/api\/assets\/.+\/content$/);
        assert.equal(data.metadata.storage, "local");
        assert.ok(data.metadata.backfilledAt);

        const files = await readdir(dir);
        assert.equal(files.length, 1);
        assert.ok((await readFile(join(dir, files[0]))).equals(PAYLOAD));
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("上游链接已失效时不写库，计数为失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yunwu-backfill-"));

  try {
    await withUpstream(
      (_request, response) => {
        response.writeHead(403, { "Content-Type": "text/plain" });
        response.end("expired");
      },
      async (upstreamUrl) => {
        const updates: unknown[] = [];
        const prisma = {
          asset: {
            findMany: async () => [
              { id: "a1", url: `${upstreamUrl}/gone.png`, mimeType: "image/png", metadata: {} },
            ],
            update: async (input: unknown) => {
              updates.push(input);
            },
          },
        };

        const service = new AssetPersistenceService(
          prisma as never,
          { store: async () => ({ kind: "local" }), getPublicUrl: () => "/x" } as never,
          { get: () => "true" } as never,
        );

        const result = await service.runOnce();
        assert.deepEqual(result, { persisted: 0, failed: 1 });
        assert.equal(updates.length, 0, "下载失败时不应改库");
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
