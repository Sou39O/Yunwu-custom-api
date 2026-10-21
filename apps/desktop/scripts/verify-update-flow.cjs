/**
 * 端内更新链路验证：对着真实发布的 v0.7.0 资产跑一遍
 * 下载 → sha256 校验 → 解压 → 定位程序目录 → 生成替换脚本。
 *
 * 只验证到"生成替换脚本"为止，不真的替换目录、不重启。
 * 用法：node scripts/verify-update-flow.cjs [工作目录]
 */
const assert = require("node:assert/strict");
const Module = require("node:module");
const { existsSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

// desktop-installer 依赖 electron 的 net.fetch，这里用 Node 的全局 fetch 顶上。
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === "electron") {
    return { net: { fetch: (...args) => fetch(...args) } };
  }
  return originalLoad.call(this, request, ...rest);
};

const { stageDesktopUpdate } = require(join(__dirname, "..", "dist", "main", "desktop-installer.js"));

const manifestUrl =
  "https://github.com/Sou39O/Yunwu-custom-api/releases/latest/download/yunwu-release.json";
const workDir = process.argv[2] ?? join(tmpdir(), "yunwu-update-verify");

(async () => {
  const manifest = await (await fetch(manifestUrl)).json();
  const asset = manifest.desktop.portableAsset;
  console.log(`发布清单：${manifest.tag}，资产 ${asset.name}（${(asset.size / 1024 / 1024).toFixed(1)} MB）`);

  const downloadUrl = `https://github.com/Sou39O/Yunwu-custom-api/releases/download/${manifest.tag}/${asset.name}`;
  rmSync(workDir, { recursive: true, force: true });
  // 模拟真实安装目录（可写），验证可写性检查与替换脚本生成。
  const fakeInstallDir = join(workDir, "install");
  mkdirSync(fakeInstallDir, { recursive: true });

  let lastStage = "";
  const staged = await stageDesktopUpdate({
    asset: { name: asset.name, downloadUrl, sha256: asset.sha256, size: asset.size },
    version: manifest.version,
    // 假装程序装在工作目录下，验证目录可写与替换脚本生成，不动真实安装目录。
    exePath: join(fakeInstallDir, "Yunwu Desktop.exe"),
    workDir,
    onProgress: (progress) => {
      if (progress.stage !== lastStage) {
        lastStage = progress.stage;
        console.log(`  阶段：${progress.stage} - ${progress.message}`);
      }
    }
  });

  console.log(`解压出的程序目录：${staged.sourceDir}`);
  assert.ok(existsSync(join(staged.sourceDir, "Yunwu Desktop.exe")), "解压结果里应有主程序");
  assert.ok(
    existsSync(join(staged.sourceDir, "resources", "server", "api", "dist", "main.js")),
    "解压结果里应有内置服务入口"
  );
  assert.ok(
    existsSync(join(staged.sourceDir, "resources", "server", "api", "node_modules", "tslib", "package.json")),
    "解压结果里依赖应为实体文件"
  );

  const script = readFileSync(staged.scriptPath, "utf8");
  assert.match(script, /robocopy/, "替换脚本应使用 robocopy");
  assert.match(script, /Start-Process/, "替换脚本应重新拉起程序");
  assert.ok(script.includes(staged.installDir), "替换脚本应指向安装目录");

  console.log("\n端内更新链路验证通过：下载 → sha256 校验 → 解压 → 替换脚本已就绪");
  console.log(`（未执行替换；产物位于 ${workDir}）`);
})().catch((error) => {
  console.error(`验证失败：${error.message}`);
  process.exit(1);
});
