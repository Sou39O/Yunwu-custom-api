import assert from "node:assert/strict";
import test from "node:test";
import { TaskExecutionService } from "../src/tasks/task-execution.service";
import {
  OpenAICompatibleRequestError,
  OpenAICompatibleService,
  PROVIDER_API_KEY_NOT_CONFIGURED_MESSAGE,
} from "../src/openai-compatible/openai-compatible.service";

const NOW = new Date("2026-04-24T08:00:00.000Z");

/**
 * 适配新的 route-aware 门面：TaskExecutionService 现在按线路调用上游，
 * 测试里仍复用单上游 mock。
 */
function asImageProvider(provider: {
  getBaseConfig: () => unknown;
  createImageTask: (request: never) => unknown;
  providerId?: string;
}) {
  return {
    providerId: provider.providerId ?? "openai-compatible",
    getBaseConfig: async () => provider.getBaseConfig(),
    createImageTask: async (
      _routeId: string,
      request: Record<string, unknown>,
    ) => provider.createImageTask(request as never),
  };
}

/** 线路密钥读取：沿用各用例已有的 $queryRaw 桩数据。 */
function createCredentialsMock(prisma: {
  $queryRaw: (...args: never[]) => Promise<unknown>;
}) {
  return {
    getSecretForExecution: async () => {
      const rows = (await (prisma.$queryRaw as () => Promise<unknown>)()) as
        | Array<{ providerApiKey?: string | null }>
        | undefined;
      return rows?.[0]?.providerApiKey?.trim() || undefined;
    },
  };
}

function createAssetStorageMock(calls?: {
  store?: Array<Record<string, unknown>>;
}) {
  return {
    store: async (input: Record<string, unknown>) => {
      calls?.store?.push(input);
      return { kind: "local" };
    },
    getPublicUrl: (storageKey: string) => `/api/assets/${storageKey}/content`,
  };
}

test("TaskExecutionService fails user image tasks without API key and does not create assets", async () => {
  const calls = {
    assetCreate: [] as Array<Record<string, unknown>>,
    messageCreate: [] as Array<Record<string, unknown>>,
    taskUpdates: [] as Array<Record<string, unknown>>,
    taskEvents: [] as Array<Record<string, unknown>>,
    published: [] as Array<Record<string, unknown>>,
  };

  const task = {
    id: "task-no-key",
    userId: "user-1",
    conversationId: "conv-1",
    type: "image.generate",
    status: "queued",
    progress: 0,
    input: {
      providerRouteId: "yunwu",
      model: "gpt-image-2",
      prompt: "Draw a fail-closed diagnostic image",
      assetIds: [],
      params: { size: "1024x1024" },
    },
    conversation: { id: "conv-1" },
    assets: [],
    createdAt: NOW,
    updatedAt: NOW,
  };

  const prisma = {
    task: {
      findUnique: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskUpdates.push(data);
        return { ...task, ...data };
      },
    },
    asset: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.assetCreate.push(data);
        return { id: "asset-should-not-exist", ...data };
      },
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.messageCreate.push(data);
        return { id: "msg-1", ...data };
      },
    },
    $queryRaw: async () => [],
  };
  const config = {
    get: (key: string) => {
      if (key === "yunwu.apiKey") {
        return "";
      }
      if (key === "yunwu.allowMockImages") {
        return false;
      }
      return undefined;
    },
  };
  const providerConfig = {
    getBaseUrl: async () => "https://yunwu.ai",
  };
  const openaiCompatible = new OpenAICompatibleService(
    config as never,
    providerConfig as never,
  );
  const providerState = {
    persistTestFinished: async () => undefined,
    getState: async () => null,
  };
  const providerAlerts = {
    refreshAlerts: async <T>(value: T) => value,
  };
  const conversationEvents = {
    publishTaskUpdated: (payload: Record<string, unknown>) => {
      calls.published.push(payload);
    },
  };
  const taskEvents = {
    record: async (payload: Record<string, unknown>) => {
      calls.taskEvents.push(payload);
    },
  };
  const service = new TaskExecutionService(
    prisma as never,
    asImageProvider(openaiCompatible) as never,
    createCredentialsMock(prisma) as never,
    providerState as never,
    providerAlerts as never,
    conversationEvents as never,
    taskEvents as never,
    createAssetStorageMock() as never,
    { maybeSchedule: async () => ({ scheduled: false }) } as never,
  );

  await service.execute(task.id);

  assert.equal(calls.assetCreate.length, 0);
  assert.ok(
    calls.taskUpdates.some(
      (update) =>
        update.status === "failed" &&
        update.errorMessage === PROVIDER_API_KEY_NOT_CONFIGURED_MESSAGE,
    ),
  );
  assert.equal(
    calls.messageCreate.at(-1)?.content,
    PROVIDER_API_KEY_NOT_CONFIGURED_MESSAGE,
  );
  assert.ok(
    calls.taskEvents.some(
      (event) =>
        event.eventType === "failed" &&
        event.errorMessage === PROVIDER_API_KEY_NOT_CONFIGURED_MESSAGE,
    ),
  );
  assert.equal(calls.published.at(-1)?.status, "failed");
});

