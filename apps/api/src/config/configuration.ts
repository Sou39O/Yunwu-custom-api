export const configuration = () => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "file:./data/yunwu.db",
  web: {
    // 打包/生产模式下由 API 进程直接托管 Web 静态资源（替代 nginx）
    distDir: process.env.WEB_DIST_DIR,
  },
  tasks: {
    workerEnabled:
      (process.env.TASK_WORKER_ENABLED ??
        process.env.TASK_QUEUE_ENABLED ??
        "true") !== "false",
    workerConcurrency: Number(
      process.env.TASK_WORKER_CONCURRENCY ??
        process.env.TASK_QUEUE_CONCURRENCY ??
        50,
    ),
    batchWorkerConcurrency: Number(
      process.env.TASK_BATCH_WORKER_CONCURRENCY ?? 2,
    ),
  },
  cors: {
    origins: (
      process.env.CORS_ORIGIN ??
      process.env.WEB_ORIGIN ??
      `http://127.0.0.1:${process.env.PORT ?? 3000}`
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
  auth: {
    cookieName: process.env.AUTH_COOKIE_NAME ?? "yunwu_session",
    sessionSecret:
      process.env.AUTH_SESSION_SECRET ?? "yunwu-dev-session-secret-change-me",
    sessionTtlHours: Number(process.env.AUTH_SESSION_TTL_HOURS ?? 168),
    cookieSecure: process.env.AUTH_COOKIE_SECURE,
    admin: {
      email: process.env.AUTH_ADMIN_EMAIL ?? "admin@yunwu.local",
      password: process.env.AUTH_ADMIN_PASSWORD ?? "admin123456",
      displayName: process.env.AUTH_ADMIN_DISPLAY_NAME ?? "Administrator",
    },
    demo: {
      email: process.env.AUTH_DEMO_EMAIL ?? "demo@yunwu.local",
      password: process.env.AUTH_DEMO_PASSWORD ?? "demo123456",
      displayName: process.env.AUTH_DEMO_DISPLAY_NAME ?? "Demo User",
    },
  },
  storage: {
    // 默认本地文件存储；仅显式设置 STORAGE_MODE=s3 时使用远端对象存储
    mode: process.env.STORAGE_MODE ?? "local",
    local: {
      path: process.env.LOCAL_STORAGE_PATH ?? "./storage",
      publicBaseUrl: process.env.PUBLIC_ASSET_BASE_URL ?? undefined,
    },
    s3: {
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? process.env.AWS_REGION ?? "us-east-1",
      bucket: process.env.S3_BUCKET,
      accessKeyId:
        process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey:
        process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "false") === "true",
    },
  },
  provider: {
    // 图像上游类型：apixo（默认，APIXO Generation API） | openai-compatible（Yunwu）
    type: process.env.PROVIDER_TYPE ?? "apixo",
  },
  apixo: {
    providerName: process.env.APIXO_PROVIDER_NAME,
    baseUrl: process.env.APIXO_BASE_URL ?? "https://api.apixo.ai/api/v1",
    apiKey: process.env.APIXO_API_KEY,
    pollTimeoutMs: Number(process.env.APIXO_POLL_TIMEOUT_MS ?? 600_000),
  },
  yunwu: {
    providerName: process.env.YUNWU_PROVIDER_NAME,
    baseUrl: process.env.YUNWU_BASE_URL ?? "https://yunwu.ai",
    apiKey: process.env.YUNWU_API_KEY,
    allowMockImages: process.env.YUNWU_ALLOW_MOCK_IMAGES === "true",
  },
  openlux: {
    baseUrl: process.env.OPENLUX_BASE_URL ?? "https://api.openlux.ai/v1",
    apiKey: process.env.OPENLUX_API_KEY,
  },
  assetBackfill: {
    // 只存了上游 URL 的历史作品，启动后补下载到本地存储
    enabled: process.env.ASSET_BACKFILL_ENABLED ?? "true",
  },
});
