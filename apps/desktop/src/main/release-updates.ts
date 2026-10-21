import { net } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const appId = "ai.yunwu.desktop";
const repoOwner = "Sou39O";
const repoName = "Yunwu-custom-api";
const releaseManifestAssetName = "yunwu-release.json";
const githubLatestReleaseApiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/releases/latest`;
const githubLatestManifestUrl = `https://github.com/${repoOwner}/${repoName}/releases/latest/download/${releaseManifestAssetName}`;
const githubReleaseTagPathPattern = new RegExp(`^/${repoOwner}/${repoName}/releases/tag/v\\d+\\.\\d+\\.\\d+$`, "i");
const defaultReleaseFetchTimeoutMs = 30_000;

export type UpdatePhase =
  | "unknown"
  | "checking"
  | "up-to-date"
  | "desktop-update-required"
  | "image-update-available"
  | "blocked"
  | "applying"
  | "applied"
  | "error";

export type PortableAsset = {
  name: string;
  downloadUrl: string;
  sha256: string;
  size: number;
};

/** 端内更新的细分阶段，供界面显示进度。 */
export type UpdateStage = "download" | "verify" | "extract" | "stage" | "restart";

export type UpdateStatus = {
  phase: UpdatePhase;
  currentDesktopVersion: string;
  currentImageTag: string;
  latestVersion?: string;
  latestTag?: string;
  releaseUrl?: string;
  canOpenReleasePage: boolean;
  canApplyImageUpdate: boolean;
  /** 满足端内更新条件：清单提供了带 sha256 的 portable 包，且安装目录可写。 */
  canApplyDesktopUpdate: boolean;
  requiresDesktopUpdate: boolean;
  portableAsset?: PortableAsset;
  stage?: UpdateStage;
  downloadedBytes?: number;
  totalBytes?: number;
  message: string;
  checkedAt?: string;
  error?: string;
};

export type ReleaseState = {
  schemaVersion: 1;
  desktopVersion: string;
  bundledImageTag: string;
  currentImageTag: string;
  currentManifestTag: string;
  lastCheckedAt: string | null;
  lastAppliedAt: string | null;
  lastKnownLatest: {
    version: string;
    tag: string;
    releaseUrl: string;
  } | null;
  lastPortableAsset: PortableAsset | null;
  lastError: string | null;
};

type ReleaseManifest = {
  schemaVersion: 1;
  appId: string;
  channel: string;
  version: string;
  tag: string;
  releaseUrl: string;
  desktop: {
    minSupportedVersion: string;
    requiresDesktopUpdate: boolean;
    portableAsset?: {
      name: string;
      sha256?: string;
      size?: number;
    };
  };
  stack: {
    imageOnlySupported: boolean;
    composeSchemaVersion: number;
    runtimeEnvVersion: number;
  };
  migration?: {
    hasDatabaseMigration?: boolean;
    risk?: string;
    rollbackSupported?: boolean;
  };
  updateBlocked?: boolean;
};

type GitHubReleaseResponse = {
  tag_name?: string;
  html_url?: string;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function toImageTag(version: string) {
  const normalized = normalizeVersion(version);
  return normalized ? `v${normalized}` : version;
}

function normalizeVersion(value: string) {
  const match = value.trim().match(/^v?(\d+\.\d+\.\d+)$/);
  return match?.[1];
}

function normalizeTag(value: string) {
  const version = normalizeVersion(value);
  return version ? `v${version}` : undefined;
}

function normalizeAllowedReleaseUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    return ensureAllowedReleaseUrl(value);
  } catch {
    return undefined;
  }
}

function parseVersion(value: string) {
  const normalized = normalizeVersion(value);
  if (!normalized) return undefined;
  return normalized.split(".").map((part) => Number.parseInt(part, 10));
}

export function compareVersions(left: string, right: string) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return 0;

  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) return delta;
  }

  return 0;
}

const githubReleaseDownloadPathPattern = new RegExp(
  `^/${repoOwner}/${repoName}/releases/download/v\\d+\\.\\d+\\.\\d+/[^/]+$`,
  "i"
);

