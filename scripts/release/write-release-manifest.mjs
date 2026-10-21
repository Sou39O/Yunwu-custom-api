import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const repo = "Sou39O/Yunwu-custom-api";
const registry = "ghcr.io/sou39o";
const imagePrefix = `${registry}/yunwu-custom-api`;

function readArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    args.set(value.slice(2), argv[index + 1]);
    index += 1;
  }
  return args;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "true";
}

function normalizeTag(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function versionFromTag(tag) {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

async function sha256(filePath) {
  const buffer = await readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

const args = readArgs(process.argv.slice(2));
const versionInput = args.get("version") ?? process.env.RELEASE_VERSION;
const artifactPath = args.get("artifact") ?? process.env.RELEASE_ARTIFACT;
const outputPath = args.get("output") ?? process.env.RELEASE_MANIFEST_OUTPUT;
const commit = args.get("commit") ?? process.env.GITHUB_SHA ?? "";

if (!versionInput || !artifactPath || !outputPath) {
  throw new Error("Usage: node write-release-manifest.mjs --version vX.Y.Z --artifact <zip> --output <json>");
}

const tag = normalizeTag(versionInput);
const version = versionFromTag(tag);
const artifactStat = await stat(artifactPath);
const assetName = basename(artifactPath).replace(/\s+/g, ".");
const hasDatabaseMigration = boolEnv("YUNWU_RELEASE_HAS_DATABASE_MIGRATION", false);
const requiresDesktopUpdate = boolEnv("YUNWU_RELEASE_REQUIRES_DESKTOP_UPDATE", true);
const imageOnlySupported = boolEnv("YUNWU_RELEASE_IMAGE_ONLY_SUPPORTED", false);
const updateBlocked = boolEnv("YUNWU_RELEASE_UPDATE_BLOCKED", false);

const manifest = {
  schemaVersion: 1,
  appId: "ai.yunwu.desktop",
  channel: process.env.YUNWU_RELEASE_CHANNEL ?? "stable",
  version,
  tag,
  commit,
  updateBlocked,
  publishedAt: new Date().toISOString(),
  releaseUrl: `https://github.com/${repo}/releases/tag/${tag}`,
  releaseNotes: {
    summary:
      process.env.YUNWU_RELEASE_SUMMARY ??
      "Publishes the Yunwu Desktop portable package and matching Docker image stack.",
    url: `https://github.com/${repo}/releases/tag/${tag}`
  },
  desktop: {
    version,
    minSupportedVersion: process.env.YUNWU_RELEASE_MIN_DESKTOP_VERSION ?? version,
    requiresDesktopUpdate,
    portableAsset: {
      name: assetName,
      sha256: await sha256(artifactPath),
      size: artifactStat.size
    }
  },
  stack: {
    imageOnlySupported,
    composeSchemaVersion: Number(process.env.YUNWU_RELEASE_COMPOSE_SCHEMA_VERSION ?? 2),
    runtimeEnvVersion: Number(process.env.YUNWU_RELEASE_RUNTIME_ENV_VERSION ?? 2),
    images: {
      api: `${imagePrefix}-api:${tag}`,
      worker: `${imagePrefix}-worker:${tag}`,
      web: `${imagePrefix}-web:${tag}`
    }
  },
  migration: {
    hasDatabaseMigration,
    risk: process.env.YUNWU_RELEASE_MIGRATION_RISK ?? (hasDatabaseMigration ? "additive" : "none"),
    rollbackSupported: boolEnv("YUNWU_RELEASE_ROLLBACK_SUPPORTED", false),
    notes: (process.env.YUNWU_RELEASE_MIGRATION_NOTES ??
      "No database migration is introduced by this release.|Existing conversations, tasks, assets, users, and settings are preserved.")
      .split("|")
      .map((note) => note.trim())
      .filter(Boolean)
  },
  compatibility: {
    from: (process.env.YUNWU_RELEASE_COMPAT_FROM ?? "v0.4.3,v0.5.0,v0.5.1,v0.6.0")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    requiresManualZipUpgradeFrom: (process.env.YUNWU_RELEASE_MANUAL_ZIP_FROM ?? "v0.4.3,v0.5.0,v0.5.1,v0.6.0")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
};

await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Wrote release manifest to ${outputPath}`);
