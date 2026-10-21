import { app, BrowserWindow, ipcMain, shell } from "electron";
import log from "electron-log/main";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  checkForUpdates,
  createCheckingUpdateStatus,
  createInitialUpdateStatus,
  defaultReleaseState,
  loadReleaseState,
  saveReleaseState,
  type ReleaseState,
  type UpdateStatus
} from "./release-updates";
import {
  cleanupStagingDirs,
  getInstallDir,
  isInstallDirWritable,
  launchSwapScript,
  stageDesktopUpdate
} from "./desktop-installer";

type Phase = "idle" | "checking" | "migrating" | "starting" | "waiting" | "ready" | "error";

type ServiceStatus = {
  name: string;
  status: "pending" | "running" | "healthy" | "error";
  detail?: string;
};

type LegacyMigrationStatus = {
  detected: boolean;
  state: "none" | "running" | "done" | "failed" | "skipped";
  message?: string;
};

type DesktopStatus = {
  phase: Phase;
  message: string;
  logs: string[];
  services: ServiceStatus[];
  desktopVersion: string;
  webUrl: string;
  adminUrl: string;
  instanceId: string;
  port: number;
  userDataPath: string;
  dataPath: string;
  logPath: string;
  legacy: LegacyMigrationStatus;
};

type RuntimeIdentity = {
  instanceId: string;
  composeProjectName: string;
  sessionSecret: string;
};

function getPortEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

const preferredPort = getPortEnv("YUNWU_DESKTOP_PORT", getPortEnv("YUNWU_DESKTOP_API_PORT", 3000));

let runtimePort = preferredPort;
let mainWindow: BrowserWindow | undefined;
let serverProcess: ChildProcess | undefined;
let migrationProcess: ChildProcess | undefined;
let runtimeIdentity: RuntimeIdentity | undefined;
let isStarting = false;
let isMigrating = false;
let isApplyingUpdate = false;
let releaseState: ReleaseState = defaultReleaseState(app.getVersion());
let updateStatus: UpdateStatus = createInitialUpdateStatus(releaseState);

const status: DesktopStatus = {
  phase: "idle",
  message: "准备启动本地服务。",
  logs: [],
  services: [
    { name: "内置服务进程", status: "pending" },
    { name: "API /health", status: "pending" },
    { name: "API /readiness", status: "pending" }
  ],
  desktopVersion: app.getVersion(),
  webUrl: `http://127.0.0.1:${preferredPort}`,
  adminUrl: `http://127.0.0.1:${preferredPort}/admin`,
  instanceId: "",
  port: preferredPort,
  userDataPath: "",
  dataPath: "",
  logPath: "",
  legacy: { detected: false, state: "none" }
};

function setService(name: string, update: Partial<ServiceStatus>) {
  const service = status.services.find((item) => item.name === name);
  if (service) {
    Object.assign(service, update);
  }
}

function pushLog(message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  status.logs = [...status.logs, line].slice(-300);
  log.info(message);
  broadcastStatus();
}

function setPhase(phase: Phase, message: string) {
  status.phase = phase;
  status.message = message;
  broadcastStatus();
}

function broadcastStatus() {
  mainWindow?.webContents.send("desktop:status", status);
}

function broadcastUpdateStatus() {
  mainWindow?.webContents.send("desktop:update-status", updateStatus);
}

function updateRuntimeUrls() {
  status.port = runtimePort;
  status.webUrl = `http://127.0.0.1:${runtimePort}`;
  status.adminUrl = `${status.webUrl}/admin`;
  broadcastStatus();
}

function getRuntimeDir() {
  return join(app.getPath("userData"), "runtime");
}

function getDataDir() {
  return join(app.getPath("userData"), "data");
}

function getUpdateWorkDir() {
  return join(app.getPath("userData"), "updates");
}

function getDatabasePath() {
  return join(getDataDir(), "yunwu.db");
}

function getStorageDir() {
  return join(getDataDir(), "storage");
}

function getMigrationStatePath() {
  return join(getDataDir(), "legacy-migration.json");
}

function toFileUrl(path: string) {
  return `file:${path.replaceAll("\\", "/")}`;
}