/** 下载地址只允许本仓库 Release 的 portable 资产。 */
export function ensureAllowedDownloadUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !githubReleaseDownloadPathPattern.test(url.pathname)
  ) {
    throw new Error("Download URL is not an allowed GitHub release asset URL.");
  }
  ensureAllowedAssetName(decodeURIComponent(url.pathname.split("/").pop() ?? ""));
  return url.toString();
}

export function buildPortableDownloadUrl(tag: string, assetName: string) {
  return ensureAllowedDownloadUrl(
    `https://github.com/${repoOwner}/${repoName}/releases/download/${tag}/${encodeURIComponent(assetName)}`
  );
}

function normalizePortableAsset(value: unknown): PortableAsset | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  const sha256 = asString(value.sha256);
  const downloadUrl = asString(value.downloadUrl);
  if (!name || !sha256 || !downloadUrl) return null;
  try {
    return {
      name: ensureAllowedAssetName(name),
      downloadUrl: ensureAllowedDownloadUrl(downloadUrl),
      sha256: /^[0-9a-f]{64}$/i.test(sha256) ? sha256.toLowerCase() : (() => {
        throw new Error("sha256 is not a 64-hex digest.");
      })(),
      size: asNumber(value.size, 0)
    };
  } catch {
    return null;
  }
}

/** 清单里的 portable 资产必须带 sha256，否则不允许端内更新。 */
function portableAssetFromManifest(manifest: ReleaseManifest): PortableAsset | null {
  const asset = manifest.desktop.portableAsset;
  if (!asset?.sha256) return null;
  return normalizePortableAsset({
    name: asset.name,
    sha256: asset.sha256,
    size: asset.size,
    downloadUrl: (() => {
      try {
        return buildPortableDownloadUrl(manifest.tag, asset.name);
      } catch {
        return undefined;
      }
    })()
  });
}

export function getReleaseStatePath(runtimeDir: string) {
  return join(runtimeDir, "release-state.json");
}

export function defaultReleaseState(appVersion: string): ReleaseState {
  const bundledImageTag = toImageTag(appVersion);
  return {
    schemaVersion: 1,
    desktopVersion: appVersion,
    bundledImageTag,
    currentImageTag: bundledImageTag,
    currentManifestTag: bundledImageTag,
    lastCheckedAt: null,
    lastAppliedAt: null,
    lastKnownLatest: null,
    lastPortableAsset: null,
    lastError: null
  };
}

function normalizeReleaseState(value: unknown, appVersion: string): ReleaseState {
  const fallback = defaultReleaseState(appVersion);
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return fallback;
  }

  const bundledImageTag = toImageTag(appVersion);
  const existingImageTag = normalizeTag(asString(value.currentImageTag) ?? "") ?? bundledImageTag;
  const currentImageTag =
    compareVersions(bundledImageTag, existingImageTag) > 0 ? bundledImageTag : existingImageTag;
  const latest = isRecord(value.lastKnownLatest) ? value.lastKnownLatest : null;
  const latestTag = latest ? normalizeTag(asString(latest.tag) ?? "") : undefined;
  const latestVersion = latestTag ? latestTag.slice(1) : undefined;
  const latestReleaseUrl = latest ? normalizeAllowedReleaseUrl(asString(latest.releaseUrl)) : undefined;

  return {
    schemaVersion: 1,
    desktopVersion: appVersion,
    bundledImageTag,
    currentImageTag,
    currentManifestTag: normalizeTag(asString(value.currentManifestTag) ?? "") ?? currentImageTag,
    lastCheckedAt: asString(value.lastCheckedAt) ?? null,
    lastAppliedAt: asString(value.lastAppliedAt) ?? null,
    lastKnownLatest:
      latestTag && latestVersion && latestReleaseUrl
        ? { version: latestVersion, tag: latestTag, releaseUrl: latestReleaseUrl }
        : null,
    lastPortableAsset: normalizePortableAsset(value.lastPortableAsset),
    lastError: asString(value.lastError) ?? null
  };
}

