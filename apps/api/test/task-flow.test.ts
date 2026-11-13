import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ApiService } from "../src/api/api.service";
import { ProviderConfigurationService } from "../src/openai-compatible/provider-configuration.service";
import {
  DEFAULT_YUNWU_MODEL_IDS,
  YUNWU_MODEL_DEFINITIONS,
  getYunwuModelDefinition,
} from "../src/openai-compatible/yunwu-model-registry";
import {
  getProviderRoute,
  PROVIDER_ROUTES,
} from "../src/openai-compatible/provider-route-registry";
import { OPENLUX_PROVIDER_MODEL_IDS } from "../src/openai-compatible/openlux.model-registry";

const NOW = new Date("2026-04-24T08:00:00.000Z");

function buildUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "user@example.com",
    displayName: "User One",
    role: "member",
    ...overrides,
  };
}

function buildConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    userId: "user-1",
    title: "Conversation",
    status: "active",
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    userId: "user-1",
    messageId: null,
    taskId: null,
    type: "upload",
    mimeType: "image/png",
    url: "https://example.com/asset.png",
    storageKey: "asset.png",
    status: "ready",
    metadata: { width: 512, height: 512 },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildTaskEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    taskId: "task-1",
    eventType: "failed",
    status: "failed",
    summary: "Task failed.",
    details: {},
    createdAt: NOW,
    ...overrides,
  };
}

function buildBatchItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "batch-item-1",
    taskId: "task-1",
    batchIndex: 0,
    status: "queued",
    progress: 0,
    assetId: null,
    errorMessage: null,
    attempt: 0,
    providerSummary: null,
    output: null,
    startedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    userId: "user-1",
    conversationId: "conv-1",
    sourceTaskId: null,
    sourceAction: null,
    type: "image.generate",
    status: "queued",
    progress: 0,
    input: {
      model: "gpt-image-1",
      prompt: "Draw a lantern by the lake",
      assetIds: [],
      params: { size: "1024x1024" },
    },
    output: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    conversation: null,
    user: buildUser(),
    assets: [],
    events: [],
    batchItems: [],
    ...overrides,
  };
}

function buildModelCapability(overrides: Record<string, unknown> = {}) {
  return {
    id: "cap-1",
    provider: "openai-compatible",
    model: "gpt-image-2",
    modality: "image",
    capabilities: ["image.generate", "image.edit"],
    enabled: true,
    metadata: {
      name: "GPT Image 2",
      type: "image-editing",
      taskSupported: true,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createHarness(
  overrides: Record<string, Record<string, (...args: any[]) => any>> = {},
) {
  const calls = {
    conversationCreate: [] as Array<Record<string, unknown>>,
    taskCreate: [] as Array<Record<string, unknown>>,
    messageCreate: [] as Array<Record<string, unknown>>,
    taskEventCreate: [] as Array<Record<string, unknown>>,
    taskEventCreateMany: [] as Array<Record<string, unknown>>,
    taskBatchItemCreateMany: [] as Array<Record<string, unknown>>,
    taskBatchItemUpdateMany: [] as Array<Record<string, unknown>>,
    assetUpdate: [] as Array<Record<string, unknown>>,
    assetFindMany: [] as Array<Record<string, unknown>>,
    taskFindMany: [] as Array<Record<string, unknown>>,
    providerKeyWrites: [] as Array<{ routeId: string; apiKey: string | null }>,
    enqueued: [] as Array<{ taskId: string; source?: string }>,
    batchEnqueued: [] as Array<{
      taskId: string;
      source?: string;
      options?: Record<string, unknown>;
    }>,
    published: [] as Array<Record<string, unknown>>,
    modelCapabilityUpsert: [] as Array<Record<string, unknown>>,
    userSettingsPersist: [] as Array<unknown>,
  };

  const prisma: any = {
    modelCapability: {
      findMany: async () => [
        buildModelCapability(),
        buildModelCapability({
          id: "cap-legacy",
          model: "gpt-image-1",
          metadata: {
            name: "GPT Image 1",
            type: "image-editing",
            taskSupported: true,
          },
        }),
      ],
      findFirst: async () => buildModelCapability(),
      upsert: async (args: Record<string, unknown>) => {
        calls.modelCapabilityUpsert.push(args);
        return args;
      },
    },
    conversation: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.conversationCreate.push(data);
        return buildConversation({
          id: `conv-${calls.conversationCreate.length}`,
          title: data.title,
          userId: data.userId,
          metadata: data.metadata ?? null,
        });
      },
    },
    task: {
      findFirst: async () => null,
      findMany: async (args: Record<string, unknown>) => {
        calls.taskFindMany.push(args);
        return [];
      },
      findUnique: async () => null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
        buildTask({ id: where.id }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        return buildTask({
          id: `task-${calls.taskCreate.length}`,
          ...data,
          conversation: null,
          user: buildUser(),
          assets: [],
          events: [],
        });
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        buildTask({ id: where.id, ...data }),
    },
    asset: {
      findMany: async (args: Record<string, unknown>) => {
        calls.assetFindMany.push(args);
        return [];
      },
      findFirst: async () => null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.assetUpdate.push({ where, data });
        return buildAsset({ id: where.id, ...data });
      },
      updateMany: async () => ({ count: 0 }),
    },
    message: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.messageCreate.push(data);
        return { id: `msg-${calls.messageCreate.length}`, ...data };
      },
    },
    taskEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskEventCreate.push(data);
        return buildTaskEvent({ ...data, details: data.details ?? {} });
      },
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        calls.taskEventCreateMany.push({ data });
        return { count: data.length };
      },
      findMany: async () => [],
    },
    taskBatchItem: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        calls.taskBatchItemCreateMany.push({ data });
        return { count: data.length };
      },
      findMany: async () => [],
      updateMany: async (args: Record<string, unknown>) => {
        calls.taskBatchItemUpdateMany.push(args);
        return { count: 0 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        buildBatchItem({ id: where.id, ...data }),
    },
  };

  // 支持两种形态：回调式，以及批量数组式（ensureDefaultModels 用后者）。
  prisma.$transaction = async (
    input: ((tx: typeof prisma) => Promise<unknown>) | Array<Promise<unknown>>,
  ) => (Array.isArray(input) ? Promise.all(input) : input(prisma));
  prisma.$queryRaw = async () => [];
  prisma.$executeRaw = async (query: unknown) => {
    calls.userSettingsPersist.push(query);
    return 1;
  };

  for (const [section, methods] of Object.entries(overrides)) {
    if (section === "raw") {
      Object.assign(prisma, methods);
    } else {
      Object.assign(prisma[section], methods);
    }
  }

  const taskQueue = {
    enqueueTask: async (taskId: string, source?: string) => {
      calls.enqueued.push({ taskId, source });
    },
    cancelTask: (taskId: string) => {
      (calls as Record<string, unknown[]>).cancelled ??= [];
      (calls as Record<string, unknown[]>).cancelled.push(taskId);
    },
    resumeTask: async (taskId: string) => {
      (calls as Record<string, unknown[]>).resumed ??= [];
      (calls as Record<string, unknown[]>).resumed.push(taskId);
    },
    enqueueBatchTask: async (
      taskId: string,
      source?: string,
      options?: Record<string, unknown>,
    ) => {
      calls.batchEnqueued.push({ taskId, source, options });
    },
  };
  const conversationEvents = {
    publishTaskUpdated: (payload: Record<string, unknown>) => {
      calls.published.push(payload);
    },
  };
  const taskEvents = {
    listForConversation: async () => [],
    listForTask: async () => [],
  };
  const openaiCompatible = {
    providerType: "openai-compatible" as const,
    providerId: "openai-compatible",
    baseUrlConfigurable: false,
    modelDefinitions: getProviderRoute("yunwu").modelDefinitions,
    defaultModelIds: getProviderRoute("yunwu").defaultModelIds,
    getModelDefinition: (modelId: string) =>
      getProviderRoute("yunwu").modelDefinitions.find(
        (model) => model.id === modelId,
      ),
    getProviderProfile: () => ({ mode: "mock", baseUrl: "https://yunwu.ai" }),
    getBaseConfig: () => ({ hasApiKey: false, baseUrl: "https://yunwu.ai" }),
    checkProviderModels: async () => ({ remoteModelIds: [] }),
    createImageTask: async () => {
      throw new Error("not used");
    },
  };
  const providerState = {
    getState: async () => null,
    persistCheck: async () => null,
    persistTestQueued: async () => undefined,
    persistTestFinished: async () => undefined,
  };
  const providerAlerts = {
    refreshAlerts: async <T>(value: T) => value,
    acknowledgeAlert: async () => null,
  };
  const providerConfig = {
    updateBaseUrl: async () => ({ baseUrl: "https://yunwu.ai" }),
    getBaseUrl: async () => "https://yunwu.ai",
  };

  const routeSecrets = new Map<string, string | undefined>();
  const readLegacySecret = async () => {
    const rows = (await (prisma as { $queryRaw?: (q: unknown) => Promise<unknown> })
      .$queryRaw?.({ values: [] })) as
      | Array<{ providerApiKey?: string | null }>
      | undefined;
    return rows?.[0]?.providerApiKey?.trim() || undefined;
  };
  const providerCredentials = {
    assertRoute: (routeId: string) => {
      // 与线上 ProviderRouteId 保持一致，避免新增线路时测试漏改。
      if (!PROVIDER_ROUTES.some((route) => route.id === routeId)) {
        throw new BadRequestException("Unsupported provider route.");
      }
      return routeId;
    },
    getSecretForExecution: async (_userId: string, routeId: string) =>
      routeSecrets.has(routeId) ? routeSecrets.get(routeId) : readLegacySecret(),
    getStatus: async (_userId: string, routeId: string) => {
      const secret = routeSecrets.has(routeId)
        ? routeSecrets.get(routeId)
        : await readLegacySecret();
      return {
        providerRouteId: routeId,
        configured: Boolean(secret),
        ...(secret ? { maskedApiKey: `${secret.slice(0, 4)}...${secret.slice(-4)}` } : {}),
      };
    },
    setSecret: async (_userId: string, routeId: string, apiKey: string) => {
      providerCredentials.assertRoute(routeId);
      routeSecrets.set(routeId, apiKey);
      calls.providerKeyWrites.push({ routeId, apiKey });
      return { providerRouteId: routeId, configured: true };
    },
    clearSecret: async (_userId: string, routeId: string) => {
      providerCredentials.assertRoute(routeId);
      routeSecrets.set(routeId, undefined);
      calls.providerKeyWrites.push({ routeId, apiKey: null });
      return { providerRouteId: routeId, configured: false };
    },
  };

  const service = new ApiService(
    prisma,
    taskQueue as any,
    taskEvents as any,
    conversationEvents as any,
    openaiCompatible as any,
    providerCredentials as any,
    providerConfig as any,
    providerState as any,
    providerAlerts as any,
    { maybeSchedule: async () => ({ scheduled: false }) } as any,
  );

  return { service, calls };
}