function getResourcePath(...parts: string[]) {
  const packaged = join(process.resourcesPath, ...parts);
  if (app.isPackaged && existsSync(packaged)) {
    return packaged;
  }

  const repoRoot = resolve(app.getAppPath(), "..", "..");
  const [first, ...rest] = parts;
  if (first === "server") {
    const [target, ...serverRest] = rest;
    if (target === "api") {
      return join(repoRoot, "apps", "api", ...serverRest);
    }
    if (target === "web") {
      return join(repoRoot, "apps", "web", "dist", ...serverRest);
    }
  }
  return join(repoRoot, first, ...rest);
}

function stableHash(value: string) {
  return createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 12);
}

function sanitizeInstanceId(value: string) {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return sanitized || "desktop";
}

async function loadRuntimeIdentity(runtimeDir: string, userData: string): Promise<RuntimeIdentity> {
  const identityPath = join(runtimeDir, "identity.json");
  let storedIdentity: Partial<RuntimeIdentity> = {};
  try {
    storedIdentity = JSON.parse(await readFile(identityPath, "utf8")) as Partial<RuntimeIdentity>;
  } catch {
  }

  const envInstanceId = process.env.YUNWU_INSTANCE_ID;
  const instanceId = sanitizeInstanceId(
    envInstanceId && envInstanceId.trim()
      ? envInstanceId
      : storedIdentity.instanceId || `desktop${stableHash(userData)}`
  );
  const identity = {
    instanceId,
    composeProjectName: storedIdentity.composeProjectName || `yunwu-${instanceId}`,
    sessionSecret: storedIdentity.sessionSecret || randomBytes(32).toString("hex")
  };
  await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  return identity;
}

function checkPort(port: number) {
  return new Promise<boolean>((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.on("error", () => resolvePromise(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

function getEphemeralPort() {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolvePromise(address.port);
        } else {
          reject(new Error("Failed to allocate an ephemeral port."));
        }
      });
    });
  });
}

async function selectRuntimePort() {
  if (await checkPort(preferredPort)) {
    runtimePort = preferredPort;
  } else {
    runtimePort = await getEphemeralPort();
    pushLog(`Preferred port ${preferredPort} is unavailable; selected ${runtimePort}.`);
  }
  updateRuntimeUrls();
}

function runCommand(command: string, args: string[], options: { timeoutMs?: number } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`${command} ${args.join(" ")} timed out.`));
        }, options.timeoutMs)
      : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}.\n${stderr || stdout}`));
      }
    });
  });
}

function delay(ms: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// ---------------------------------------------------------------------------
// 内置服务进程
// ---------------------------------------------------------------------------

function getServerEntry() {
  return getResourcePath("server", "api", "dist", "main.js");
}

function getWebDistDir() {
  return getResourcePath("server", "web");
}

function buildServerEnv(identity: RuntimeIdentity): Record<string, string> {
  const origin = `http://127.0.0.1:${runtimePort},http://localhost:${runtimePort}`;
  return {
    NODE_ENV: "production",
    PORT: String(runtimePort),
    // 桌面端服务只对本机提供，避免监听全部网卡。
    HOST: "127.0.0.1",
    DATABASE_URL: toFileUrl(getDatabasePath()),
    RUN_MIGRATIONS_ON_BOOT: "true",
    STORAGE_MODE: "local",
    LOCAL_STORAGE_PATH: getStorageDir(),
    WEB_DIST_DIR: getWebDistDir(),
    TASK_WORKER_ENABLED: "true",
    TASK_WORKER_CONCURRENCY: process.env.YUNWU_TASK_CONCURRENCY ?? "50",
    TASK_BATCH_WORKER_CONCURRENCY: process.env.YUNWU_BATCH_CONCURRENCY ?? "2",
    PROVIDER_TYPE: process.env.PROVIDER_TYPE ?? "apixo",
    APIXO_BASE_URL: process.env.APIXO_BASE_URL ?? "https://api.apixo.ai/api/v1",
    APIXO_API_KEY: process.env.APIXO_API_KEY ?? "",
    YUNWU_BASE_URL: process.env.YUNWU_BASE_URL ?? "https://yunwu.ai",
    YUNWU_API_KEY: process.env.YUNWU_API_KEY ?? "",
    AUTH_ADMIN_EMAIL: "admin@yunwu.local",
    AUTH_ADMIN_PASSWORD: "admin123456",
    AUTH_ADMIN_DISPLAY_NAME: "Administrator",
    AUTH_DEMO_EMAIL: "demo@yunwu.local",
    AUTH_DEMO_PASSWORD: "demo123456",
    AUTH_DEMO_DISPLAY_NAME: "Demo User",
    AUTH_SESSION_SECRET: identity.sessionSecret,
    AUTH_COOKIE_NAME: `yunwu_session_${identity.instanceId}`,
    AUTH_SESSION_TTL_HOURS: "168",
    AUTH_COOKIE_SECURE: "false",
    CORS_ORIGIN: origin,
    WEB_ORIGIN: `http://127.0.0.1:${runtimePort}`
  };
}