export async function loadReleaseState(runtimeDir: string, appVersion: string) {
  await mkdir(runtimeDir, { recursive: true });
  const path = getReleaseStatePath(runtimeDir);
  let state = defaultReleaseState(appVersion);
  try {
    state = normalizeReleaseState(JSON.parse(await readFile(path, "utf8")), appVersion);
  } catch {
    state = defaultReleaseState(appVersion);
  }
  await saveReleaseState(runtimeDir, state);
  return state;
}

export async function saveReleaseState(runtimeDir: string, state: ReleaseState) {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(getReleaseStatePath(runtimeDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function createInitialUpdateStatus(state: ReleaseState): UpdateStatus {
  return {
    phase: "unknown",
    currentDesktopVersion: state.desktopVersion,
    currentImageTag: state.currentImageTag,
    canOpenReleasePage: Boolean(state.lastKnownLatest?.releaseUrl),
    canApplyImageUpdate: false,
    canApplyDesktopUpdate: false,
    requiresDesktopUpdate: false,
    ...(state.lastKnownLatest
      ? {
          latestVersion: state.lastKnownLatest.version,
          latestTag: state.lastKnownLatest.tag,
          releaseUrl: state.lastKnownLatest.releaseUrl
        }
      : {}),
    message: state.lastError ?? "尚未检查更新。",
    ...(state.lastCheckedAt ? { checkedAt: state.lastCheckedAt } : {}),
    ...(state.lastError ? { error: state.lastError } : {})
  };
}

export function createCheckingUpdateStatus(state: ReleaseState): UpdateStatus {
  return {
    ...createInitialUpdateStatus(state),
    phase: "checking",
    message: "正在检查更新..."
  };
}

function ensureAllowedReleaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !githubReleaseTagPathPattern.test(url.pathname)) {
    throw new Error("Release URL is not an allowed GitHub release URL.");
  }
  return url.toString();
}

function ensureAllowedAssetName(value: string) {
  if (!/^Yunwu[ .]Desktop-\d+\.\d+\.\d+-win-x64-portable\.zip$/.test(value)) {
    throw new Error("Portable asset name is not allowed.");
  }
  return value;
}

function parseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value)) {
    throw new Error("Release manifest must be a JSON object.");
  }
  if (value.schemaVersion !== 1 || value.appId !== appId) {
    throw new Error("Release manifest schema or appId is not supported.");
  }

  const tag = normalizeTag(asString(value.tag) ?? "");
  const version = normalizeVersion(asString(value.version) ?? "");
  const releaseUrl = ensureAllowedReleaseUrl(asString(value.releaseUrl) ?? "");
  if (!tag || !version || tag !== `v${version}`) {
    throw new Error("Release manifest version/tag is invalid.");
  }

  const desktop = isRecord(value.desktop) ? value.desktop : {};
  const stack = isRecord(value.stack) ? value.stack : {};
  const migration = isRecord(value.migration) ? value.migration : undefined;
  const portableAsset = isRecord(desktop.portableAsset) ? desktop.portableAsset : undefined;

  return {
    schemaVersion: 1,
    appId,
    channel: asString(value.channel) ?? "stable",
    version,
    tag,
    releaseUrl,
    desktop: {
      minSupportedVersion: normalizeVersion(asString(desktop.minSupportedVersion) ?? "") ?? version,
      requiresDesktopUpdate: asBoolean(desktop.requiresDesktopUpdate, true),
      ...(portableAsset
        ? {
            portableAsset: {
              name: ensureAllowedAssetName(asString(portableAsset.name) ?? ""),
              sha256: asString(portableAsset.sha256),
              size: asNumber(portableAsset.size, 0)
            }
          }
        : {})
    },
    stack: {
      imageOnlySupported: asBoolean(stack.imageOnlySupported, false),
      composeSchemaVersion: asNumber(stack.composeSchemaVersion, 1),
      runtimeEnvVersion: asNumber(stack.runtimeEnvVersion, 1)
    },
    migration: migration
      ? {
          hasDatabaseMigration: asBoolean(migration.hasDatabaseMigration, false),
          risk: asString(migration.risk),
          rollbackSupported: asBoolean(migration.rollbackSupported, false)
        }
      : undefined,
    updateBlocked: asBoolean(value.updateBlocked, false)
  };
}