test("onModuleInit registers每条线路各自的模型，默认启用项互不串线", async () => {
  const { service, calls } = createHarness();

  await service.onModuleInit();

  const creates = calls.modelCapabilityUpsert.map(
    (call) => call.create as Record<string, any>,
  );
  const enabledFor = (provider: string) =>
    creates
      .filter((create) => create.provider === provider && create.enabled)
      .map((create) => create.model)
      .sort();

  // Yunwu / AnyAIGC 共用 openai-compatible 上游，APIXO 是独立的异步任务上游。
  assert.deepEqual(
    enabledFor("openai-compatible"),
    [...DEFAULT_YUNWU_MODEL_IDS].sort(),
  );
  assert.deepEqual(
    enabledFor("apixo"),
    [...getProviderRoute("apixo").defaultModelIds].sort(),
  );
  // 同一模型 id 在多条线路下各自登记一行，互不覆盖。
  const gptImage2Providers = creates
    .filter((create) => create.model === "gpt-image-2")
    .map((create) => create.provider);
  assert.equal(new Set(gptImage2Providers).size, gptImage2Providers.length);
  assert.ok(gptImage2Providers.includes("openlux"));
  assert.ok(
    creates.some(
      (create) =>
        create.provider === "openai-compatible" &&
        create.model === "flux-schnell" &&
        create.enabled === false,
    ),
  );
});

test("Yunwu model registry includes all GPT, Gemini, and Grok image models", () => {
  const requiredModelIds = [
    "gpt-image-2",
    "gpt-image-1.5",
    "gpt-image-1.5-all",
    "gpt-image-2-all",
    "gpt-image-1",
    "gpt-image-1-all",
    "gpt-image-1-mini",
    "gpt-4o-image-vip",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
    "gemini-2.5-flash-image",
    "gemini-2.5-flash-image-preview",
    "grok-imagine-image",
    "grok-imagine-image-pro",
    "grok-4.2-image",
    "grok-4.1-image",
    "grok-4-image",
    "grok-3-image",
  ];

  assert.deepEqual(DEFAULT_YUNWU_MODEL_IDS, [
    "gpt-image-2",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
    "grok-4.2-image",
    "grok-imagine-image",
    "grok-imagine-image-pro",
  ]);
  assert.ok(
    requiredModelIds.every((modelId) =>
      YUNWU_MODEL_DEFINITIONS.some((model) => model.id === modelId),
    ),
  );
  assert.equal(
    YUNWU_MODEL_DEFINITIONS.filter((model) => model.defaultEnabled).length,
    DEFAULT_YUNWU_MODEL_IDS.length,
  );
  assert.equal(
    getYunwuModelDefinition("gpt-image-2")?.capabilities.includes("image.edit"),
    true,
  );
  assert.equal(
    getYunwuModelDefinition("grok-3-image")?.capabilities.includes("image.edit"),
    true,
  );
  assert.equal(
    getYunwuModelDefinition("grok-4.2-image")?.capabilities.includes("image.edit"),
    true,
  );
  assert.equal(
    getYunwuModelDefinition("gemini-3-pro-image-preview")?.capabilities.includes("image.edit"),
    true,
  );
  assert.equal(
    getYunwuModelDefinition("gemini-2.5-flash-image")?.capabilities.includes("image.edit"),
    true,
  );
  assert.equal(
    getYunwuModelDefinition("gpt-4o-image-vip")?.capabilities.includes("image.edit"),
    false,
  );
});

test("OpenLux 线路有独立模型清单，且不与 OpenAI 兼容线路共用能力行", () => {
  const route = getProviderRoute("openlux");
  const openaiCompatibleRoute = getProviderRoute("anyaigc");

  assert.equal(route.providerType, "openai-compatible");
  assert.equal(route.baseUrl, "https://api.openlux.ai/v1");
  // 独立 providerId：否则三条 OpenAI 兼容线路的模型能力会互相覆盖。
  assert.notEqual(route.providerId, openaiCompatibleRoute.providerId);
  assert.equal(route.providerId, "openlux");

  // 模型清单与 Yunwu 线路不同。
  const yunwuIds = new Set(openaiCompatibleRoute.modelDefinitions.map((m) => m.id));
  assert.ok(route.modelDefinitions.some((m) => !yunwuIds.has(m.id)));

  // 默认启用项必须全部来自该线路自己的清单。
  for (const id of route.defaultModelIds) {
    assert.ok(
      route.modelDefinitions.some((m) => m.id === id),
      `${id} 应在 OpenLux 模型清单中`,
    );
  }
  // OpenAI Images 兼容模型必须可提交任务。
  for (const model of route.modelDefinitions) {
    assert.equal(model.family, "openai-images");
    assert.equal(model.taskSupported, true);
  }
  assert.deepEqual(
    getProviderRoute("openlux").modelDefinitions.find((m) => m.id === "dall-e-3")?.capabilities,
    ["image.generate"]
  );
});

test("切到 OpenLux 线路只保留该线路认识的模型", async () => {
  let stored: Record<string, unknown> = {
    activeProviderRouteId: "yunwu",
    baseUrl: getProviderRoute("yunwu").baseUrl,
    providerApiKey: null,
    enabledModelIds: ["gpt-image-2"],
    enabledModelIdsByRoute: { yunwu: ["gpt-image-2"] },
    ui: {}
  };
  const { service } = createHarness({
    raw: {
      $queryRaw: async () => [stored],
      $executeRaw: async (query: { values?: unknown[] }) => {
        const values = query.values ?? [];
        stored = {
          ...stored,
          baseUrl: values[2],
          activeProviderRouteId: values[3],
          enabledModelIds: JSON.parse(String(values[5])),
          enabledModelIdsByRoute: JSON.parse(String(values[6]))
        };
        return 1;
      }
    }
  });

  const yunwuOnlyId = getProviderRoute("yunwu")
    .modelDefinitions.map((m) => m.id)
    .find((id) => !getProviderRoute("openlux").modelDefinitions.some((m) => m.id === id))!;

  const switched = await service.updateSettings(buildUser() as any, {
    activeProviderRouteId: "openlux",
    baseUrl: getProviderRoute("openlux").baseUrl,
    enabledModelIds: [yunwuOnlyId]
  });

  assert.equal(switched.settings.activeProviderRouteId, "openlux");
  // Yunwu 独有的模型在 OpenLux 线路上被丢掉，而不是让请求失败。
  assert.ok(!switched.settings.enabledModelIds.includes(yunwuOnlyId));
  assert.ok(switched.settings.enabledModelIds.length > 0);
});

test("getSettings returns user defaults from global base URL", async () => {
  const { service } = createHarness();

  const response = await service.getSettings(buildUser() as any);

  assert.equal(response.settings.activeProviderRouteId, "apixo");
  assert.equal(response.settings.baseUrl, getProviderRoute("apixo").baseUrl);
  assert.deepEqual(
    response.settings.enabledModelIds.sort(),
    [...getProviderRoute("apixo").defaultModelIds].sort(),
  );
  assert.deepEqual(response.settings.ui, {});
});