test("TaskExecutionService prefers the user API key over the global key", async () => {
  const calls = {
    requests: [] as Array<Record<string, unknown>>,
    published: [] as Array<Record<string, unknown>>,
    storage: [] as Array<Record<string, unknown>>,
  };
  const task = {
    id: "task-user-key",
    userId: "user-1",
    conversationId: "conv-1",
    type: "image.generate",
    status: "queued",
    progress: 0,
    input: {
      providerRouteId: "yunwu",
      model: "gpt-image-2",
      prompt: "Draw a lantern by the lake",
      assetIds: [],
      params: { size: "1024x1024" },
    },
    conversation: { id: "conv-1" },
    assets: [],
    createdAt: NOW,
    updatedAt: NOW,
  };

  const prisma = {
    task: {
      findUnique: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => ({ ...task, ...data }),
    },
    asset: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "asset-1", ...data }),
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "msg-1", ...data }),
    },
    $queryRaw: async () => [{ providerApiKey: "sk-user-secret-123456" }],
  };
  const openaiCompatible = {
    getBaseConfig: async () => ({ hasApiKey: false, baseUrl: "https://yunwu.ai" }),
    createImageTask: async (request: Record<string, unknown>) => {
      calls.requests.push(request);
      return {
        url: "data:image/png;base64,cmVtb3RlLXBuZw==",
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        responseSummary: { mode: "live" },
        mocked: false,
      };
    },
  };
  const providerState = {
    persistTestFinished: async () => undefined,
    getState: async () => null,
  };
  const providerAlerts = {
    refreshAlerts: async <T>(value: T) => value,
  };
  const conversationEvents = {
    publishTaskUpdated: (payload: Record<string, unknown>) => {
      calls.published.push(payload);
    },
  };
  const taskEvents = {
    record: async () => undefined,
  };
  const service = new TaskExecutionService(
    prisma as never,
    asImageProvider(openaiCompatible) as never,
    createCredentialsMock(prisma) as never,
    providerState as never,
    providerAlerts as never,
    conversationEvents as never,
    taskEvents as never,
    createAssetStorageMock({ store: calls.storage }) as never,
    { maybeSchedule: async () => ({ scheduled: false }) } as never,
  );

  await service.execute(task.id);

  assert.equal(calls.requests[0]?.apiKey, "sk-user-secret-123456");
  assert.equal(calls.requests[0]?.allowMock, false);
  assert.equal(calls.storage.length, 1);
  assert.equal((calls.storage[0]?.buffer as Buffer).toString(), "remote-png");
  assert.equal(calls.storage[0]?.mimeType, "image/png");
  assert.equal(calls.published.at(-1)?.status, "succeeded");
});

