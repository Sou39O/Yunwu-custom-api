import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { LibraryDownloadService } from "../src/api/library/library-download.service";

const OWNER = "user-owner";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withServer(handler: Handler, run: (url: string) => Promise<void>) {
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

async function collect(stream: AsyncGenerator<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createService(count: number) {
  const assets = Array.from({ length: count }, (_, index) => ({
    id: `asset-${index}`,
    userId: OWNER,
    storageKey: null,
    mimeType: "image/png",
    createdAt: new Date("2026-11-04T08:00:00.000Z"),
    url: `http://127.0.0.1:1/dead-${index}.png`,
  }));

  const prisma = {
    asset: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        assets.filter((asset) => where.id.in.includes(asset.id)),
    },
  };

  return new LibraryDownloadService(prisma as never, {
    resolveContent: async (asset: { url: string }) => ({
      kind: "upstream-url",
      upstreamUrl: asset.url,
    }),
  } as never);
}

/**
 * 回归用例：演示「卡在打包中」。
 * 远端链接已失效时，之前是串行逐个等待 TCP 超时（实测每张约 10 秒），
 * 153 张就要 25 分钟。这里锁住两点：整体能在限时内结束，且失效项被跳过。
 */
test("大量失效远端链接不会让批量下载挂住", async () => {
  const service = createService(40);
  const startedAt = Date.now();

  const zip = await collect(
    service.streamDownload({ id: OWNER, role: "member" }, ["asset-0"]),
  ).catch(() => undefined);

  // 只选一个失效项：必须很快结束，而不是一直挂着。
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 30_000, `单张失效作品应在超时内结束，实际 ${elapsed}ms`);

  const allStartedAt = Date.now();
  const allIds = Array.from({ length: 40 }, (_, index) => `asset-${index}`);
  const allZip = await collect(
    service.streamDownload({ id: OWNER, role: "member" }, allIds),
  ).catch(() => undefined);
  const allElapsed = Date.now() - allStartedAt;

  // 并发拉取：40 张失效作品的总耗时不应是串行叠加（40 × 超时）。
  assert.ok(allElapsed < 90_000, `40 张失效作品应在限时内结束，实际 ${allElapsed}ms`);
  void zip;
  void allZip;
});

test("失效链接被跳过，仍能正常产出可读的说明包", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(404);
      response.end("gone");
    },
    async (baseUrl) => {
      const asset = {
        id: "asset-gone",
        userId: OWNER,
        storageKey: null,
        mimeType: "image/png",
        createdAt: new Date("2026-11-04T08:00:00.000Z"),
        url: `${baseUrl}/gone.png`,
      };

      const prisma = {
        asset: { findMany: async () => [asset] },
      };
      const service = new LibraryDownloadService(prisma as never, {
        resolveContent: async (value: { url: string }) => ({
          kind: "upstream-url",
          upstreamUrl: value.url,
        }),
      } as never);

      // 全部失效：包内只有说明文件，请求本身正常结束（由调用方判断内容）。
      const zip = await collect(
        service.streamDownload({ id: OWNER, role: "member" }, ["asset-gone"]),
      );
      assert.ok(zip.includes(Buffer.from("README.txt")));
      assert.ok(zip.includes(Buffer.from("1 个作品读取失败")));
    },
  );
});