test("getSettings masks provider API key and updateSettings can set and clear it", async () => {
  let storedApiKey = "sk-test-secret-123456";
  const { service } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://yunwu.ai",
          providerApiKey: storedApiKey,
          enabledModelIds: ["gpt-image-2"],
          ui: {},
        },
      ],
      $executeRaw: async (query: { values?: unknown[] }) => {
        storedApiKey = String(query.values?.[3] ?? "");
        return 1;
      },
    },
  });

  const response = await service.getSettings(buildUser() as any);

  assert.equal(response.settings.providerApiKey.configured, true);
  assert.notEqual(response.settings.providerApiKey.maskedApiKey, storedApiKey);
  assert.match(response.settings.providerApiKey.maskedApiKey ?? "", /\.\.\./);

  const updated = await service.updateSettings(buildUser() as any, {
    apiKey: "sk-new-secret-abcdef",
  });
  assert.equal(updated.settings.providerApiKey.configured, true);

  const cleared = await service.updateSettings(buildUser() as any, {
    clearApiKey: true,
  });
  assert.equal(cleared.settings.providerApiKey.configured, false);
});

test("checkUserApiKey uses the provided key and masks the response", async () => {
  let captured: Record<string, unknown> | undefined;
  const { service, calls } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://api3.wlai.vip",
          providerApiKey: null,
          enabledModelIds: ["gpt-image-2"],
          ui: {},
        },
      ],
    },
  });
  (service as any).imageProvider = {
    checkProviderModels: async (
      routeId: string,
      input: Record<string, unknown>,
    ) => {
      captured = { routeId, ...input };
      return {
        baseUrlReachable: true,
        modelsSource: "configured",
      };
    },
  };

  const response = await service.checkUserApiKey(buildUser() as any, {
    apiKey: "sk-check-secret-123456",
  });

  assert.equal(captured?.routeId, "yunwu");
  assert.equal(captured?.apiKey, "sk-check-secret-123456");
  assert.equal(calls.userSettingsPersist.length, 0);
  assert.equal(response.ok, true);
  assert.equal(response.status, "ok");
  assert.equal(response.message, "API key connectivity check succeeded.");
  assert.equal(response.apiKey.configured, true);
  assert.notEqual(response.apiKey.maskedApiKey, "sk-check-secret-123456");
  assert.equal(response.check.baseUrlReachable, true);
});

test("checkUserApiKey uses the saved key when no temporary key is provided", async () => {
  let captured: Record<string, unknown> | undefined;
  const { service, calls } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://yunwu.ai",
          providerApiKey: "sk-saved-secret-abcdef",
          enabledModelIds: ["gpt-image-2"],
          ui: {},
        },
      ],
    },
  });
  (service as any).imageProvider = {
    checkProviderModels: async (
      routeId: string,
      input: Record<string, unknown>,
    ) => {
      captured = { routeId, ...input };
      return {
        baseUrlReachable: true,
        modelsSource: "remote",
        remoteModelIds: ["gpt-image-2"],
      };
    },
  };

  const response = await service.checkUserApiKey(buildUser() as any, {});

  assert.equal(captured?.routeId, "yunwu");
  assert.equal(captured?.apiKey, "sk-saved-secret-abcdef");
  assert.equal(calls.userSettingsPersist.length, 0);
  assert.equal(response.ok, true);
  assert.equal(response.apiKey.configured, true);
  assert.notEqual(response.apiKey.maskedApiKey, "sk-saved-secret-abcdef");
  assert.equal(response.check.modelsSource, "remote");
  assert.equal(response.check.availableModelCount, 1);
});

test("checkUserApiKey returns an explicit failure when no key is available", async () => {
  let checkCalled = false;
  const { service } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://api3.wlai.vip",
          providerApiKey: null,
          enabledModelIds: ["gpt-image-2"],
          ui: {},
        },
      ],
    },
  });
  (service as any).imageProvider = {
    checkProviderModels: async () => {
      checkCalled = true;
      throw new Error("should not probe without a user API key");
    },
  };

  const response = await service.checkUserApiKey(buildUser() as any, {});

  assert.equal(checkCalled, false);
  assert.equal(response.ok, false);
  assert.equal(response.status, "error");
  assert.equal(response.apiKey.configured, false);
  assert.equal(response.apiKey.maskedApiKey, undefined);
  assert.equal(response.check.baseUrlReachable, false);
  assert.equal(response.check.modelsSource, "unavailable");
  assert.equal(response.check.error?.category, "missing_api_key");
  assert.match(response.message, /No API key is configured/);
});

test("checkUserApiKey does not leak invalid keys in failed check responses", async () => {
  const rawKey = "sk-invalid-secret-1234567890";
  const { service } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://yunwu.ai",
          providerApiKey: null,
          enabledModelIds: ["gpt-image-2"],
          ui: {},
        },
      ],
    },
  });
  (service as any).imageProvider = {
    checkProviderModels: async () => ({
      baseUrlReachable: true,
      modelsSource: "unavailable",
      error: {
        category: "provider_auth",
        message: "Provider rejected [redacted-api-key].",
        retryable: false,
        statusCode: 401,
      },
    }),
  };

  const response = await service.checkUserApiKey(buildUser() as any, {
    apiKey: rawKey,
  });
  const serialized = JSON.stringify(response);

  assert.equal(response.ok, false);
  assert.equal(response.status, "error");
  assert.equal(response.check.error?.statusCode, 401);
  assert.doesNotMatch(serialized, new RegExp(rawKey));
  assert.match(response.apiKey.maskedApiKey ?? "", /^.{4}\.\.\..{4}$/);
});

test("updateSettings persists user baseUrl, enabled models, and ui payload", async () => {
  let persistedValues: unknown[] = [];
  const { service } = createHarness({
    raw: {
      $executeRaw: async (query: { values?: unknown[] }) => {
        persistedValues = query.values ?? [];
        return 1;
      },
    },
  });

  const response = await service.updateSettings(buildUser() as any, {
    baseUrl: "https://api3.wlai.vip/",
    enabledModelIds: ["gpt-image-1"],
    ui: { density: "compact" },
  });

  assert.equal(response.settings.activeProviderRouteId, "yunwu");
  assert.equal(response.settings.baseUrl, getProviderRoute("yunwu").baseUrl);
  assert.ok(response.settings.enabledModelIds.includes("gpt-image-1"));
  assert.ok(response.settings.enabledModelIds.includes("gpt-image-2"));
  assert.deepEqual(response.settings.ui, { density: "compact" });
  assert.ok(persistedValues.includes(getProviderRoute("yunwu").baseUrl));
  assert.ok(persistedValues.includes("yunwu"));
});

test("每条线路的 API key 相互独立，切换线路不会带走上一条的密钥", async () => {
  let storedRoute = "apixo";
  const { service, calls } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          activeProviderRouteId: storedRoute,
          baseUrl: getProviderRoute(storedRoute as "apixo").baseUrl,
          providerApiKey: null,
          enabledModelIds: [],
          enabledModelIdsByRoute: null,
          ui: {},
        },
      ],
      $executeRaw: async (query: { values?: unknown[] }) => {
        storedRoute = String(query.values?.[3] ?? storedRoute);
        return 1;
      },
    },
  });

  // 在 APIXO 线路上存一把 key。
  const apixoStatus = await service.updateProviderRouteApiKey(
    buildUser() as any,
    "apixo",
    "sk-apixo-secret-0001",
  );
  assert.equal(apixoStatus.configured, true);

  // 切到 Yunwu 线路：该线路仍然是未配置状态。
  const switched = await service.updateSettings(buildUser() as any, {
    activeProviderRouteId: "yunwu",
  });
  assert.equal(switched.settings.activeProviderRouteId, "yunwu");
  assert.equal(switched.settings.providerApiKey.configured, false);

  const routes = Object.fromEntries(
    switched.settings.providerRoutes.map((route) => [
      route.id,
      route.credential.configured,
    ]),
  );
  assert.equal(routes.apixo, true);
  for (const route of PROVIDER_ROUTES.filter((entry) => entry.id !== "apixo")) {
    assert.equal(routes[route.id], false, `${route.id} 不应读到 APIXO 的密钥`);
  }

  // 清空 Yunwu 不会影响 APIXO 已保存的密钥。
  await service.clearProviderRouteApiKey(buildUser() as any, "yunwu");
  assert.deepEqual(
    calls.providerKeyWrites.map((write) => write.routeId),
    ["apixo", "yunwu"],
  );

  await assert.rejects(
    () =>
      service.updateProviderRouteApiKey(
        buildUser() as any,
        "not-a-route",
        "sk-x",
      ),
    (error: unknown) => error instanceof BadRequestException,
  );
});

