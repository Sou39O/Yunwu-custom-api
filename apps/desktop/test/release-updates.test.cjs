const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");
const { join } = require("node:path");

// release-updates 在模块顶层 import electron，这里给测试环境一个最小替身。
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "electron") {
    return {
      net: {
        fetch: async () => {
          throw new Error("net.fetch is not available in unit tests.");
        }
      }
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const {
  buildPortableDownloadUrl,
  ensureAllowedDownloadUrl,
  compareVersions
} = require(join(__dirname, "..", "dist", "main", "release-updates.js"));

const allowedAsset = "Yunwu.Desktop-0.7.0-win-x64-portable.zip";

test("端内更新只接受本仓库 Release 的 portable 下载地址", () => {
  const allowed = `https://github.com/Sou39O/Yunwu-custom-api/releases/download/v0.7.0/${allowedAsset}`;
  assert.equal(ensureAllowedDownloadUrl(allowed), allowed);

  const rejected = [
    // 其它域名
    `https://evil.example.com/Sou39O/Yunwu-custom-api/releases/download/v0.7.0/${allowedAsset}`,
    // 明文 http
    `http://github.com/Sou39O/Yunwu-custom-api/releases/download/v0.7.0/${allowedAsset}`,
    // 其它仓库
    `https://github.com/someone-else/Yunwu-custom-api/releases/download/v0.7.0/${allowedAsset}`,
    // 非 portable 资产
    "https://github.com/Sou39O/Yunwu-custom-api/releases/download/v0.7.0/setup.exe",
    // 缺少版本段
    `https://github.com/Sou39O/Yunwu-custom-api/releases/download/latest/${allowedAsset}`
  ];

  for (const url of rejected) {
    assert.throws(() => ensureAllowedDownloadUrl(url), new RegExp("not allowed|not an allowed"), url);
  }
});

test("下载地址由 tag 与资产名拼出，且同样受白名单约束", () => {
  assert.equal(
    buildPortableDownloadUrl("v0.7.0", allowedAsset),
    `https://github.com/Sou39O/Yunwu-custom-api/releases/download/v0.7.0/${allowedAsset}`
  );
  assert.throws(() => buildPortableDownloadUrl("v0.7.0", "payload.exe"));
});

test("版本比较用于判断是否需要更新", () => {
  assert.ok(compareVersions("0.7.1", "0.7.0") > 0);
  assert.ok(compareVersions("0.7.0", "0.7.0") === 0);
  assert.ok(compareVersions("0.6.9", "0.7.0") < 0);
});