test("TaskExecutionService keeps remote provider URLs when local materialization fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 403,
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as Response) as typeof fetch;

  const calls = {
    assetCreate: [] as Array<Record<string, unknown>>,
    published: [] as Array<Record<string, unknown>>,
  };
  const task = {
    id: "task-remote-url",
    userId: "user-1",
    conversationId: "conv-1",
    type: "image.generate",
    status: "queued",
    progress: 0,
    input: {
      providerRouteId: "yunwu",
      model: "grok-4.2-image",
      prompt: "Draw a blue triangle",
      assetIds: [],
      params: { size: "1024x1024" },
    },
    conversation: { id: "conv-1" },
    assets: [],
    createdAt: NOW,
    updatedAt: NOW,
  };

  const prisma = {
    task: {
      findUnique: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => ({ ...task, ...data }),
    },
    asset: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.assetCreate.push(data);
        return { id: "asset-remote", ...data };
      },
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "msg-1", ...data }),
    },
    $queryRaw: async () => [{ providerApiKey: "sk-user-secret-123456" }],
  };
  const openaiCompatible = {
    getBaseConfig: async () => ({ hasApiKey: false, baseUrl: "https://yunwu.ai" }),
    createImageTask: async () => ({
      url: "https://provider.example/grok-output.jpg",
      mimeType: "image/jpeg",
      width: 1024,
      height: 1024,
      responseSummary: { mode: "live", hasUrl: true },
      mocked: false,
    }),
  };
  const service = new TaskExecutionService(
    prisma as never,
    asImageProvider(openaiCompatible) as never,
    createCredentialsMock(prisma) as never,
    { persistTestFinished: async () => undefined, getState: async () => null } as never,
    { refreshAlerts: async <T>(value: T) => value } as never,
    { publishTaskUpdated: (payload: Record<string, unknown>) => calls.published.push(payload) } as never,
    { record: async () => undefined } as never,
    createAssetStorageMock() as never,
    { maybeSchedule: async () => ({ scheduled: false }) } as never,
  );

  try {
    await service.execute(task.id);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.assetCreate[0]?.url, "https://provider.example/grok-output.jpg");
  assert.equal(calls.assetCreate[0]?.storageKey, undefined);
  assert.equal((calls.assetCreate[0]?.metadata as Record<string, unknown>).storage, "remote-url");
  assert.equal(calls.published.at(-1)?.status, "succeeded");
});