test("切换线路时各线路的启用模型互不覆盖", async () => {
  // APIXO 与 Yunwu 的模型清单完全不同，切换后必须各自保留选择。
  let stored: Record<string, unknown> = {
    activeProviderRouteId: "apixo",
    baseUrl: getProviderRoute("apixo").baseUrl,
    providerApiKey: null,
    enabledModelIds: [],
    enabledModelIdsByRoute: null,
    ui: {},
  };
  const { service } = createHarness({
    raw: {
      $queryRaw: async () => [stored],
      $executeRaw: async (query: { values?: unknown[] }) => {
        const values = query.values ?? [];
        stored = {
          ...stored,
          baseUrl: values[2],
          activeProviderRouteId: values[3],
          enabledModelIds: JSON.parse(String(values[5])),
          enabledModelIdsByRoute: JSON.parse(String(values[6])),
        };
        return 1;
      },
    },
  });

  const apixoModel = getProviderRoute("apixo").modelDefinitions.find(
    (model) => !getProviderRoute("apixo").defaultModelIds.includes(model.id),
  )!.id;
  const onApixo = await service.updateSettings(buildUser() as any, {
    enabledModelIds: [apixoModel],
  });
  assert.ok(onApixo.settings.enabledModelIds.includes(apixoModel));

  const apixoModelIds = new Set(
    getProviderRoute("apixo").modelDefinitions.map((model) => model.id),
  );
  const yunwuOnlyModel = getProviderRoute("yunwu").modelDefinitions.find(
    (model) => !apixoModelIds.has(model.id),
  )!.id;
  const onYunwu = await service.updateSettings(buildUser() as any, {
    activeProviderRouteId: "yunwu",
    enabledModelIds: [yunwuOnlyModel],
  });
  assert.ok(onYunwu.settings.enabledModelIds.includes(yunwuOnlyModel));
  // Yunwu 线路不应出现 APIXO 独有的模型。
  assert.ok(!onYunwu.settings.enabledModelIds.includes(apixoModel));

  const backOnApixo = await service.updateSettings(buildUser() as any, {
    activeProviderRouteId: "apixo",
  });
  assert.ok(backOnApixo.settings.enabledModelIds.includes(apixoModel));
  assert.ok(!backOnApixo.settings.enabledModelIds.includes(yunwuOnlyModel));
});

test("切到 APIXO 线路时不因带上 Yunwu 模型列表而报错", async () => {
  // 复现：旧客户端切线路时会把当前线路的 enabledModelIds 一起 PATCH 过来。
  let stored: Record<string, unknown> = {
    activeProviderRouteId: "yunwu",
    baseUrl: getProviderRoute("yunwu").baseUrl,
    providerApiKey: null,
    enabledModelIds: ["gemini-3-pro-image-preview"],
    enabledModelIdsByRoute: { yunwu: ["gemini-3-pro-image-preview"] },
    ui: {},
  };
  const { service } = createHarness({
    raw: {
      $queryRaw: async () => [stored],
      $executeRaw: async (query: { values?: unknown[] }) => {
        const values = query.values ?? [];
        stored = {
          ...stored,
          baseUrl: values[2],
          activeProviderRouteId: values[3],
          enabledModelIds: JSON.parse(String(values[5])),
          enabledModelIdsByRoute: JSON.parse(String(values[6])),
        };
        return 1;
      },
    },
  });

  const switched = await service.updateSettings(buildUser() as any, {
    activeProviderRouteId: "apixo",
    baseUrl: getProviderRoute("apixo").baseUrl,
    enabledModelIds: ["gemini-3-pro-image-preview"],
  });

  assert.equal(switched.settings.activeProviderRouteId, "apixo");
  // APIXO 不认识的模型被丢掉，而不是整个请求失败。
  assert.ok(
    !switched.settings.enabledModelIds.includes("gemini-3-pro-image-preview"),
  );
  assert.ok(switched.settings.enabledModelIds.length > 0);

  // 同一线路内提交未知模型仍然报错。
  await assert.rejects(
    () =>
      service.updateSettings(buildUser() as any, {
        enabledModelIds: ["definitely-not-a-model"],
      }),
    (error: unknown) => error instanceof BadRequestException,
  );
});

test("updateSettings rejects unsupported baseUrl and unknown models", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () =>
      service.updateSettings(buildUser() as any, {
        baseUrl: "https://example.com",
      }),
    (error: unknown) => {
      assert(error instanceof BadRequestException);
      assert.match((error as Error).message, /Unsupported provider base URL/);
      return true;
    },
  );

  await assert.rejects(
    () =>
      service.updateSettings(buildUser() as any, {
        enabledModelIds: ["unknown-model"],
      }),
    (error: unknown) => {
      assert(error instanceof BadRequestException);
      assert.match((error as Error).message, /Unknown model id for the/);
      return true;
    },
  );
});

test("getModels follows user enabledModelIds and marks unsupported families", async () => {
  const { service } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://api3.wlai.vip",
          enabledModelIds: [
            "gpt-image-2",
            "gpt-image-1",
            "black-forest-labs/flux-kontext-dev",
          ],
          ui: {},
        },
      ],
    },
    modelCapability: {
      findMany: async () => [
        buildModelCapability({
          id: "cap-default",
          model: "gpt-image-2",
          enabled: true,
          metadata: { name: "GPT Image 2", taskSupported: true },
        }),
        buildModelCapability({
          id: "cap-manual",
          model: "gpt-image-1",
          enabled: true,
          metadata: { name: "GPT Image 1", taskSupported: true },
        }),
        buildModelCapability({
          id: "cap-async",
          model: "black-forest-labs/flux-kontext-dev",
          enabled: true,
          metadata: {
            name: "Flux Kontext Dev",
            family: "replicate-prediction",
            taskSupported: false,
          },
        }),
      ],
    },
  });

  const response = await service.getModels(buildUser() as any);

  assert.deepEqual(
    response.models.map((model) => model.id).sort(),
    ["black-forest-labs/flux-kontext-dev", "gpt-image-1", "gpt-image-2"],
  );
  assert.equal(
    response.models.find((model) => model.id === "black-forest-labs/flux-kontext-dev")
      ?.taskSupported,
    false,
  );
  assert.equal(
    response.models.find((model) => model.id === "black-forest-labs/flux-kontext-dev")
      ?.status,
    "unsupported",
  );
});

test("createTask rejects enabled models whose Yunwu API family is not implemented", async () => {
  const user = buildUser();
  const { service } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://yunwu.ai",
          enabledModelIds: ["black-forest-labs/flux-kontext-dev"],
          ui: {},
        },
      ],
    },
    modelCapability: {
      findMany: async () => [
        buildModelCapability({
          model: "black-forest-labs/flux-kontext-dev",
          enabled: true,
          capabilities: ["image.generate"],
          metadata: {
            family: "replicate-prediction",
            taskSupported: false,
          },
        }),
      ],
      findFirst: async () =>
        buildModelCapability({
          model: "black-forest-labs/flux-kontext-dev",
          enabled: true,
          capabilities: ["image.generate"],
          metadata: {
            family: "replicate-prediction",
            taskSupported: false,
          },
        }),
    },
  });

  await assert.rejects(
    () =>
      service.createTask(user as any, {
        capability: "image.generate",
        model: "black-forest-labs/flux-kontext-dev",
        prompt: "Draw a mountain",
      }),
    (error: unknown) => {
      assert(error instanceof BadRequestException);
      assert.match((error as Error).message, /does not support its Yunwu API family/i);
      return true;
    },
  );
});

test("ProviderConfigurationService reads the default base URL and persists supported switches", async () => {
  let persisted: string | undefined;
  const prisma = {
    $queryRaw: async () =>
      persisted ? [{ baseUrl: persisted }] : [],
    $executeRaw: async (query: unknown) => {
      persisted = String((query as { values?: unknown[] }).values?.[1]);
      return 1;
    },
  };
  const config = {
    get: (key: string) =>
      key === "yunwu.baseUrl" ? "https://api3.wlai.vip/" : undefined,
  };
  const service = new ProviderConfigurationService(prisma as any, config as any);

  assert.equal(await service.getBaseUrl(), "https://api3.wlai.vip");
  await service.updateBaseUrl("https://yunwu.ai/");
  assert.equal(await service.getBaseUrl(), "https://yunwu.ai");

  await assert.rejects(
    () => service.updateBaseUrl("https://example.com"),
    (error: unknown) => {
      assert(error instanceof BadRequestException);
      assert.match((error as Error).message, /Unsupported Yunwu base_url/);
      return true;
    },
  );
});

test("createTask lazily creates a conversation and queues the task", async () => {
  const user = buildUser();
  const upload = buildAsset({ id: "upload-1", type: "upload" });
  const lazyConversation = buildConversation({ id: "conv-lazy", title: "Draw a lantern by the lake" });
  let createdTaskInput: Record<string, unknown> | undefined;

  const { service, calls } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://api3.wlai.vip",
          enabledModelIds: ["gpt-image-1"],
          ui: {},
        },
      ],
    },
    conversation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.conversationCreate.push(data);
        return buildConversation({
          ...lazyConversation,
          title: data.title,
          userId: data.userId,
          metadata: data.metadata ?? null,
        });
      },
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === lazyConversation.id
          ? {
              ...lazyConversation,
              messages: [],
              tasks: [
                buildTask({
                  id: "task-lazy",
                  conversationId: lazyConversation.id,
                  conversation: lazyConversation,
                  assets: [],
                  events: [],
                  input: createdTaskInput,
                }),
              ],
            }
          : null,
    },
    asset: {
      findMany: async () => [upload],
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        createdTaskInput = data.input as Record<string, unknown>;
        return buildTask({
          id: "task-lazy",
          ...data,
          conversation: lazyConversation,
          assets: [],
          events: [],
        });
      },
      findUniqueOrThrow: async () =>
        buildTask({
          id: "task-lazy",
          conversationId: lazyConversation.id,
          conversation: lazyConversation,
          assets: [],
          events: [],
          input: createdTaskInput,
        }),
    },
  });

  const response = await service.createTask(user as any, {
    capability: "image.generate",
    model: "gpt-image-1",
    prompt: "Draw a lantern by the lake",
    assetIds: [upload.id],
  });

  assert.equal(calls.conversationCreate.length, 1);
  assert.equal(calls.taskCreate[0]?.conversationId, lazyConversation.id);
  assert.deepEqual(
    (calls.taskCreate[0]?.input as Record<string, unknown>).assetIds,
    [upload.id],
  );
  assert.equal(
    (calls.taskCreate[0]?.input as Record<string, unknown>).providerRouteId,
    "yunwu",
  );
  assert.equal(response.conversation.id, lazyConversation.id);
  assert.equal(response.task.conversationId, lazyConversation.id);
  assert.deepEqual(response.task.assetIds, [upload.id]);
  assert.deepEqual(calls.enqueued, [{ taskId: "task-lazy", source: undefined }]);
});

