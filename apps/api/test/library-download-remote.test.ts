import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LibraryDownloadService } from "../src/api/library/library-download.service";

const OWNER = "user-owner";

/**
 * 回归用例：只保存了上游 URL、没有 storageKey 的历史作品。
 *
 * 这类资产在 0.7.2 之前会让整包只剩一个 README.txt —— 用户侧表现就是
 * 「批量下载 100% 失败」。这里用一个本地 HTTP 服务模拟上游图片地址。
 */
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

async function collect(stream: AsyncGenerator<Buffer>) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function createService(assets: Array<Record<string, unknown>>, resolveContent: (asset: any) => any) {
  const prisma = {
    asset: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        assets.filter((asset) => where.id.in.includes(String(asset.id))),
    },
  };

  return new LibraryDownloadService(
    prisma as never,
    { resolveContent: async (asset: unknown) => resolveContent(asset) } as never,
  );
}

test("只有上游 URL 的历史作品也能下载，不再只剩 README", async () => {
  const payload = Buffer.from("upstream-image-bytes", "utf8");

  await withUpstream(
    (_request, response) => {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(payload);
    },
    async (upstreamUrl) => {
      const asset = {
        id: "asset-remote",
        userId: OWNER,
        storageKey: null,
        mimeType: "image/png",
        createdAt: new Date("2026-10-21T08:00:00.000Z"),
        url: `${upstreamUrl}/xai-tmp-imgen-abc.jpeg`,
      };

      const service = createService([asset], (value: any) =>
        value.storageKey
          ? undefined
          : value.url
            ? { kind: "upstream-url", upstreamUrl: value.url }
            : undefined,
      );

      const zip = await collect(
        service.streamDownload({ id: OWNER, role: "member" }, ["asset-remote"]),
      );

      assert.ok(zip.subarray(0, 4).equals(Buffer.from("504b0304", "hex")));
      // 文件名 + 内容都在包里，且没有 README 兜底文件。
      assert.ok(zip.includes(Buffer.from("2026-10-21_")), "应包含按日期命名的条目");
      assert.ok(zip.includes(payload), "应包含上游取回的真实字节");
      assert.ok(!zip.includes(Buffer.from("README.txt")), "不应再出现跳过说明");
    },
  );
});

test("上游已失效时才跳过，并附说明文件", async () => {
  await withUpstream(
    (_request, response) => {
      response.writeHead(410, { "Content-Type": "text/plain" });
      response.end("gone");
    },
    async (upstreamUrl) => {
      const asset = {
        id: "asset-expired",
        userId: OWNER,
        storageKey: null,
        mimeType: "image/png",
        createdAt: new Date("2026-10-21T08:00:00.000Z"),
        url: `${upstreamUrl}/expired.jpeg`,
      };

      const service = createService([asset], (value: any) => ({
        kind: "upstream-url",
        upstreamUrl: value.url,
      }));

      const zip = await collect(
        service.streamDownload({ id: OWNER, role: "member" }, ["asset-expired"]),
      );

      assert.ok(zip.includes(Buffer.from("README.txt")));
    },
  );
});

test("本地文件与上游 URL 混选时两者都进包", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yunwu-mixed-"));
  const localKey = "1760000000000-local.png";
  await writeFile(join(dir, localKey), Buffer.from("local-bytes", "utf8"));
  const upstreamPayload = Buffer.from("upstream-bytes", "utf8");

  try {
    await withUpstream(
      (_request, response) => {
        response.writeHead(200, { "Content-Type": "image/png" });
        response.end(upstreamPayload);
      },
      async (upstreamUrl) => {
        const assets = [
          {
            id: "asset-local",
            userId: OWNER,
            storageKey: localKey,
            mimeType: "image/png",
            createdAt: new Date("2026-10-20T08:00:00.000Z"),
            url: `/api/assets/${localKey}/content`,
          },
          {
            id: "asset-remote",
            userId: OWNER,
            storageKey: null,
            mimeType: "image/png",
            createdAt: new Date("2026-10-21T08:00:00.000Z"),
            url: `${upstreamUrl}/remote.png`,
          },
        ];

        const service = createService(assets, (value: any) =>
          value.storageKey
            ? { kind: "local", filePath: join(dir, value.storageKey), mimeType: "image/png" }
            : { kind: "upstream-url", upstreamUrl: value.url },
        );

        const zip = await collect(
          service.streamDownload({ id: OWNER, role: "member" }, [
            "asset-local",
            "asset-remote",
          ]),
        );

        assert.ok(zip.includes(Buffer.from("local-bytes")));
        assert.ok(zip.includes(upstreamPayload));
        assert.ok(!zip.includes(Buffer.from("README.txt")));
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