test("TaskExecutionService records concrete provider request failure details", async () => {
  const calls = {
    taskUpdates: [] as Array<Record<string, unknown>>,
    taskEvents: [] as Array<Record<string, unknown>>,
    messageCreate: [] as Array<Record<string, unknown>>,
  };
  const task = {
    id: "task-provider-fetch-failed",
    userId: "user-1",
    conversationId: "conv-1",
    type: "image.generate",
    status: "queued",
    progress: 0,
    input: {
      providerRouteId: "yunwu",
      model: "gpt-image-2",
      prompt: "Draw a diagnostic image",
      assetIds: [],
      params: {},
      providerBaseUrl: "https://yunwu.ai",
    },
    conversation: { id: "conv-1" },
    assets: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  const prisma = {
    task: {
      findUnique: async () => task,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskUpdates.push(data);
        return { ...task, ...data };
      },
    },
    asset: {
      findMany: async () => [],
      create: async () => {
        throw new Error("asset should not be created");
      },
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.messageCreate.push(data);
        return { id: "msg-1", ...data };
      },
    },
    $queryRaw: async () => [{ providerApiKey: "sk-user-secret-123456" }],
  };
  const openaiCompatible = {
    getBaseConfig: async () => ({ hasApiKey: true, baseUrl: "https://yunwu.ai" }),
    createImageTask: async () => {
      throw new OpenAICompatibleRequestError("fetch failed", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "request",
        errorKind: "connection_reset",
        fetchErrorName: "TypeError",
        fetchCauseCode: "ECONNRESET",
        fetchCauseMessage: "read ECONNRESET",
      });
    },
  };
  const service = new TaskExecutionService(
    prisma as never,
    asImageProvider(openaiCompatible) as never,
    createCredentialsMock(prisma) as never,
    { persistTestFinished: async () => undefined, getState: async () => null } as never,
    { refreshAlerts: async <T>(value: T) => value } as never,
    { publishTaskUpdated: () => undefined } as never,
    {
      record: async (payload: Record<string, unknown>) => {
        calls.taskEvents.push(payload);
      },
    } as never,
    createAssetStorageMock() as never,
    { maybeSchedule: async () => ({ scheduled: false }) } as never,
  );

  await service.execute(task.id);

  const providerResponse = calls.taskEvents.find(
    (event) => event.eventType === "provider.response",
  );
  assert.equal(providerResponse?.status, "running");
  assert.equal(
    (providerResponse?.details as Record<string, unknown> | undefined)?.stage,
    "request",
  );
  assert.equal(
    (providerResponse?.details as Record<string, unknown> | undefined)
      ?.fetchCauseCode,
    "ECONNRESET",
  );

  const failed = calls.taskEvents.find((event) => event.eventType === "failed");
  const failedDetails = failed?.details as Record<string, unknown> | undefined;
  assert.equal(failedDetails?.category, "provider_unreachable");
  assert.equal(failedDetails?.errorStage, "request");
  assert.equal(failedDetails?.errorKind, "connection_reset");
  assert.equal(calls.taskUpdates.at(-1)?.status, "failed");
  assert.equal(
    calls.messageCreate.at(-1)?.content,
    "The image provider closed the connection before returning a response. Please retry later.",
  );
});