test("createTask with batchCount creates batch items and queues a batch task", async () => {
  const user = buildUser();
  const conversation = buildConversation({
    id: "conv-batch",
    title: "Draw a lantern batch",
  });
  let createdTaskInput: Record<string, unknown> | undefined;
  const batchItems = Array.from({ length: 3 }, (_, index) =>
    buildBatchItem({
      id: `batch-item-${index + 1}`,
      taskId: "task-batch",
      batchIndex: index,
    }),
  );

  const { service, calls } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://api3.wlai.vip",
          enabledModelIds: ["gpt-image-1"],
          ui: {},
        },
      ],
    },
    conversation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.conversationCreate.push(data);
        return buildConversation({
          ...conversation,
          title: data.title,
          userId: data.userId,
          metadata: data.metadata ?? null,
        });
      },
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === conversation.id
          ? {
              ...conversation,
              messages: [],
              tasks: [
                buildTask({
                  id: "task-batch",
                  conversationId: conversation.id,
                  conversation,
                  input: createdTaskInput,
                  batchItems,
                }),
              ],
            }
          : null,
    },
    task: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        createdTaskInput = data.input as Record<string, unknown>;
        return buildTask({
          id: "task-batch",
          ...data,
          conversation,
          assets: [],
          events: [],
          batchItems: [],
        });
      },
      findUniqueOrThrow: async () =>
        buildTask({
          id: "task-batch",
          conversationId: conversation.id,
          conversation,
          assets: [],
          events: [],
          input: createdTaskInput,
          batchItems,
        }),
    },
  });

  const response = await service.createTask(user as any, {
    capability: "image.generate",
    model: "gpt-image-1",
    prompt: "Draw a lantern batch",
    batchCount: 3,
  });

  assert.equal(calls.taskBatchItemCreateMany.length, 1);
  assert.equal(
    (calls.taskBatchItemCreateMany[0]?.data as Record<string, unknown>[]).length,
    3,
  );
  assert.deepEqual(calls.batchEnqueued, [
    { taskId: "task-batch", source: undefined, options: undefined },
  ]);
  assert.equal(response.task.batch?.isBatch, true);
  assert.equal(response.task.batch?.batchSize, 3);
  assert.equal(response.task.batchItems?.length, 3);
});

test("createTask rejects batch source re-edit with multiple selected assets", async () => {
  const user = buildUser();
  const sourceAssets = [
    buildAsset({
      id: "batch-asset-1",
      type: "generated",
      taskId: "task-batch-source",
    }),
    buildAsset({
      id: "batch-asset-2",
      type: "generated",
      taskId: "task-batch-source",
    }),
  ];
  const sourceTask = buildTask({
    id: "task-batch-source",
    userId: user.id,
    status: "succeeded",
    assets: sourceAssets,
    input: { model: "gpt-image-2", prompt: "Batch source", batchCount: 2 },
    batchItems: sourceAssets.map((asset, index) =>
      buildBatchItem({
        id: `batch-item-${index + 1}`,
        taskId: "task-batch-source",
        batchIndex: index,
        status: "succeeded",
        assetId: asset.id,
      }),
    ),
  });

  const { service } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === sourceTask.id ? sourceTask : null,
    },
  });

  await assert.rejects(
    () =>
      service.createTask(user as any, {
        capability: "image.edit",
        model: "gpt-image-2",
        prompt: "Refine two batch outputs",
        sourceTaskId: sourceTask.id,
        sourceAction: "edit",
        assetIds: sourceAssets.map((asset) => asset.id),
      }),
    /Choose exactly one successful batch image/,
  );
});

test("createTask rejects batch source re-edit with an asset outside the source batch", async () => {
  const user = buildUser();
  const sourceAsset = buildAsset({
    id: "batch-asset-1",
    type: "generated",
    taskId: "task-batch-source",
  });
  const unrelatedAsset = buildAsset({
    id: "unrelated-generated-asset",
    type: "generated",
    taskId: "task-other",
  });
  const sourceTask = buildTask({
    id: "task-batch-source",
    userId: user.id,
    status: "succeeded",
    assets: [sourceAsset],
    input: { model: "gpt-image-2", prompt: "Batch source", batchCount: 2 },
    batchItems: [
      buildBatchItem({
        id: "batch-item-1",
        taskId: "task-batch-source",
        batchIndex: 0,
        status: "succeeded",
        assetId: sourceAsset.id,
      }),
      buildBatchItem({
        id: "batch-item-2",
        taskId: "task-batch-source",
        batchIndex: 1,
        status: "failed",
        errorMessage: "Provider failed.",
      }),
    ],
  });

  const { service } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === sourceTask.id ? sourceTask : null,
    },
    asset: {
      findMany: async () => [unrelatedAsset],
    },
  });

  await assert.rejects(
    () =>
      service.createTask(user as any, {
        capability: "image.edit",
        model: "gpt-image-2",
        prompt: "Refine an unrelated asset",
        sourceTaskId: sourceTask.id,
        sourceAction: "edit",
        assetIds: [unrelatedAsset.id],
      }),
    /Choose one successful batch image from the source batch task/,
  );
});

test("createTask rejects another user's conversationId and assetIds", async () => {
  const user = buildUser({ id: "user-a" });
  const otherConversation = buildConversation({
    id: "conv-b",
    userId: "user-b",
  });
  const otherAsset = buildAsset({
    id: "asset-b",
    userId: "user-b",
    type: "upload",
  });

  const { service, calls } = createHarness({
    conversation: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.id === otherConversation.id && where.userId === otherConversation.userId
          ? otherConversation
          : null,
    },
    asset: {
      findMany: async (args: Record<string, any>) => {
        calls.assetFindMany.push(args);
        const ids = args.where?.id?.in ?? [];
        return ids.includes(otherAsset.id) &&
          args.where?.userId === otherAsset.userId
          ? [otherAsset]
          : [];
      },
    },
  });

  await assert.rejects(
    () =>
      service.createTask(user as any, {
        conversationId: otherConversation.id,
        capability: "image.generate",
        model: "gpt-image-2",
        prompt: "Attempt cross-user conversation",
      }),
    /Conversation not found/,
  );

  await assert.rejects(
    () =>
      service.createTask(user as any, {
        capability: "image.generate",
        model: "gpt-image-2",
        prompt: "Attempt cross-user asset",
        assetIds: [otherAsset.id],
      }),
    /One or more assetIds are invalid/,
  );
});

test("createTask rejects another user's sourceTaskId", async () => {
  const user = buildUser({ id: "user-a" });
  const otherTask = buildTask({
    id: "task-b",
    userId: "user-b",
    conversationId: "conv-b",
  });
  const { service } = createHarness({
    task: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.id === otherTask.id && where.userId === otherTask.userId
          ? otherTask
          : null,
    },
  });

  await assert.rejects(
    () =>
      service.createTask(user as any, {
        capability: "image.generate",
        model: "gpt-image-2",
        prompt: "Attempt cross-user source task",
        sourceTaskId: otherTask.id,
        sourceAction: "variant",
      }),
    /Source task not found/,
  );
});

