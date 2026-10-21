import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { downloadUpstreamImage } from "../src/api/storage/upstream-image-download";

const PAYLOAD = Buffer.from("image-bytes", "utf8");

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

test("上游偶发 5xx 时会重试并最终拿到字节", async () => {
  let hits = 0;

  await withServer(
    (_request, response) => {
      hits += 1;
      if (hits < 3) {
        response.writeHead(503);
        response.end("busy");
        return;
      }
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(PAYLOAD);
    },
    async (url) => {
      const buffer = await downloadUpstreamImage(`${url}/image.png`, {
        retryDelayMs: 1,
      });
      assert.ok(buffer?.equals(PAYLOAD));
      assert.equal(hits, 3, "应在第三次尝试成功");
    },
  );
});

test("上游返回 4xx 视为链接失效，不重试", async () => {
  let hits = 0;

  await withServer(
    (_request, response) => {
      hits += 1;
      response.writeHead(403);
      response.end("expired");
    },
    async (url) => {
      const buffer = await downloadUpstreamImage(`${url}/expired.png`, {
        retryDelayMs: 1,
      });
      assert.equal(buffer, undefined);
      assert.equal(hits, 1, "4xx 不应重试");
    },
  );
});

test("一直 5xx 时放弃并返回 undefined", async () => {
  let hits = 0;

  await withServer(
    (_request, response) => {
      hits += 1;
      response.writeHead(500);
      response.end("boom");
    },
    async (url) => {
      const buffer = await downloadUpstreamImage(`${url}/broken.png`, {
        attempts: 3,
        retryDelayMs: 1,
      });
      assert.equal(buffer, undefined);
      assert.equal(hits, 3);
    },
  );
});
