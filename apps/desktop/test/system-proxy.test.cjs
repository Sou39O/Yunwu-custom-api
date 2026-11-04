const assert = require("node:assert/strict");
const test = require("node:test");
const { join } = require("node:path");

const { detectSystemProxyEnv } = require(
  join(__dirname, "..", "dist", "main", "system-proxy.js"),
);

// 这些用例覆盖「该不该把系统代理注入服务进程」的判断。
// 真正读注册表的分支依赖本机设置，这里只验证不会被误触发。

test("用户已显式配置代理时不再覆盖", async () => {
  const env = await detectSystemProxyEnv({ HTTPS_PROXY: "http://127.0.0.1:9999" });
  assert.deepEqual(env, {});
});

test("小写 http_proxy 同样视为已配置", async () => {
  const env = await detectSystemProxyEnv({ http_proxy: "http://127.0.0.1:9999" });
  assert.deepEqual(env, {});
});

test("ALL_PROXY 同样视为已配置", async () => {
  const env = await detectSystemProxyEnv({ ALL_PROXY: "socks5://127.0.0.1:1080" });
  assert.deepEqual(env, {});
});

test("非 Windows 平台不做系统代理探测", async () => {
  if (process.platform === "win32") {
    // 在 Windows 上跳过平台分支断言，避免依赖注册表实际内容。
    return;
  }
  const env = await detectSystemProxyEnv({});
  assert.deepEqual(env, {});
});

test("探测结果只会是代理相关的键", async () => {
  const env = await detectSystemProxyEnv({});
  for (const key of Object.keys(env)) {
    assert.ok(
      ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"].includes(key),
      `意外的键：${key}`,
    );
  }
});