test("createTask forks into a new conversation and preserves source chain", async () => {
  const user = buildUser();
  const sourceConversation = buildConversation({ id: "conv-root", title: "Root conversation" });
  const forkConversation = buildConversation({ id: "conv-fork", title: "Root conversation" });
  const sourceAsset = buildAsset({
    id: "generated-1",
    type: "generated",
    taskId: "task-source",
  });
  const sourceTask = buildTask({
    id: "task-source",
    status: "succeeded",
    conversationId: sourceConversation.id,
    conversation: sourceConversation,
    assets: [sourceAsset],
  });
  let createdTaskInput: Record<string, unknown> | undefined;

  const { service, calls } = createHarness({
    raw: {
      $queryRaw: async () => [
        {
          baseUrl: "https://yunwu.ai",
          enabledModelIds: ["gpt-image-1"],
          ui: {},
        },
      ],
    },
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === sourceTask.id ? sourceTask : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        createdTaskInput = data.input as Record<string, unknown>;
        return buildTask({
          id: "task-fork",
          ...data,
          conversation: forkConversation,
          assets: [],
          events: [],
        });
      },
      findUniqueOrThrow: async () =>
        buildTask({
          id: "task-fork",
          conversationId: forkConversation.id,
          sourceTaskId: sourceTask.id,
          sourceAction: "fork",
          conversation: forkConversation,
          assets: [],
          events: [],
          input: createdTaskInput,
        }),
    },
    conversation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.conversationCreate.push(data);
        return buildConversation({
          ...forkConversation,
          title: data.title,
          userId: data.userId,
          metadata: data.metadata ?? null,
        });
      },
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === forkConversation.id
          ? {
              ...forkConversation,
              metadata: {
                forkedFromConversationId: sourceConversation.id,
                forkedFromTaskId: sourceTask.id,
              },
              messages: [],
              tasks: [
                buildTask({
                  id: "task-fork",
                  conversationId: forkConversation.id,
                  sourceTaskId: sourceTask.id,
                  sourceAction: "fork",
                  conversation: forkConversation,
                  assets: [],
                  events: [],
                  input: createdTaskInput,
                }),
              ],
            }
          : null,
    },
    asset: {
      findMany: async () => [sourceAsset],
    },
  });

  const response = await service.createTask(user as any, {
    capability: "image.edit",
    model: "gpt-image-1",
    prompt: "Fork and refine the composition",
    sourceTaskId: sourceTask.id,
    sourceAction: "fork",
    fork: true,
  });

  assert.equal(calls.conversationCreate.length, 1);
  assert.deepEqual(calls.conversationCreate[0]?.metadata, {
    forkedFromConversationId: sourceConversation.id,
    forkedFromTaskId: sourceTask.id,
  });
  assert.equal(calls.taskCreate[0]?.conversationId, forkConversation.id);
  assert.equal(calls.taskCreate[0]?.sourceTaskId, sourceTask.id);
  assert.equal(calls.taskCreate[0]?.sourceAction, "fork");
  assert.deepEqual(
    (calls.taskCreate[0]?.input as Record<string, unknown>).assetIds,
    [sourceAsset.id],
  );
  assert.equal(response.conversation.id, forkConversation.id);
  assert.deepEqual(response.conversation.metadata, {
    forkedFromConversationId: sourceConversation.id,
    forkedFromTaskId: sourceTask.id,
  });
  assert.equal(response.task.sourceTaskId, sourceTask.id);
  assert.equal(response.task.sourceAction, "fork");
  assert.deepEqual(response.task.assetIds, [sourceAsset.id]);
});

test("retryTask retries failed tasks and writes retry source chain", async () => {
  const user = buildUser();
  const conversation = buildConversation({ id: "conv-retry" });
  const failedTask = buildTask({
    id: "task-failed",
    status: "failed",
    conversationId: conversation.id,
    conversation,
    events: [
      buildTaskEvent({
        taskId: "task-failed",
        details: {
          category: "provider_unreachable",
          retryable: true,
          title: "Provider unreachable",
          detail: "The service could not reach the provider.",
        },
      }),
    ],
    errorMessage: "network timeout",
  });

  const { service, calls } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === failedTask.id ? failedTask : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        return buildTask({
          id: "task-retried",
          ...data,
          conversation,
          assets: [],
          events: [],
        });
      },
      findUniqueOrThrow: async () =>
        buildTask({
          id: "task-retried",
          conversationId: conversation.id,
          sourceTaskId: failedTask.id,
          sourceAction: "retry",
          conversation,
          assets: [],
          events: [],
          input: failedTask.input,
        }),
    },
  });

  const response = await service.retryTask(user as any, failedTask.id);

  assert.equal(calls.taskCreate[0]?.sourceTaskId, failedTask.id);
  assert.equal(calls.taskCreate[0]?.sourceAction, "retry");
  assert.deepEqual(calls.enqueued, [{ taskId: "task-retried", source: "user-retry" }]);
  assert.equal(response.retriedFromTaskId, failedTask.id);
  assert.equal(response.task.sourceTaskId, failedTask.id);
  assert.equal(response.task.sourceAction, "retry");
  assert.equal(response.task.canRetry, false);
});

test("retryTask retries succeeded tasks by copying original input", async () => {
  const user = buildUser();
  const conversation = buildConversation({ id: "conv-success-retry" });
  const succeededTask = buildTask({
    id: "task-succeeded",
    status: "succeeded",
    conversationId: conversation.id,
    conversation,
    type: "image.edit",
    input: {
      model: "gpt-image-2",
      prompt: "Retouch the product photo",
      assetIds: ["asset-input-1"],
      params: { size: "1024x1024", quality: "high" },
      providerBaseUrl: "https://api3.wlai.vip",
    },
    output: {
      assetIds: ["generated-1"],
    },
    assets: [buildAsset({ id: "generated-1", type: "generated" })],
  });

  const { service, calls } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === succeededTask.id ? succeededTask : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        return buildTask({
          id: "task-retried-success",
          ...data,
          conversation,
          assets: [],
          events: [],
        });
      },
      findUniqueOrThrow: async () =>
        buildTask({
          id: "task-retried-success",
          conversationId: conversation.id,
          sourceTaskId: succeededTask.id,
          sourceAction: "retry",
          type: "image.edit",
          status: "queued",
          conversation,
          assets: [],
          events: [],
          input: succeededTask.input,
        }),
    },
  });

  const response = await service.retryTask(user as any, succeededTask.id);

  assert.equal(calls.taskCreate[0]?.userId, user.id);
  assert.equal(calls.taskCreate[0]?.conversationId, conversation.id);
  assert.equal(calls.taskCreate[0]?.sourceTaskId, succeededTask.id);
  assert.equal(calls.taskCreate[0]?.sourceAction, "retry");
  assert.equal(calls.taskCreate[0]?.type, "image.edit");
  assert.deepEqual(calls.taskCreate[0]?.input, succeededTask.input);
  assert.deepEqual(calls.enqueued, [
    { taskId: "task-retried-success", source: "user-retry" },
  ]);
  assert.equal(response.retriedFromTaskId, succeededTask.id);
  assert.equal(response.task.sourceTaskId, succeededTask.id);
  assert.equal(response.task.sourceAction, "retry");
});

test("retryTask keeps a one-slot batch retry round marked as batch", async () => {
  const user = buildUser();
  const conversation = buildConversation({ id: "conv-batch-retry" });
  const sourceBatchItems = [
    buildBatchItem({
      id: "batch-source-1",
      taskId: "task-batch-source",
      batchIndex: 0,
      status: "succeeded",
      assetId: "generated-1",
    }),
    buildBatchItem({
      id: "batch-source-2",
      taskId: "task-batch-source",
      batchIndex: 1,
      status: "failed",
      errorMessage: "Provider rate limited.",
    }),
  ];
  const sourceTask = buildTask({
    id: "task-batch-source",
    status: "succeeded",
    conversationId: conversation.id,
    conversation,
    input: {
      model: "gpt-image-2",
      prompt: "Retry a batch with one slot",
      assetIds: [],
      params: { size: "1024x1024" },
      batchCount: 2,
      providerBaseUrl: "https://api3.wlai.vip",
    },
    output: {
      batchSize: 2,
      successCount: 1,
      failedCount: 1,
      returnedCount: 2,
      loadingCount: 0,
      firstFailureMessage: "Provider rate limited.",
    },
    batchItems: sourceBatchItems,
    assets: [buildAsset({ id: "generated-1", type: "generated" })],
  });
  const retryBatchItems = [
    buildBatchItem({
      id: "batch-retry-1",
      taskId: "task-batch-retry-one",
      batchIndex: 0,
    }),
  ];
  let retryTaskInput: Record<string, unknown> | undefined;

  const { service, calls } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === sourceTask.id ? sourceTask : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        retryTaskInput = data.input as Record<string, unknown>;
        return buildTask({
          id: "task-batch-retry-one",
          ...data,
          conversation,
          assets: [],
          events: [],
          batchItems: [],
        });
      },
      findUniqueOrThrow: async () =>
        buildTask({
          id: "task-batch-retry-one",
          conversationId: conversation.id,
          sourceTaskId: sourceTask.id,
          sourceAction: "retry",
          conversation,
          assets: [],
          events: [],
          input: retryTaskInput,
          batchItems: retryBatchItems,
        }),
    },
  });

  const response = await service.retryTask(user as any, sourceTask.id, {
    batchRetryCount: 1,
  });

  assert.equal(calls.taskBatchItemCreateMany.length, 1);
  assert.equal(
    (calls.taskBatchItemCreateMany[0]?.data as Record<string, unknown>[]).length,
    1,
  );
  assert.deepEqual(calls.batchEnqueued, [
    { taskId: "task-batch-retry-one", source: "batch-retry", options: undefined },
  ]);
  assert.equal(response.retriedFromTaskId, sourceTask.id);
  assert.equal(retryTaskInput?.providerBaseUrl, "https://api3.wlai.vip");
  assert.equal(retryTaskInput?.batchCount, 1);
  assert.equal(response.task.batch?.isBatch, true);
  assert.equal(response.task.batch?.batchSize, 1);
  assert.equal(response.task.batchItems?.length, 1);
});

