import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildTaskRoundNavigation,
  getComposerSubmissionGuard,
  getTaskComposerAssets,
  getTaskRuntimeLabel,
  isLibraryItemDisplayable,
  isTaskMocked,
  resolveComposerCapability,
  resolveAssetUrl,
  toImageResults,
  toUiTask,
} from "@/lib/api-mappers";
import { apiClient } from "@/lib/api-client";
import type { AssetRecord, ModelRecord, TaskRecord } from "@/lib/api-types";

function createTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    capability: "image.generate",
    status: "succeeded",
    modelId: "gpt-image-1",
    prompt: "draw a cat",
    createdAt: "2026-04-24T10:00:00.000Z",
    updatedAt: "2026-04-24T10:02:00.000Z",
    assetIds: [],
    ...overrides,
  };
}

function createAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: "asset_1",
    taskId: "task_1",
    type: "generated",
    url: "/api/assets/asset_1/content",
    storageKey: "asset_1.png",
    createdAt: "2026-04-24T10:02:00.000Z",
    ...overrides,
  };
}

function createModel(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: "gpt-image-1",
    name: "GPT Image 1",
    type: "image-editing",
    capabilityTypes: ["image.generate", "image.edit"],
    enabled: true,
    ...overrides,
  };
}

describe("api mappers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses generated output asset ids for re-edit even if detail assets are missing", () => {
    const task = createTask({
      outputSummary: {
        generatedAssetIds: ["asset_generated_1"],
      },
    });

    const assets = getTaskComposerAssets(task, []);

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "asset_generated_1",
      taskId: "task_1",
      type: "generated",
    });
  });

  it("hydrates batch slot assets from embedded output summaries", () => {
    const task = createTask({
      batch: {
        isBatch: true,
        batchSize: 2,
        returnedCount: 2,
        successCount: 2,
        failedCount: 0,
        loadingCount: 0,
      },
      batchItems: [
        {
          id: "slot_1",
          taskId: "task_1",
          batchIndex: 0,
          status: "succeeded",
          progress: 100,
          assetId: "asset_batch_1",
          attempt: 1,
          createdAt: "2026-04-24T10:00:00.000Z",
          updatedAt: "2026-04-24T10:02:00.000Z",
        },
        {
          id: "slot_2",
          taskId: "task_1",
          batchIndex: 1,
          status: "succeeded",
          progress: 100,
          assetId: "asset_batch_2",
          attempt: 1,
          createdAt: "2026-04-24T10:00:00.000Z",
          updatedAt: "2026-04-24T10:02:00.000Z",
        },
      ],
      outputSummary: {
        mocked: false,
        generatedAssetIds: ["asset_batch_1", "asset_batch_2"],
        assets: [
          {
            id: "asset_batch_1",
            url: "/api/assets/asset_batch_1/content",
            mimeType: "image/png",
            width: 1024,
            height: 1024,
            batchIndex: 0,
            batchItemId: "slot_1",
          },
          {
            id: "asset_batch_2",
            url: "/api/assets/asset_batch_2/content",
            mimeType: "image/png",
            width: 1536,
            height: 1024,
            batchIndex: 1,
            batchItemId: "slot_2",
          },
        ],
      },
    });

    const uiTask = toUiTask(task, []);

    expect(uiTask.resultAssets?.map((asset) => asset.id)).toEqual([
      "asset_batch_1",
      "asset_batch_2",
    ]);
    expect(uiTask.batchSlots?.[1]?.asset).toMatchObject({
      id: "asset_batch_2",
      label: "1536 × 1024",
    });
  });

  it("keeps original input assets for invalid request recovery", () => {
    const task = createTask({
      status: "failed",
      assetIds: ["asset_input_1"],
      failure: {
        category: "invalid_request",
        retryable: false,
      },
    });

    const assets = getTaskComposerAssets(task, []);

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      id: "asset_input_1",
      type: "upload",
    });
  });

  it("does not present generated outputs as reference material", () => {
    const task = createTask({
      status: "succeeded",
      // 旧接口的回退值：没有输入时 assetIds 会等于产出，前端不能再据此判断参考素材。
      assetIds: ["asset_out_1"],
      inputSummary: { assetIds: [] },
      outputSummary: { generatedAssetIds: ["asset_out_1"] },
    });
    const asset = createAsset({ id: "asset_out_1" });

    const uiTask = toUiTask(task, [asset]);

    expect(uiTask.inputAssets).toEqual([]);
    expect(uiTask.resultAssets?.map((item) => item.id)).toEqual(["asset_out_1"]);
  });

  it("prefers image.edit when manual uploads are present", () => {
    expect(
      resolveComposerCapability({
        requestedCapability: "image.generate",
        assetCount: 1,
      }),
    ).toBe("image.edit");
  });

  it("blocks edit submission when the selected model does not support image.edit", () => {
    const guard = getComposerSubmissionGuard({
      models: [
        createModel({
          id: "flux-schnell",
          name: "FLUX Schnell",
          type: "image-generation",
          capabilityTypes: ["image.generate"],
        }),
      ],
      modelId: "flux-schnell",
      requestedCapability: "image.generate",
      assetCount: 1,
    });

    expect(guard.capability).toBe("image.edit");
    expect(guard.reason).toContain("FLUX Schnell");
    expect(guard.reason).toContain("不支持图片编辑");
  });

  it("blocks unsupported task-channel models and prefers the backend status message", () => {
    const guard = getComposerSubmissionGuard({
      models: [
        createModel({
          id: "gpt-4o-image",
          name: "GPT-4o Image",
          taskSupported: false,
          status: "unsupported",
          statusMessage: "该模型正在接入中。",
        }),
      ],
      modelId: "gpt-4o-image",
      requestedCapability: "image.generate",
    });

    expect(guard.reason).toBe("该模型正在接入中。");
  });

  it("uses a clear fallback message for unsupported task-channel models", () => {
    const guard = getComposerSubmissionGuard({
      models: [
        createModel({
          id: "manual-model",
          name: "Manual Model",
          taskSupported: false,
        }),
      ],
      modelId: "manual-model",
      requestedCapability: "image.generate",
    });

    expect(guard.reason).toBe("该模型暂未接入当前任务通道。");
  });

  it("resolves relative asset urls against api origin", () => {
    const resolvedFromLiteral = resolveAssetUrl("/api/assets/asset_1/content");
    const resolvedFromAsset = resolveAssetUrl(createAsset().url);

    expect(resolvedFromLiteral).toBe(resolvedFromAsset);
    expect(new URL(resolvedFromLiteral ?? "").pathname).toBe(
      "/api/assets/asset_1/content",
    );
  });

  it("normalizes absolute localhost asset urls to the api origin", () => {
    const resolved = resolveAssetUrl("http://localhost:3000/api/assets/asset_1/content");

    expect(new URL(resolved ?? "").pathname).toBe("/api/assets/asset_1/content");
    expect(new URL(resolved ?? "").origin).toBe(new URL(apiClient.getBaseUrl()).origin);
  });

  it("normalizes old absolute asset proxy urls through the current relative api base", () => {
    vi.spyOn(apiClient, "getBaseUrl").mockReturnValue("/api");

    const resolved = resolveAssetUrl(
      "http://127.0.0.1:4304/api/assets/old-storage-key.png/content",
      "old-storage-key.png",
    );

    expect(resolved).toBe(
      `${window.location.origin}/api/assets/old-storage-key.png/content`,
    );
    expect(resolved).not.toContain("4304");
  });

  it("uses the current asset proxy for stale loopback object urls when storageKey is available", () => {
    vi.spyOn(apiClient, "getBaseUrl").mockReturnValue("http://127.0.0.1:4305/api");

    const resolved = resolveAssetUrl(
      "http://127.0.0.1:19000/yunwu-assets/old-storage-key.png",
      "old-storage-key.png",
    );

    expect(resolved).toBe(
      "http://127.0.0.1:4305/api/assets/old-storage-key.png/content",
    );
  });

  it("maps task and image result assets to current proxy urls using storageKey", () => {
    vi.spyOn(apiClient, "getBaseUrl").mockReturnValue("/api");
    const staleAsset = createAsset({
      url: "http://127.0.0.1:19000/yunwu-assets/asset_1.png",
      storageKey: "asset_1.png",
    });
    const task = createTask({
      outputSummary: {
        generatedAssetIds: [staleAsset.id],
      },
    });

    const uiTask = toUiTask(task, [staleAsset]);
    const imageResults = toImageResults([task], [staleAsset]);

    expect(uiTask.resultAssets?.[0]?.url).toBe(
      `${window.location.origin}/api/assets/asset_1.png/content`,
    );
    expect(uiTask.resultAssets?.[0]?.storageKey).toBe("asset_1.png");
    expect(imageResults[0]?.url).toBe(
      `${window.location.origin}/api/assets/asset_1.png/content`,
    );
    expect(imageResults[0]?.storageKey).toBe("asset_1.png");
  });

  it("keeps external public asset urls when they are not API proxy URLs", () => {
    vi.spyOn(apiClient, "getBaseUrl").mockReturnValue("/api");

    const resolved = resolveAssetUrl(
      "https://cdn.example.com/yunwu-assets/asset.png",
      "asset.png",
    );

    expect(resolved).toBe("https://cdn.example.com/yunwu-assets/asset.png");
  });

  it("does not expose generated assets on failed tasks", () => {
    const failedTask = createTask({
      status: "failed",
      errorMessage: "Provider unavailable: missing API key.",
      failure: {
        category: "provider_unavailable",
        retryable: false,
        title: "Provider unavailable",
        detail: "Real image generation is unavailable because the provider API key is not configured.",
      },
      outputSummary: {
        generatedAssetIds: ["asset_1"],
      },
    });

    const uiTask = toUiTask(failedTask, [createAsset()]);

    expect(uiTask.errorMessage).toContain("missing API key");
    expect(uiTask.failure?.detail).toContain("provider API key");
    expect(uiTask.resultAssets).toEqual([]);
  });

  it("filters mocked outputs from result and library projections", () => {
    const mockedTask = createTask({
      outputSummary: {
        mocked: true,
        generatedAssetIds: ["asset_1"],
      },
    });
    const realTask = createTask({
      id: "task_2",
      outputSummary: {
        mocked: false,
        generatedAssetIds: ["asset_2"],
      },
    });
    const realAsset = createAsset({
      id: "asset_2",
      taskId: "task_2",
    });

    expect(isTaskMocked(mockedTask)).toBe(true);
    expect(toUiTask(mockedTask, [createAsset()]).resultAssets).toEqual([]);
    expect(
      isLibraryItemDisplayable({
        asset: createAsset(),
        task: mockedTask,
      }),
    ).toBe(false);
    expect(
      toImageResults([mockedTask, realTask], [createAsset(), realAsset]).map((item) => item.id),
    ).toEqual(["asset_2"]);
  });

  it("formats task runtime from created and updated timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T10:05:00.000Z"));

    expect(
      getTaskRuntimeLabel(
        createTask({
          status: "running",
          updatedAt: "2026-04-24T10:04:00.000Z",
        }),
      ),
    ).toBe("运行 5 分");

    expect(getTaskRuntimeLabel(createTask())).toBe("耗时 2 分");

    vi.useRealTimers();
  });

  it("builds retry round navigation without falling back to conversation order", () => {
    const source = createTask({
      id: "task_source",
      createdAt: "2026-04-24T10:00:00.000Z",
    });
    const retry = createTask({
      id: "task_retry",
      sourceTaskId: "task_source",
      sourceAction: "retry",
      createdAt: "2026-04-24T10:02:00.000Z",
    });
    const standalone = createTask({
      id: "task_standalone",
      createdAt: "2026-04-24T10:03:00.000Z",
    });

    const navigation = buildTaskRoundNavigation([source, retry, standalone]);

    expect(navigation.get("task_source")).toMatchObject({
      scope: "retry",
      groupId: "task_source",
      taskIds: ["task_source", "task_retry"],
      index: 1,
      total: 2,
      nextTaskId: "task_retry",
    });
    expect(navigation.get("task_retry")).toMatchObject({
      scope: "retry",
      groupId: "task_source",
      taskIds: ["task_source", "task_retry"],
      index: 2,
      total: 2,
      previousTaskId: "task_source",
    });
    expect(navigation.has("task_standalone")).toBe(false);
  });

  it("does not treat edit, variant, or fork descendants as retry rounds", () => {
    const source = createTask({ id: "task_source" });
    const edit = createTask({
      id: "task_edit",
      sourceTaskId: "task_source",
      sourceAction: "edit",
      createdAt: "2026-04-24T10:01:00.000Z",
    });
    const variant = createTask({
      id: "task_variant",
      sourceTaskId: "task_source",
      sourceAction: "variant",
      createdAt: "2026-04-24T10:02:00.000Z",
    });
    const fork = createTask({
      id: "task_fork",
      sourceTaskId: "task_source",
      sourceAction: "fork",
      createdAt: "2026-04-24T10:03:00.000Z",
    });

    const navigation = buildTaskRoundNavigation([source, edit, variant, fork]);

    expect(navigation.size).toBe(0);
  });
});