function describeFetchError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return `GitHub 更新检查超时（${Math.round(getPositiveIntegerEnv("YUNWU_DESKTOP_RELEASE_TIMEOUT_MS", defaultReleaseFetchTimeoutMs) / 1000)} 秒）。请检查网络或稍后重试；这不会影响本地已安装版本继续使用。`;
    }
    if (/aborted|aborterror/i.test(error.message)) {
      return "GitHub 更新检查被中止。请检查网络或稍后重试；这不会影响本地已安装版本继续使用。";
    }
    return error.message;
  }
  return String(error);
}

async function fetchJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    getPositiveIntegerEnv("YUNWU_DESKTOP_RELEASE_TIMEOUT_MS", defaultReleaseFetchTimeoutMs)
  );
  try {
    const response = await net.fetch(url, {
      headers: {
        Accept: "application/vnd.github+json, application/json",
        "User-Agent": "Yunwu-Desktop-Updater"
      },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}.`);
    }
    return response.json() as Promise<unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackManifestFromRelease(release: GitHubReleaseResponse): ReleaseManifest {
  const tag = normalizeTag(release.tag_name ?? "");
  if (!tag) {
    throw new Error("Latest GitHub release does not have a semver tag.");
  }
  const version = tag.slice(1);
  return parseManifest({
    schemaVersion: 1,
    appId,
    channel: "stable",
    version,
    tag,
    releaseUrl: release.html_url ?? `https://github.com/${repoOwner}/${repoName}/releases/tag/${tag}`,
    desktop: {
      minSupportedVersion: version,
      requiresDesktopUpdate: true
    },
    stack: {
      imageOnlySupported: false,
      composeSchemaVersion: 1,
      runtimeEnvVersion: 1
    }
  });
}

async function fetchLatestManifest() {
  const manifestOverrideUrl = process.env.YUNWU_DESKTOP_RELEASE_MANIFEST_URL?.trim();
  if (manifestOverrideUrl) {
    return parseManifest(await fetchJson(manifestOverrideUrl));
  }

  try {
    return parseManifest(await fetchJson(githubLatestManifestUrl));
  } catch {
    // Older releases did not have a manifest; fall back to the GitHub Release API.
  }

  const releaseApiUrl = process.env.YUNWU_DESKTOP_RELEASE_API_URL?.trim() || githubLatestReleaseApiUrl;
  const release = (await fetchJson(releaseApiUrl)) as GitHubReleaseResponse;
  const manifestAsset = release.assets?.find((asset) => asset.name === releaseManifestAssetName);
  if (!manifestAsset?.browser_download_url) {
    return fallbackManifestFromRelease(release);
  }

  return parseManifest(await fetchJson(manifestAsset.browser_download_url));
}