test("TaskExecutionService executes batch slots concurrently and stores partial success summary", async () => {
  const calls = {
    assetCreate: [] as Array<Record<string, unknown>>,
    messageCreate: [] as Array<Record<string, unknown>>,
    taskUpdates: [] as Array<Record<string, unknown>>,
    taskEvents: [] as Array<Record<string, unknown>>,
    published: [] as Array<Record<string, unknown>>,
    storage: [] as Array<Record<string, unknown>>,
  };
  const batchItems = [0, 1, 2].map((batchIndex) => ({
    id: `batch-item-${batchIndex}`,
    taskId: "task-batch-partial",
    batchIndex,
    status: "queued",
    progress: 0,
    assetId: null as string | null,
    errorMessage: null as string | null,
    attempt: 0,
    providerSummary: null as Record<string, unknown> | null,
    output: null as Record<string, unknown> | null,
    startedAt: null as Date | null,
    completedAt: null as Date | null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const task = {
    id: "task-batch-partial",
    userId: "user-1",
    conversationId: "conv-1",
    type: "image.generate",
    status: "queued",
    progress: 0,
    input: {
      providerRouteId: "yunwu",
      model: "gpt-image-2",
      prompt: "Draw three lantern variations",
      assetIds: [],
      params: { size: "1024x1024" },
      batchCount: 3,
    },
    output: null as Record<string, unknown> | null,
    errorMessage: null as string | null,
    conversation: { id: "conv-1" },
    assets: [] as Array<Record<string, unknown>>,
    batchItems,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const cloneTask = () => ({
    ...task,
    batchItems: batchItems.map((item) => ({ ...item })),
  });
  const prisma = {
    task: {
      findUnique: async (args?: { select?: Record<string, unknown> }) => {
        if (args?.select?.output) {
          return { output: task.output };
        }

        return cloneTask();
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskUpdates.push(data);
        Object.assign(task, data);
        return cloneTask();
      },
    },
    taskBatchItem: {
      findMany: async () => batchItems.map((item) => ({ ...item })),
      updateMany: async ({
        where,
        data,
      }: {
        where: { id?: { in?: string[] } };
        data: Record<string, unknown>;
      }) => {
        const ids = new Set(where.id?.in ?? []);
        let count = 0;
        for (const item of batchItems) {
          if (!ids.has(item.id)) {
            continue;
          }
          count += 1;
          Object.assign(item, {
            ...data,
            attempt:
              typeof (data.attempt as { increment?: number } | undefined)
                ?.increment === "number"
                ? item.attempt + (data.attempt as { increment: number }).increment
                : item.attempt,
          });
        }

        return { count };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const item = batchItems.find((candidate) => candidate.id === where.id);
        if (!item) {
          throw new Error(`Unknown batch item ${where.id}`);
        }
        Object.assign(item, data);
        return { ...item };
      },
    },
    asset: {
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const asset = {
          id: `asset-${calls.assetCreate.length + 1}`,
          ...data,
          createdAt: NOW,
          updatedAt: NOW,
        };
        calls.assetCreate.push(asset);
        return asset;
      },
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.messageCreate.push(data);
        return { id: `msg-${calls.messageCreate.length}`, ...data };
      },
    },
    $queryRaw: async () => [{ providerApiKey: "sk-user-secret-123456" }],
  };
  let started = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseAllStarted: () => void = () => undefined;
  const allStarted = new Promise<void>((resolve) => {
    releaseAllStarted = resolve;
  });
  const openaiCompatible = {
    getBaseConfig: async () => ({ hasApiKey: false, baseUrl: "https://yunwu.ai" }),
    createImageTask: async () => {
      const callIndex = started;
      started += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (started === batchItems.length) {
        releaseAllStarted();
      }
      await allStarted;
      inFlight -= 1;

      if (callIndex === 1) {
        throw new OpenAICompatibleRequestError("too many requests", {
          mode: "live",
          endpointPath: "/v1/images/generations",
          stage: "response_status",
          statusCode: 429,
          errorMessage: "too many requests",
        });
      }

      return {
        url: `data:image/png;base64,${Buffer.from(`batch-${callIndex}`).toString("base64")}`,
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        responseSummary: { mode: "live", callIndex },
        mocked: false,
      };
    },
  };
  const service = new TaskExecutionService(
    prisma as never,
    asImageProvider(openaiCompatible) as never,
    createCredentialsMock(prisma) as never,
    { persistTestFinished: async () => undefined, getState: async () => null } as never,
    { refreshAlerts: async <T>(value: T) => value } as never,
    {
      publishTaskUpdated: (payload: Record<string, unknown>) => {
        calls.published.push(payload);
      },
    } as never,
    {
      record: async (payload: Record<string, unknown>) => {
        calls.taskEvents.push(payload);
      },
    } as never,
    createAssetStorageMock({ store: calls.storage }) as never,
    { maybeSchedule: async () => ({ scheduled: false }) } as never,
  );

  await service.execute(task.id);

  assert.equal(started, 3);
  assert.equal(maxInFlight, 3);
  assert.equal(calls.assetCreate.length, 2);
  assert.deepEqual(
    batchItems.map((item) => item.status),
    ["succeeded", "failed", "succeeded"],
  );
  assert.deepEqual(
    batchItems.map((item) => item.assetId),
    ["asset-1", null, "asset-2"],
  );

  const finalUpdate = calls.taskUpdates
    .slice()
    .reverse()
    .find((update: Record<string, unknown>) => update.status === "succeeded");
  const output = finalUpdate?.output as Record<string, unknown>;
  assert.equal(finalUpdate?.progress, 100);
  assert.equal(output.batchSize, 3);
  assert.equal(output.returnedCount, 3);
  assert.equal(output.successCount, 2);
  assert.equal(output.failedCount, 1);
  assert.equal(output.partialSuccess, true);
  assert.deepEqual(output.assetIds, ["asset-1", "asset-2"]);
  assert.equal(
    output.firstFailureMessage,
    "The image provider is rate limited. Please retry later.",
  );
  assert.equal(calls.messageCreate.at(-1)?.content, "Batch image task completed.");
  assert.equal(calls.published.at(-1)?.status, "succeeded");
});

test("TaskExecutionService marks batch slots failed when shared batch setup fails", async () => {
  const calls = {
    messageCreate: [] as Array<Record<string, unknown>>,
    taskUpdates: [] as Array<Record<string, unknown>>,
    taskEvents: [] as Array<Record<string, unknown>>,
    published: [] as Array<Record<string, unknown>>,
  };
  const batchItems = [0, 1].map((batchIndex) => ({
    id: `batch-setup-item-${batchIndex}`,
    taskId: "task-batch-setup-failure",
    batchIndex,
    status: "queued",
    progress: 0,
    assetId: null as string | null,
    errorMessage: null as string | null,
    attempt: 0,
    providerSummary: null as Record<string, unknown> | null,
    output: null as Record<string, unknown> | null,
    startedAt: null as Date | null,
    completedAt: null as Date | null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const task = {
    id: "task-batch-setup-failure",
    userId: "user-1",
    conversationId: "conv-1",
    type: "image.generate",
    status: "queued",
    progress: 0,
    input: {
      providerRouteId: "yunwu",
      model: "gpt-image-2",
      prompt: "Draw two setup failure variations",
      assetIds: [],
      params: { size: "1024x1024" },
      batchCount: 2,
    },
    output: null as Record<string, unknown> | null,
    errorMessage: null as string | null,
    conversation: { id: "conv-1" },
    assets: [] as Array<Record<string, unknown>>,
    batchItems,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const cloneTask = () => ({
    ...task,
    batchItems: batchItems.map((item) => ({ ...item })),
  });
  const prisma = {
    task: {
      findUnique: async () => cloneTask(),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskUpdates.push(data);
        Object.assign(task, data);
        return cloneTask();
      },
    },
    taskBatchItem: {
      findMany: async () => batchItems.map((item) => ({ ...item })),
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id?: { in?: string[] };
          status?: { in?: string[] };
        };
        data: Record<string, unknown>;
      }) => {
        const ids = new Set(where.id?.in ?? []);
        const statuses = new Set(where.status?.in ?? []);
        let count = 0;

        for (const item of batchItems) {
          if (ids.size > 0 && !ids.has(item.id)) {
            continue;
          }
          if (statuses.size > 0 && !statuses.has(item.status)) {
            continue;
          }

          count += 1;
          Object.assign(item, {
            ...data,
            attempt:
              typeof (data.attempt as { increment?: number } | undefined)
                ?.increment === "number"
                ? item.attempt + (data.attempt as { increment: number }).increment
                : item.attempt,
          });
        }

        return { count };
      },
    },
    asset: {
      findMany: async () => [],
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.messageCreate.push(data);
        return { id: `msg-${calls.messageCreate.length}`, ...data };
      },
    },
    $queryRaw: async () => [{ providerApiKey: "sk-user-secret-123456" }],
  };
  let createImageCalls = 0;
  const openaiCompatible = {
    getBaseConfig: async () => {
      throw new Error("Provider setup exploded.");
    },
    createImageTask: async () => {
      createImageCalls += 1;
      throw new Error("Should not create slot requests.");
    },
  };
  const service = new TaskExecutionService(
    prisma as never,
    asImageProvider(openaiCompatible) as never,
    createCredentialsMock(prisma) as never,
    { persistTestFinished: async () => undefined, getState: async () => null } as never,
    { refreshAlerts: async <T>(value: T) => value } as never,
    {
      publishTaskUpdated: (payload: Record<string, unknown>) => {
        calls.published.push(payload);
      },
    } as never,
    {
      record: async (payload: Record<string, unknown>) => {
        calls.taskEvents.push(payload);
      },
    } as never,
    createAssetStorageMock() as never,
    { maybeSchedule: async () => ({ scheduled: false }) } as never,
  );

  await service.execute(task.id);

  assert.equal(createImageCalls, 0);
  assert.deepEqual(
    batchItems.map((item) => item.status),
    ["failed", "failed"],
  );
  assert.deepEqual(
    batchItems.map((item) => item.errorMessage),
    ["Provider setup exploded.", "Provider setup exploded."],
  );

  const finalUpdate = calls.taskUpdates.at(-1);
  const output = finalUpdate?.output as Record<string, unknown>;
  assert.equal(finalUpdate?.status, "failed");
  assert.equal(finalUpdate?.errorMessage, "Provider setup exploded.");
  assert.equal(output.batchSize, 2);
  assert.equal(output.returnedCount, 2);
  assert.equal(output.successCount, 0);
  assert.equal(output.failedCount, 2);
  assert.equal(output.firstFailureMessage, "Provider setup exploded.");
  assert.equal(calls.messageCreate.at(-1)?.content, "Provider setup exploded.");
  assert.equal(calls.published.at(-1)?.status, "failed");
});

test("TaskExecutionService classifies provider status and payload failures", async () => {
  const cases = [
    {
      name: "connection timeout",
      error: new OpenAICompatibleRequestError("fetch failed", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "request",
        errorKind: "connect_timeout",
        fetchErrorName: "TypeError",
        fetchCauseCode: "UND_ERR_CONNECT_TIMEOUT",
      }),
      category: "provider_unreachable",
      retryable: true,
      title: "Provider unreachable",
      message:
        "The connection to the image provider timed out. Check the provider base URL and network environment, then retry.",
    },
    {
      name: "request timeout",
      error: new OpenAICompatibleRequestError("request timed out", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "request",
        errorKind: "timeout",
      }),
      category: "provider_timeout",
      retryable: true,
      title: "Provider request timed out",
      message:
        "The image provider timed out before returning a response. Please retry later.",
    },
    {
      name: "auth",
      error: new OpenAICompatibleRequestError("invalid token", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "response_status",
        statusCode: 401,
        errorMessage: "invalid token",
      }),
      category: "provider_auth",
      retryable: false,
    },
    {
      name: "rate limit",
      error: new OpenAICompatibleRequestError("too many requests", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "response_status",
        statusCode: 429,
        errorMessage: "too many requests",
      }),
      category: "provider_rate_limited",
      retryable: true,
    },
    {
      name: "server error",
      error: new OpenAICompatibleRequestError("bad gateway", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "response_status",
        statusCode: 502,
        bodyPreview: "bad gateway",
        responseParseError: true,
      }),
      category: "provider_server_error",
      retryable: true,
    },
    {
      name: "invalid request",
      error: new OpenAICompatibleRequestError("bad size", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "response_status",
        statusCode: 400,
        errorMessage: "bad size",
      }),
      category: "provider_invalid_request",
      retryable: false,
    },
    {
      name: "bad response",
      error: new OpenAICompatibleRequestError("not json", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "response_parse",
        statusCode: 200,
        bodyPreview: "not json",
      }),
      category: "provider_bad_response",
      retryable: true,
    },
    {
      name: "image missing",
      error: new OpenAICompatibleRequestError("missing image", {
        mode: "live",
        endpointPath: "/v1/images/generations",
        stage: "response_unparseable",
        statusCode: 200,
        shapeHints: { topLevelKeys: ["choices"] },
      }),
      category: "provider_image_missing",
      retryable: true,
    },
  ];

  for (const testCase of cases) {
    const service = new TaskExecutionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    { maybeSchedule: async () => ({ scheduled: false }) } as never,
  );
    const failure = service["buildFailureSummary"](testCase.error);

    assert.equal(failure.category, testCase.category, testCase.name);
    assert.equal(failure.retryable, testCase.retryable, testCase.name);
    if ("title" in testCase) {
      assert.equal(failure.title, testCase.title, testCase.name);
    }
    if ("message" in testCase) {
      assert.equal(failure.errorMessage, testCase.message, testCase.name);
    }
  }
});