test("retryTask with batchRetryCount zero resets failed batch slots in place", async () => {
  const user = buildUser();
  const conversation = buildConversation({ id: "conv-batch-in-place" });
  const batchItems = [
    buildBatchItem({
      id: "batch-success-1",
      taskId: "task-batch-in-place",
      batchIndex: 0,
      status: "succeeded",
      assetId: "generated-1",
      progress: 100,
      attempt: 1,
    }),
    buildBatchItem({
      id: "batch-failed-1",
      taskId: "task-batch-in-place",
      batchIndex: 1,
      status: "failed",
      errorMessage: "Provider rate limited.",
      progress: 100,
      attempt: 1,
      completedAt: NOW,
    }),
  ];
  const sourceTask = buildTask({
    id: "task-batch-in-place",
    status: "succeeded",
    conversationId: conversation.id,
    conversation,
    input: {
      model: "gpt-image-2",
      prompt: "Retry failed slots in place",
      assetIds: [],
      params: { size: "1024x1024" },
      batchCount: 2,
    },
    output: {
      batchSize: 2,
      successCount: 1,
      failedCount: 1,
      returnedCount: 2,
      loadingCount: 0,
      firstFailureMessage: "Provider rate limited.",
    },
    batchItems,
    assets: [buildAsset({ id: "generated-1", type: "generated" })],
  });

  const { service, calls } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === sourceTask.id ? sourceTask : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(sourceTask, data);
        return sourceTask;
      },
      findUniqueOrThrow: async () => sourceTask,
    },
    taskBatchItem: {
      updateMany: async (args: {
        where: { id?: { in?: string[] } };
        data: Record<string, unknown>;
      }) => {
        calls.taskBatchItemUpdateMany.push(args);
        const ids = new Set(args.where.id?.in ?? []);
        for (const item of batchItems) {
          if (ids.has(item.id)) {
            Object.assign(item, args.data);
          }
        }
        return { count: ids.size };
      },
      findMany: async () => batchItems,
    },
  });

  const response = await service.retryTask(user as any, sourceTask.id, {
    batchRetryCount: 0,
  });

  assert.equal(calls.taskCreate.length, 0);
  assert.equal(calls.taskBatchItemUpdateMany.length, 1);
  assert.deepEqual(calls.batchEnqueued, [
    {
      taskId: sourceTask.id,
      source: "batch-retry-failed-slots",
      options: { dedupe: false },
    },
  ]);
  assert.equal(batchItems[0]?.status, "succeeded");
  assert.equal(batchItems[1]?.status, "queued");
  assert.equal(batchItems[1]?.errorMessage, null);
  assert.equal(response.task.id, sourceTask.id);
  assert.equal(response.task.batch?.successCount, 1);
  assert.equal(response.task.batch?.loadingCount, 1);
});

test("retryTask retries failed tasks even when failure details are non-retryable", async () => {
  const user = buildUser();
  const failedTask = buildTask({
    id: "task-invalid",
    status: "failed",
    events: [
      buildTaskEvent({
        taskId: "task-invalid",
        details: {
          category: "provider_invalid_request",
          retryable: false,
          title: "Provider invalid request",
          detail: "Prompt violates content policy.",
        },
      }),
    ],
    errorMessage: "Prompt violates content policy.",
  });

  const { service, calls } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === failedTask.id ? failedTask : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        return buildTask({
          id: "task-invalid-retry",
          ...data,
          assets: [],
          events: [],
        });
      },
      findUniqueOrThrow: async () =>
        buildTask({
          id: "task-invalid-retry",
          conversationId: failedTask.conversationId,
          sourceTaskId: failedTask.id,
          sourceAction: "retry",
          status: "queued",
          assets: [],
          events: [],
          input: failedTask.input,
        }),
    },
  });

  const response = await service.retryTask(user as any, failedTask.id);

  assert.equal(calls.taskCreate[0]?.sourceTaskId, failedTask.id);
  assert.equal(response.retriedFromTaskId, failedTask.id);
});

test("retryTask rejects in-progress tasks with a user-readable error", async () => {
  const user = buildUser();
  const runningTask = buildTask({
    id: "task-running",
    status: "running",
    conversationId: "conv-running",
  });
  const { service, calls } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === runningTask.id ? runningTask : null,
    },
  });

  await assert.rejects(
    () => service.retryTask(user as any, runningTask.id),
    (error: unknown) => {
      assert(error instanceof BadRequestException);
      assert.match(
        (error as Error).message,
        /still in progress and cannot be retried yet/i,
      );
      return true;
    },
  );
  assert.equal(calls.taskCreate.length, 0);
});

test("retryTask keeps member retry access isolated to owned tasks", async () => {
  const ownerTask = buildTask({
    id: "task-owned-by-other",
    userId: "user-2",
    status: "succeeded",
  });
  const { service, calls } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string; userId?: string } }) =>
        where.id === ownerTask.id &&
        (!where.userId || where.userId === ownerTask.userId)
          ? ownerTask
          : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.taskCreate.push(data);
        return buildTask({
          id: "task-admin-retry",
          ...data,
          assets: [],
          events: [],
        });
      },
      findUniqueOrThrow: async () =>
        buildTask({
          id: "task-admin-retry",
          userId: ownerTask.userId,
          conversationId: ownerTask.conversationId,
          sourceTaskId: ownerTask.id,
          sourceAction: "retry",
          status: "queued",
          assets: [],
          events: [],
          input: ownerTask.input,
        }),
    },
  });

  await assert.rejects(
    () => service.retryTask(buildUser({ id: "user-1" }) as any, ownerTask.id),
    (error: unknown) => {
      assert(error instanceof NotFoundException);
      assert.match((error as Error).message, /Task not found/);
      return true;
    },
  );
  assert.equal(calls.taskCreate.length, 0);

  const adminResponse = await service.retryTask(
    buildUser({ id: "admin-1", role: "admin" }) as any,
    ownerTask.id,
  );

  assert.equal(calls.taskCreate[0]?.userId, ownerTask.userId);
  assert.equal(adminResponse.retriedFromTaskId, ownerTask.id);
});

test("archiveConversation and deleteConversation only mutate owned conversations", async () => {
  const owner = buildUser();
  const outsider = buildUser({ id: "user-2" });
  const conversation = buildConversation({ id: "conv-mut", userId: owner.id });
  let updatedStatus: string | undefined;

  const { service } = createHarness({
    conversation: {
      findFirst: async ({ where }: { where: { id?: string; userId?: string } }) =>
        where.id === conversation.id &&
        (!where.userId || where.userId === owner.id)
          ? conversation
          : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updatedStatus = String(data.status);
        return buildConversation({
          ...conversation,
          status: data.status,
          metadata: data.metadata ?? null,
        });
      },
    },
  });

  await assert.rejects(() => service.archiveConversation(outsider as any, conversation.id));
  await service.archiveConversation(owner as any, conversation.id);
  assert.equal(updatedStatus, "archived");
  await service.deleteConversation(owner as any, conversation.id);
  assert.equal(updatedStatus, "deleted");
});

test("deleteLibraryAsset only mutates owned generated assets", async () => {
  const owner = buildUser({ id: "owner" });
  const outsider = buildUser({ id: "outsider" });
  const asset = buildAsset({
    id: "asset-owned",
    userId: owner.id,
    type: "generated",
  });
  const { service, calls } = createHarness({
    asset: {
      findFirst: async ({ where }: { where: { id?: string; userId?: string; type?: string } }) =>
        where.id === asset.id && where.userId === owner.id && where.type === "generated"
          ? asset
          : null,
    },
  });

  await assert.rejects(
    () => service.deleteLibraryAsset(outsider as any, asset.id),
    /Library asset not found/,
  );

  const response = await service.deleteLibraryAsset(owner as any, asset.id);

  assert.equal(response.asset.id, asset.id);
  assert.deepEqual(calls.assetUpdate[0]?.where, { id: asset.id });
  assert.equal((calls.assetUpdate[0]?.data as any)?.status, "deleted");
});