function classifyUpdate(state: ReleaseState, manifest: ReleaseManifest): UpdateStatus {
  const checkedAt = new Date().toISOString();
  const portableAsset = portableAssetFromManifest(manifest);
  const latestIsNewerThanDesktop = compareVersions(manifest.version, state.desktopVersion) > 0;
  const latestIsNewerThanImage = compareVersions(manifest.version, state.currentImageTag) > 0;
  const desktopMeetsMinimum = compareVersions(state.desktopVersion, manifest.desktop.minSupportedVersion) >= 0;
  const base = {
    currentDesktopVersion: state.desktopVersion,
    currentImageTag: state.currentImageTag,
    latestVersion: manifest.version,
    latestTag: manifest.tag,
    releaseUrl: manifest.releaseUrl,
    canOpenReleasePage: true,
    checkedAt
  };

  if (!latestIsNewerThanDesktop && !latestIsNewerThanImage) {
    return {
      ...base,
      phase: "up-to-date",
      canApplyImageUpdate: false,
      canApplyDesktopUpdate: false,
      requiresDesktopUpdate: false,
      message: "当前已是最新版本。"
    };
  }

  if (manifest.updateBlocked) {
    return {
      ...base,
      phase: "blocked",
      canApplyImageUpdate: false,
      canApplyDesktopUpdate: false,
      requiresDesktopUpdate: false,
      message: `发现新版 ${manifest.tag}，此版本需要手动处理，请查看发布说明。`
    };
  }

  if (!desktopMeetsMinimum) {
    return {
      ...base,
      phase: "desktop-update-required",
      canApplyImageUpdate: false,
      canApplyDesktopUpdate: Boolean(portableAsset),
      requiresDesktopUpdate: true,
      ...(portableAsset ? { portableAsset } : {}),
      message: portableAsset
        ? `发现新版 ${manifest.tag}，可直接在应用内下载并更新。`
        : `发现新版 ${manifest.tag}，需要手动下载新的桌面包。`
    };
  }

  if (
    !manifest.desktop.requiresDesktopUpdate &&
    ((manifest.stack.imageOnlySupported && !latestIsNewerThanImage) ||
      (!manifest.stack.imageOnlySupported && !latestIsNewerThanDesktop && !latestIsNewerThanImage))
  ) {
    return {
      ...base,
      phase: "up-to-date",
      canApplyImageUpdate: false,
      canApplyDesktopUpdate: false,
      requiresDesktopUpdate: false,
      message: "当前已是最新版本。"
    };
  }

  if (
    manifest.desktop.requiresDesktopUpdate ||
    (latestIsNewerThanDesktop && !manifest.stack.imageOnlySupported)
  ) {
    return {
      ...base,
      phase: "desktop-update-required",
      canApplyImageUpdate: false,
      canApplyDesktopUpdate: Boolean(portableAsset),
      requiresDesktopUpdate: true,
      ...(portableAsset ? { portableAsset } : {}),
      message: portableAsset
        ? `发现新版 ${manifest.tag}，可直接在应用内下载并更新。`
        : `发现新版 ${manifest.tag}，需要手动下载新的桌面包。`
    };
  }

  if (manifest.stack.imageOnlySupported && latestIsNewerThanImage) {
    return {
      ...base,
      phase: "image-update-available",
      canApplyImageUpdate: false,
      canApplyDesktopUpdate: false,
      requiresDesktopUpdate: false,
      message: `发现可用服务镜像 ${manifest.tag}。当前版本仅提示更新，暂不自动切换镜像。`
    };
  }

  return {
    ...base,
    phase: "blocked",
    canApplyImageUpdate: false,
    canApplyDesktopUpdate: false,
    requiresDesktopUpdate: false,
    message: "发现新版，但当前桌面壳无法确认安全更新路径，请查看发布说明。"
  };
}

export async function checkForUpdates(runtimeDir: string, state: ReleaseState) {
  try {
    const manifest = await fetchLatestManifest();
    const status = classifyUpdate(state, manifest);
    const nextState: ReleaseState = {
      ...state,
      lastCheckedAt: status.checkedAt ?? new Date().toISOString(),
      lastKnownLatest: {
        version: manifest.version,
        tag: manifest.tag,
        releaseUrl: manifest.releaseUrl
      },
      lastPortableAsset: status.portableAsset ?? null,
      lastError: null
    };
    await saveReleaseState(runtimeDir, nextState);
    return { state: nextState, status };
  } catch (error) {
    const message = describeFetchError(error);
    const checkedAt = new Date().toISOString();
    const nextState: ReleaseState = {
      ...state,
      lastCheckedAt: checkedAt,
      lastError: message
    };
    await saveReleaseState(runtimeDir, nextState);
    return {
      state: nextState,
      status: {
        ...createInitialUpdateStatus(nextState),
        phase: "error" as const,
        checkedAt,
        error: message,
        message: `更新检查失败：${message}`
      }
    };
  }
}
