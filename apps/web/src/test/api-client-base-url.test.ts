import { describe, expect, it } from "vitest";
import { resolveDefaultApiBaseUrl } from "@/lib/api-client";

const loopbackPage = (port: number) => ({
  origin: `http://127.0.0.1:${port}`,
  protocol: "http:",
  hostname: "127.0.0.1",
});

describe("resolveDefaultApiBaseUrl", () => {
  it("uses the page origin in a production build so a non-default server port still works", () => {
    expect(resolveDefaultApiBaseUrl(loopbackPage(64383), false)).toBe("http://127.0.0.1:64383");
  });

  it("keeps the 3000 fallback for the vite dev server", () => {
    expect(resolveDefaultApiBaseUrl(loopbackPage(5173), true)).toBe("http://127.0.0.1:3000");
  });

  it("falls back to loopback when there is no window", () => {
    expect(resolveDefaultApiBaseUrl(undefined, false)).toBe("http://127.0.0.1:3000");
  });
});