function stopServer() {
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {
    }
    serverProcess = undefined;
  }
}

async function startServer(identity: RuntimeIdentity) {
  const entry = getServerEntry();
  if (!existsSync(entry)) {
    throw new Error(`未找到内置服务入口：${entry}。开发模式请先执行 pnpm --filter @yunwu/api build。`);
  }

  setService("内置服务进程", { status: "running", detail: "正在启动内置 Node 服务。" });
  // 用 ELECTRON_RUN_AS_NODE 起纯 Node 子进程，而不是 utilityProcess：
  // utilityProcess 会初始化 Chromium 网络栈，在 Winsock LSP 被第三方软件
  // （VPN/杀软）改坏的机器上创建监听套接字会直接失败（listen UNKNOWN），
  // 同一台机器上纯 Node 模式绑定正常。
  const child = fork(entry, [], {
    env: { ...buildServerEnv(identity), ELECTRON_RUN_AS_NODE: "1" },
    execPath: process.execPath,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  serverProcess = child;

  child.stdout?.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) pushLog(`[server] ${line}`);
  });
  child.stderr?.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) pushLog(`[server] ${line}`);
  });
  child.on("exit", (code) => {
    if (serverProcess === child) {
      serverProcess = undefined;
      if (status.phase !== "error" && !isStarting) {
        setService("内置服务进程", { status: "error", detail: `服务进程退出（code=${code}）。` });
        setPhase("error", "内置服务进程意外退出，请点击重试。");
      }
    }
  });

  setService("内置服务进程", { status: "healthy", detail: "服务进程已启动" });
}

async function probe(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(maxWaitMs = 60_000) {
  setPhase("waiting", "服务启动中，正在等待健康检查。");
  const checks = [
    { name: "API /health", url: `http://127.0.0.1:${runtimePort}/health` },
    { name: "API /readiness", url: `http://127.0.0.1:${runtimePort}/readiness` }
  ];
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    let allHealthy = true;
    for (const check of checks) {
      try {
        const ok = await probe(check.url);
        setService(check.name, {
          status: ok ? "healthy" : "running",
          detail: ok ? `${check.url} OK` : `等待 ${check.url}`
        });
        allHealthy &&= ok;
      } catch (error) {
        allHealthy = false;
        setService(check.name, {
          status: "running",
          detail: error instanceof Error ? error.message : `等待 ${check.url}`
        });
      }
    }
    broadcastStatus();
    if (allHealthy) {
      pushLog("All health checks passed.");
      return;
    }
    await delay(500);
  }

  for (const check of checks) {
    const service = status.services.find((item) => item.name === check.name);
    if (service?.status !== "healthy") {
      setService(check.name, { status: "error", detail: "健康检查超时，请查看日志后重试。" });
    }
  }
  throw new Error(`Health check timed out after ${Math.round(maxWaitMs / 1000)} seconds.`);
}

// ---------------------------------------------------------------------------
// v0.6.1 旧数据迁移（Docker 卷 → SQLite/本地存储）
// ---------------------------------------------------------------------------

type MigrationState = {
  status: "done" | "failed" | "skipped";
  at: string;
  message?: string;
};

async function readMigrationState(): Promise<MigrationState | undefined> {
  try {
    return JSON.parse(await readFile(getMigrationStatePath(), "utf8")) as MigrationState;
  } catch {
    return undefined;
  }
}