test("conversation, task, history, home, and library stay isolated by user while admin can inspect globally", async () => {
  const owner = buildUser({ id: "user-a", email: "a@example.com" });
  const outsider = buildUser({ id: "user-b", email: "b@example.com" });
  const admin = buildUser({ id: "admin-1", role: "admin", email: "admin@example.com" });
  const ownerConversation = buildConversation({
    id: "conv-a",
    userId: owner.id,
  });
  const ownerAsset = buildAsset({
    id: "asset-a",
    userId: owner.id,
    taskId: "task-a",
    type: "generated",
  });
  const ownerTask = buildTask({
    id: "task-a",
    userId: owner.id,
    conversationId: ownerConversation.id,
    conversation: ownerConversation,
    status: "succeeded",
    output: { assetIds: ["asset-a"] },
    assets: [ownerAsset],
  });
  const ownerConversationDetail = {
    ...ownerConversation,
    messages: [],
    tasks: [ownerTask],
  };

  const { service, calls } = createHarness({
    conversation: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== ownerConversation.id) {
          return null;
        }
        if (where.userId && where.userId !== owner.id) {
          return null;
        }
        return ownerConversationDetail;
      },
      findMany: async (args: Record<string, unknown>) => {
        if ((args.where as Record<string, unknown> | undefined)?.userId === outsider.id) {
          return [];
        }
        return [ownerConversation];
      },
    },
    task: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== ownerTask.id) {
          return null;
        }
        if (where.userId && where.userId !== owner.id) {
          return null;
        }
        return ownerTask;
      },
      findMany: async (args: Record<string, unknown>) => {
        calls.taskFindMany.push(args);
        if ((args.where as Record<string, unknown> | undefined)?.userId === outsider.id) {
          return [];
        }
        return [ownerTask];
      },
    },
    asset: {
      findMany: async (args: Record<string, any>) => {
        calls.assetFindMany.push(args);
        const userId = args.where?.userId ?? args.where?.task?.is?.userId;
        if (userId === outsider.id) {
          return [];
        }
        return args.include?.task ? [{ ...ownerAsset, task: ownerTask }] : [ownerAsset];
      },
    },
  });

  await assert.rejects(
    () => service.getConversation(outsider as any, ownerConversation.id),
    /Conversation not found/,
  );
  await assert.rejects(
    () => service.getTask(outsider as any, ownerTask.id),
    /Task not found/,
  );
  assert.deepEqual((await service.getHistory(outsider as any)).items, []);
  assert.deepEqual((await service.getHome(outsider as any)).recentTasks, []);
  assert.deepEqual((await service.getLibrary(outsider as any)).items, []);

  assert.equal((await service.getConversation(admin as any, ownerConversation.id)).conversation.id, ownerConversation.id);
  assert.equal((await service.getTask(admin as any, ownerTask.id)).task.id, ownerTask.id);
  assert.equal((await service.getTasks(admin as any)).tasks[0]?.id, ownerTask.id);
  assert.equal((await service.getHistory(admin as any)).items[0]?.id, ownerTask.id);
  assert.equal((await service.getHome(admin as any)).recentTasks[0]?.id, ownerTask.id);
  assert.equal((await service.getLibrary(admin as any)).items[0]?.asset.id, ownerAsset.id);
});

test("conversation detail does not backfill another user's referenced input assets", async () => {
  const owner = buildUser({ id: "user-a" });
  const admin = buildUser({ id: "admin-1", role: "admin" });
  const conversation = buildConversation({ id: "conv-a", userId: owner.id });
  const foreignAsset = buildAsset({
    id: "asset-b",
    userId: "user-b",
    type: "upload",
  });
  const task = buildTask({
    id: "task-a",
    userId: owner.id,
    conversationId: conversation.id,
    input: {
      model: "gpt-image-2",
      prompt: "Use a referenced asset",
      assetIds: [foreignAsset.id],
      params: {},
    },
    assets: [],
  });
  const conversationDetail = {
    ...conversation,
    messages: [],
    tasks: [task],
  };
  const { service, calls } = createHarness({
    conversation: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== conversation.id) {
          return null;
        }
        if (where.userId && where.userId !== owner.id) {
          return null;
        }
        return conversationDetail;
      },
    },
    asset: {
      findMany: async (args: Record<string, any>) => {
        calls.assetFindMany.push(args);
        const ids = args.where?.id?.in ?? [];
        if (!ids.includes(foreignAsset.id)) {
          return [];
        }
        return args.where?.userId === owner.id ? [] : [foreignAsset];
      },
    },
  });

  const ownerResponse = await service.getConversation(owner as any, conversation.id);
  const adminResponse = await service.getConversation(admin as any, conversation.id);

  assert.deepEqual(ownerResponse.conversation.assets.map((asset) => asset.id), []);
  assert.deepEqual(adminResponse.conversation.assets.map((asset) => asset.id), [foreignAsset.id]);
  assert.deepEqual(calls.assetFindMany[0]?.where, {
    id: { in: [foreignAsset.id] },
    userId: owner.id,
  });
  assert.deepEqual(calls.assetFindMany[1]?.where, {
    id: { in: [foreignAsset.id] },
  });
});

test("getTask exposes refill fields and structured failure details", async () => {
  const user = buildUser();
  const conversation = buildConversation({ id: "conv-detail" });
  const task = buildTask({
    id: "task-detail",
    status: "failed",
    conversationId: conversation.id,
    conversation,
    sourceTaskId: "task-prev",
    sourceAction: "variant",
    input: {
      model: "gpt-image-1",
      prompt: "Refine the skyline reflections",
      assetIds: ["generated-source"],
      params: { size: "1536x1024", style: "cinematic" },
    },
    events: [
      buildTaskEvent({
        taskId: "task-detail",
        details: {
          category: "provider_invalid_request",
          retryable: false,
          title: "Provider invalid request",
          detail: "Mask area is empty.",
          statusCode: 400,
        },
      }),
    ],
    errorMessage: "Mask area is empty.",
  });

  const { service } = createHarness({
    task: {
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === task.id ? task : null,
    },
  });

  const response = await service.getTask(user as any, task.id);

  assert.deepEqual(response.task.assetIds, ["generated-source"]);
  assert.deepEqual(response.task.params, {
    size: "1536x1024",
    style: "cinematic",
  });
  assert.equal(response.task.sourceTaskId, "task-prev");
  assert.equal(response.task.sourceAction, "variant");
  assert.deepEqual(response.task.failure, {
    category: "provider_invalid_request",
    retryable: false,
    title: "Provider invalid request",
    detail: "Mask area is empty.",
    statusCode: 400,
  });
  assert.equal(response.task.canRetry, true);
});

test("home/library exclude deleted assets while history still preserves deleted outputs", async () => {
  const user = buildUser();
  const conversation = buildConversation({ id: "conv-home", title: "Home thread" });
  const liveAsset = buildAsset({
    id: "asset-live",
    type: "generated",
    taskId: "task-live",
    status: "ready",
  });
  const deletedAsset = buildAsset({
    id: "asset-deleted",
    type: "generated",
    taskId: "task-history",
    status: "deleted",
    metadata: { width: 1024, height: 1024, deletedAt: NOW.toISOString() },
  });
  const successfulTask = buildTask({
    id: "task-live",
    status: "succeeded",
    conversationId: conversation.id,
    conversation,
    assets: [liveAsset],
    input: {
      model: "gpt-image-1",
      prompt: "Recent home artwork",
      assetIds: [],
      params: {},
    },
    output: {
      assetIds: [liveAsset.id],
      inputAssetIds: [],
    },
  });
  const historyTask = buildTask({
    id: "task-history",
    status: "succeeded",
    conversationId: conversation.id,
    conversation,
    assets: [deletedAsset],
    input: {
      model: "gpt-image-1",
      prompt: "Historical result",
      assetIds: [],
      params: {},
    },
    output: {
      assetIds: [deletedAsset.id],
      inputAssetIds: [],
    },
  });
  const failedTask = buildTask({
    id: "task-recovery",
    status: "failed",
    conversationId: conversation.id,
    conversation,
    events: [
      buildTaskEvent({
        taskId: "task-recovery",
        details: {
          category: "provider_server_error",
          retryable: true,
          title: "Provider server error",
          detail: "Temporary upstream outage.",
        },
      }),
    ],
    errorMessage: "Temporary upstream outage.",
  });

  let libraryAssetState = buildAsset({
    ...liveAsset,
    status: "ready",
  });

  const { service, calls } = createHarness({
    conversation: {
      findMany: async () => [conversation],
    },
    task: {
      findMany: async (args: Record<string, any>) => {
        calls.taskFindMany.push(args);
        if (args.where?.status === "failed") {
          return [failedTask];
        }

        return [historyTask];
      },
    },
    asset: {
      findMany: async (args: Record<string, any>) => {
        calls.assetFindMany.push(args);
        return libraryAssetState.status === "deleted"
          ? []
          : [
              {
                ...libraryAssetState,
                task: {
                  ...successfulTask,
                  assets: [libraryAssetState],
                },
              },
            ];
      },
      findFirst: async ({ where }: { where: { id?: string } }) =>
        where.id === libraryAssetState.id ? libraryAssetState : null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        calls.assetUpdate.push({ where, data });
        libraryAssetState = buildAsset({
          ...libraryAssetState,
          id: where.id,
          status: data.status,
          metadata: data.metadata,
        });
        return libraryAssetState;
      },
    },
  });

  const home = await service.getHome(user as any);
  assert.equal(home.recentAssets.length, 1);
  assert.equal(home.recoveryTasks[0]?.canRetry, true);
  assert.equal(
    (calls.assetFindMany[0] as any)?.where?.status?.not,
    "deleted",
  );

  const deleted = await service.deleteLibraryAsset(
    user as any,
    (libraryAssetState as any).id,
  );
  assert.equal(deleted.asset.id, (libraryAssetState as any).id);
  assert.equal(calls.assetUpdate.length, 1);
  assert.equal((calls.assetUpdate[0] as any)?.data?.status, "deleted");
  assert.match(
    String((calls.assetUpdate[0] as any)?.data?.metadata?.deletedAt ?? ""),
    /^\d{4}-\d{2}-\d{2}T/,
  );

  const library = await service.getLibrary(user as any);
  assert.equal(library.items.length, 0);

  const history = await service.getHistory(user as any);
  assert.deepEqual(
    (history.items[0]?.outputSummary as { generatedAssetIds?: string[] })?.generatedAssetIds,
    [deletedAsset.id],
  );
});