async function writeMigrationState(state: MigrationState) {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(getMigrationStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function dockerVolumeExists(name: string) {
  try {
    await runCommand("docker", ["volume", "inspect", name], { timeoutMs: 8000 });
    return true;
  } catch {
    return false;
  }
}

async function detectLegacyData(identity: RuntimeIdentity) {
  try {
    await runCommand("docker", ["info"], { timeoutMs: 6000 });
  } catch {
    return { available: false as const, reason: "Docker daemon 不可用" };
  }

  const volumeName = `${identity.composeProjectName}_postgres_data`;
  if (!(await dockerVolumeExists(volumeName))) {
    return { available: false as const, reason: "未发现旧版本数据卷" };
  }

  return {
    available: true as const,
    postgresVolume: volumeName,
    minioVolume: `${identity.composeProjectName}_minio_data`
  };
}

async function removeContainer(name: string) {
  try {
    await runCommand("docker", ["rm", "-f", name], { timeoutMs: 20_000 });
  } catch {
  }
}

async function runLegacyImport(env: Record<string, string>) {
  const entry = getResourcePath("server", "api", "dist", "tools", "legacy-import.js");
  if (!existsSync(entry)) {
    throw new Error(`未找到迁移工具：${entry}`);
  }

  await new Promise<void>((resolvePromise, reject) => {
    // 与内置服务同理：迁移工具要连旧 Postgres/MinIO，同样走纯 Node 子进程。
    const child = fork(entry, [], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      execPath: process.execPath,
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    migrationProcess = child;
    let lastError = "";

    const handleChunk = (chunk: Buffer) => {
      for (const rawLine of chunk.toString().split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { level?: string; message?: string };
          if (parsed.message) {
            if (parsed.level === "error") lastError = parsed.message;
            pushLog(`[migrate] ${parsed.message}`);
            continue;
          }
        } catch {
        }
        pushLog(`[migrate] ${line}`);
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    child.on("exit", (code) => {
      migrationProcess = undefined;
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(lastError || `迁移进程退出（code=${code}）。`));
      }
    });
  });
}

async function migrateLegacyData(identity: RuntimeIdentity, options: { forceWipe: boolean }) {
  const detection = await detectLegacyData(identity);
  if (!detection.available) {
    throw new Error(`无法访问旧数据：${detection.reason}。请确认 Docker Desktop 已启动。`);
  }

  const suffix = Date.now().toString(36);
  const pgContainer = `yunwu-legacy-pg-${suffix}`;
  const minioContainer = `yunwu-legacy-minio-${suffix}`;
  const pgPort = await getEphemeralPort();
  const hasMinio = await dockerVolumeExists(detection.minioVolume);
  const minioPort = hasMinio ? await getEphemeralPort() : 0;

  setService("旧数据迁移", { status: "running", detail: "正在启动临时数据库容器读取旧数据。" });
  pushLog(`Starting temporary postgres container on port ${pgPort}.`);

  try {
    await runCommand(
      "docker",
      [
        "run", "-d", "--name", pgContainer,
        "-p", `127.0.0.1:${pgPort}:5432`,
        "-v", `${detection.postgresVolume}:/var/lib/postgresql/data`,
        "postgres:16-alpine"
      ],
      { timeoutMs: 120_000 }
    );

    let pgReady = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await runCommand(
          "docker",
          ["exec", pgContainer, "pg_isready", "-U", "postgres", "-d", "yunwu_platform"],
          { timeoutMs: 5000 }
        );
        pgReady = true;
        break;
      } catch {
        await delay(1000);
      }
    }
    if (!pgReady) {
      throw new Error("旧数据库容器未在 60 秒内就绪。");
    }

    if (hasMinio) {
      pushLog(`Starting temporary minio container on port ${minioPort}.`);
      await runCommand(
        "docker",
        [
          "run", "-d", "--name", minioContainer,
          "-p", `127.0.0.1:${minioPort}:9000`,
          "-v", `${detection.minioVolume}:/data`,
          "-e", "MINIO_ROOT_USER=minioadmin",
          "-e", "MINIO_ROOT_PASSWORD=minioadmin",
          "minio/minio:RELEASE.2025-09-07T16-13-09Z-cpuv1",
          "server", "/data"
        ],
        { timeoutMs: 120_000 }
      );
      let minioReady = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          if (await probe(`http://127.0.0.1:${minioPort}/minio/health/live`)) {
            minioReady = true;
            break;
          }
        } catch {
        }
        await delay(1000);
      }
      if (!minioReady) {
        pushLog("MinIO container did not become ready; object import will be skipped.");
      }
    }

    const env: Record<string, string> = {
      LEGACY_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${pgPort}/yunwu_platform`,
      DATABASE_URL: toFileUrl(getDatabasePath()),
      LOCAL_STORAGE_PATH: getStorageDir(),
      FORCE_WIPE: options.forceWipe ? "true" : "false"
    };
    if (hasMinio) {
      env.LEGACY_MINIO_ENDPOINT = "127.0.0.1";
      env.LEGACY_MINIO_PORT = String(minioPort);
      env.LEGACY_MINIO_ACCESS_KEY = "minioadmin";
      env.LEGACY_MINIO_SECRET_KEY = "minioadmin";
      env.LEGACY_MINIO_BUCKET = "yunwu-assets";
    }

    await runLegacyImport(env);
    setService("旧数据迁移", { status: "healthy", detail: "旧数据迁移完成。" });
  } finally {
    await removeContainer(pgContainer);
    if (hasMinio) {
      await removeContainer(minioContainer);
    }
  }
}

async function maybeAutoMigrate(identity: RuntimeIdentity) {
  const state = await readMigrationState();
  if (state) {
    status.legacy = {
      detected: state.status !== "done" && state.status !== "skipped",
      state: state.status === "done" ? "done" : state.status === "failed" ? "failed" : "skipped",
      message: state.message
    };
    return;
  }

  const databaseExists = existsSync(getDatabasePath());
  const detection = await detectLegacyData(identity);
  if (!detection.available) {
    // Docker 不可用或没有旧数据：不写状态文件，之后启动仍会轻量探测一次
    status.legacy = { detected: false, state: "none", message: detection.reason };
    pushLog(`Legacy data auto-migration skipped: ${detection.reason}.`);
    return;
  }

  status.legacy = { detected: true, state: "none" };
  if (databaseExists) {
    status.legacy.message = "检测到旧版本数据。当前数据库已有内容，可在下方手动触发迁移（将覆盖现有数据）。";
    pushLog("Legacy volumes detected but local database already exists; manual migration available.");
    broadcastStatus();
    return;
  }

  setPhase("migrating", "检测到 v0.6.x 旧数据，正在自动迁移到轻量存储。");
  status.services.push({ name: "旧数据迁移", status: "running" });
  isMigrating = true;
  try {
    await migrateLegacyData(identity, { forceWipe: false });
    await writeMigrationState({ status: "done", at: new Date().toISOString() });
    status.legacy = { detected: true, state: "done", message: "旧数据迁移完成。" };
    pushLog("Legacy data migration completed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeMigrationState({ status: "failed", at: new Date().toISOString(), message });
    status.legacy = { detected: true, state: "failed", message };
    setService("旧数据迁移", { status: "error", detail: message });
    pushLog(`Legacy data migration failed: ${message}`);
  } finally {
    isMigrating = false;
  }
}

async function manualMigrateLegacy() {
  if (isMigrating || isStarting) {
    throw new Error("当前有任务进行中，请稍后再试。");
  }

  const identity = runtimeIdentity;
  if (!identity) {
    throw new Error("运行时尚未初始化。");
  }

  isMigrating = true;
  const hadService = status.services.some((item) => item.name === "旧数据迁移");
  if (!hadService) {
    status.services.push({ name: "旧数据迁移", status: "running" });
  } else {
    setService("旧数据迁移", { status: "running", detail: undefined });
  }
  setPhase("migrating", "正在从旧版本导入数据（将覆盖当前数据库）。");

  try {
    stopServer();
    await delay(1000);
    await migrateLegacyData(identity, { forceWipe: true });
    await writeMigrationState({ status: "done", at: new Date().toISOString() });
    status.legacy = { detected: true, state: "done", message: "旧数据迁移完成。" };
    pushLog("Manual legacy migration completed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.legacy = { detected: true, state: "failed", message };
    setService("旧数据迁移", { status: "error", detail: message });
    pushLog(`Manual legacy migration failed: ${message}`);
  } finally {
    isMigrating = false;
  }

  void startStack();
}

// ---------------------------------------------------------------------------
// 启动编排
// ---------------------------------------------------------------------------

async function clearWorkbenchCache() {
  const workbenchSession = mainWindow?.webContents.session;
  if (!workbenchSession) {
    return;
  }

  try {
    await workbenchSession.clearCache();
    pushLog("Desktop browser HTTP cache cleared before opening workbench.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`Desktop browser cache clear failed: ${message}`);
  }
}

async function ensureRuntimeReleaseState() {
  const shouldResetUpdateStatus = updateStatus.phase === "unknown";
  releaseState = await loadReleaseState(getRuntimeDir(), app.getVersion());
  updateStatus = shouldResetUpdateStatus
    ? createInitialUpdateStatus(releaseState)
    : {
        ...updateStatus,
        currentDesktopVersion: releaseState.desktopVersion,
        currentImageTag: releaseState.currentImageTag
      };
  status.desktopVersion = releaseState.desktopVersion;
  broadcastStatus();
  broadcastUpdateStatus();
  return releaseState;
}

async function checkDesktopUpdates() {
  updateStatus = createCheckingUpdateStatus(releaseState);
  broadcastUpdateStatus();
  const result = await checkForUpdates(getRuntimeDir(), releaseState);
  releaseState = result.state;
  updateStatus = await withInstallability(result.status);
  broadcastStatus();
  broadcastUpdateStatus();
  return updateStatus;
}

/**
 * 端内更新还要求安装目录可写：portable 包被解压到 Program Files
 * 之类的位置时只能提示手动下载。
 */
async function withInstallability(status: UpdateStatus): Promise<UpdateStatus> {
  if (!status.canApplyDesktopUpdate || !status.portableAsset) {
    return status;
  }

  const installDir = getInstallDir(app.getPath("exe"));
  if (await isInstallDirWritable(installDir)) {
    return status;
  }

  return {
    ...status,
    canApplyDesktopUpdate: false,
    message: `${status.message}（当前安装目录不可写，请手动下载新版本）`
  };
}

async function applyDesktopUpdate() {
  const asset = updateStatus.portableAsset ?? releaseState.lastPortableAsset ?? undefined;
  const version = updateStatus.latestVersion ?? releaseState.lastKnownLatest?.version;

  if (!asset || !version) {
    updateStatus = {
      ...updateStatus,
      phase: "error",
      error: "没有可用的更新包信息。",
      message: "没有可用的更新包信息，请先检查更新。"
    };
    broadcastUpdateStatus();
    return updateStatus;
  }

  if (isApplyingUpdate) {
    return updateStatus;
  }
  isApplyingUpdate = true;

  updateStatus = {
    ...updateStatus,
    phase: "applying",
    stage: "download",
    message: "正在准备更新。"
  };
  broadcastUpdateStatus();

  try {
    await cleanupStagingDirs(getUpdateWorkDir());
    const staged = await stageDesktopUpdate({
      asset,
      version,
      exePath: app.getPath("exe"),
      workDir: getUpdateWorkDir(),
      onProgress: (progress) => {
        updateStatus = {
          ...updateStatus,
          phase: "applying",
          stage: progress.stage,
          ...(progress.downloadedBytes === undefined
            ? {}
            : { downloadedBytes: progress.downloadedBytes }),
          ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
          message: progress.message
        };
        broadcastUpdateStatus();
      }
    });

    pushLog(`Update ${version} staged at ${staged.sourceDir}.`);
    releaseState = { ...releaseState, lastAppliedAt: new Date().toISOString(), lastError: null };
    await saveReleaseState(getRuntimeDir(), releaseState);

    updateStatus = {
      ...updateStatus,
      phase: "applied",
      stage: "restart",
      message: `更新包已就绪，即将关闭并替换为 ${version}。`
    };
    broadcastUpdateStatus();

    // 给界面一点时间显示最终状态，再退出让替换脚本接手。
    setTimeout(() => {
      stopServer();
      launchSwapScript(staged);
      app.quit();
    }, 1200);

    return updateStatus;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`Update apply failed: ${message}`);
    releaseState = { ...releaseState, lastError: message };
    await saveReleaseState(getRuntimeDir(), releaseState).catch(() => undefined);
    updateStatus = {
      ...updateStatus,
      phase: "error",
      error: message,
      message: `更新失败：${message}`
    };
    broadcastUpdateStatus();
    return updateStatus;
  } finally {
    isApplyingUpdate = false;
  }
}

async function startStack() {
  if (isStarting || isMigrating) return;
  isStarting = true;
  status.logs = [];
  status.services = [
    { name: "内置服务进程", status: "pending" },
    { name: "API /health", status: "pending" },
    { name: "API /readiness", status: "pending" }
  ];

  try {
    setPhase("checking", "正在准备运行目录与端口。");
    const userData = app.getPath("userData");
    const runtimeDir = getRuntimeDir();
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(getDataDir(), { recursive: true });
    await mkdir(getStorageDir(), { recursive: true });
    await ensureRuntimeReleaseState();
    runtimeIdentity = await loadRuntimeIdentity(runtimeDir, userData);
    status.userDataPath = userData;
    status.dataPath = getDataDir();
    status.instanceId = runtimeIdentity.instanceId;
    status.logPath = log.transports.file.getFile().path;

    stopServer();
    await selectRuntimePort();
    await maybeAutoMigrate(runtimeIdentity);

    setPhase("starting", "正在启动内置服务。");
    await startServer(runtimeIdentity);
    await waitForHealth();
    setPhase("ready", "服务已就绪，正在打开工作台。");
    await clearWorkbenchCache();
    await mainWindow?.loadURL(status.webUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(message);
    setPhase("error", message);
  } finally {
    isStarting = false;
  }
}

async function createWindow() {
  status.userDataPath = app.getPath("userData");
  log.initialize();
  log.transports.file.resolvePathFn = () => join(app.getPath("userData"), "desktop.log");
  status.logPath = log.transports.file.getFile().path;
  await ensureRuntimeReleaseState();

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: "Yunwu Desktop",
    webPreferences: {
      preload: join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadFile(join(__dirname, "..", "renderer", "index.html"));
  broadcastStatus();
  broadcastUpdateStatus();
  // 上一次端内更新留下的临时目录，此时替换脚本早已结束，可以安全清理。
  void cleanupStagingDirs(getUpdateWorkDir()).catch(() => undefined);
  void checkDesktopUpdates().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    pushLog(`Update check failed: ${message}`);
  });
  void startStack();
}

ipcMain.handle("desktop:get-status", () => status);
ipcMain.handle("desktop:get-update-status", () => updateStatus);
ipcMain.handle("desktop:check-updates", async () => {
  return checkDesktopUpdates();
});
ipcMain.handle("desktop:apply-update", async () => {
  return applyDesktopUpdate();
});
ipcMain.handle("desktop:open-release-page", async () => {
  await shell.openExternal(
    updateStatus.releaseUrl ??
      releaseState.lastKnownLatest?.releaseUrl ??
      "https://github.com/Sou39O/Yunwu-custom-api/releases"
  );
});
ipcMain.handle("desktop:retry", async () => {
  await mainWindow?.loadFile(join(__dirname, "..", "renderer", "index.html"));
  void startStack();
});
ipcMain.handle("desktop:migrate-legacy", async () => {
  await mainWindow?.loadFile(join(__dirname, "..", "renderer", "index.html"));
  void manualMigrateLegacy();
});
ipcMain.handle("desktop:open-workbench", async () => {
  await clearWorkbenchCache();
  await mainWindow?.loadURL(status.webUrl);
});
ipcMain.handle("desktop:open-admin", async () => {
  await clearWorkbenchCache();
  await mainWindow?.loadURL(status.adminUrl);
});
ipcMain.handle("desktop:open-user-data", async () => {
  await shell.openPath(app.getPath("userData"));
});

app.whenReady().then(createWindow).catch((error) => {
  log.error(error);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  try {
    migrationProcess?.kill();
  } catch {
  }
  stopServer();
});
