// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

import { LibraryPage } from "@/pages/library-page";
import type {
  AssetRecord,
  LibraryItemRecord,
  LibraryResponse,
  TaskRecord,
} from "@/lib/api-types";

const apiClientMock = vi.hoisted(() => ({
  deleteLibraryAsset: vi.fn(),
  getLibrary: vi.fn(),
  downloadLibraryAssets: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiClient: apiClientMock,
}));

function createTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_real",
    capability: "image.generate",
    status: "succeeded",
    modelId: "gpt-image-1",
    prompt: "real provider output",
    createdAt: "2026-04-29T08:00:00.000Z",
    updatedAt: "2026-04-29T08:00:00.000Z",
    assetIds: [],
    outputSummary: {
      mocked: false,
      generatedAssetIds: ["asset_real"],
    },
    ...overrides,
  };
}

function createAsset(overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: "asset_real",
    taskId: "task_real",
    type: "generated",
    url: "/api/assets/asset_real/content",
    createdAt: "2026-04-29T08:00:00.000Z",
    ...overrides,
  };
}

function createLibraryItem(overrides: Partial<LibraryItemRecord> = {}): LibraryItemRecord {
  return {
    asset: createAsset(),
    task: createTask(),
    conversation: {
      id: "conv_real",
      title: "real conversation",
      updatedAt: "2026-04-29T08:00:00.000Z",
    },
    ...overrides,
  };
}

function renderLibraryPage(response: LibraryResponse) {
  apiClientMock.getLibrary.mockResolvedValue(response);

  return render(
    <MemoryRouter initialEntries={["/library"]}>
      <LibraryPage />
    </MemoryRouter>,
  );
}

describe("library page", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows only succeeded non-mocked generated assets", async () => {
    renderLibraryPage({
      items: [
        createLibraryItem(),
        createLibraryItem({
          asset: createAsset({
            id: "asset_mocked",
            taskId: "task_mocked",
          }),
          task: createTask({
            id: "task_mocked",
            prompt: "mocked random output",
            outputSummary: {
              mocked: true,
              generatedAssetIds: ["asset_mocked"],
            },
          }),
        }),
        createLibraryItem({
          asset: createAsset({
            id: "asset_failed",
            taskId: "task_failed",
          }),
          task: createTask({
            id: "task_failed",
            status: "failed",
            prompt: "failed provider output",
            errorMessage: "Provider unavailable",
            outputSummary: {
              generatedAssetIds: ["asset_failed"],
            },
          }),
        }),
      ],
    });

    expect(await screen.findByText("real provider output")).toBeTruthy();
    expect(screen.queryByText("mocked random output")).toBeNull();
    expect(screen.queryByText("failed provider output")).toBeNull();
    expect(screen.getAllByText("下载")).toHaveLength(1);
  });


  it("勾选批量任务卡会把该任务的所有图片都加进下载清单", async () => {
    renderLibraryPage({
      items: [
        createLibraryItem({
          kind: "batch",
          assets: [
            createAsset({ id: "asset_batch_1" }),
            createAsset({ id: "asset_batch_2" }),
            createAsset({ id: "asset_batch_3" }),
          ],
          task: createTask({
            id: "task_batch",
            batch: {
              isBatch: true,
              batchSize: 3,
              returnedCount: 3,
              successCount: 3,
              failedCount: 0,
              loadingCount: 0,
            },
          }),
        }),
      ],
    });

    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox);

    // 一张批量卡 = 3 个资产，按钮上要显示 3。
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下载所选 \(3\)/ })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /下载所选/ }));
    await waitFor(() =>
      expect(apiClientMock.downloadLibraryAssets).toHaveBeenCalledWith([
        "asset_batch_1",
        "asset_batch_2",
        "asset_batch_3",
      ]),
    );
  });

  it("批量任务与单张作品可混合下载，且失败槽位不会占额度", async () => {
    renderLibraryPage({
      items: [
        createLibraryItem({
          kind: "batch",
          assets: [
            createAsset({ id: "asset_batch_1" }),
            createAsset({ id: "asset_batch_2" }),
          ],
          task: createTask({
            id: "task_batch",
            batch: {
              isBatch: true,
              batchSize: 4,
              returnedCount: 2,
              successCount: 2,
              failedCount: 2,
              loadingCount: 0,
            },
          }),
        }),
        createLibraryItem({
          asset: createAsset({ id: "asset_single_1", taskId: "task_single" }),
          task: createTask({ id: "task_single", prompt: "single work" }),
        }),
      ],
    });

    await screen.findByText("single work");

    // 全选：2 个批量图 + 1 个单张 = 3，失败的 2 个槽位不计入。
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下载所选 \(3\)/ })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /下载所选/ }));
    await waitFor(() =>
      expect(apiClientMock.downloadLibraryAssets).toHaveBeenCalledWith([
        "asset_batch_1",
        "asset_batch_2",
        "asset_single_1",
      ]),
    );
  });

  it("取消勾选批量卡会把它所有图片从清单里移除", async () => {
    renderLibraryPage({
      items: [
        createLibraryItem({
          kind: "batch",
          assets: [
            createAsset({ id: "asset_batch_1" }),
            createAsset({ id: "asset_batch_2" }),
          ],
          task: createTask({
            id: "task_batch",
            batch: {
              isBatch: true,
              batchSize: 2,
              returnedCount: 2,
              successCount: 2,
              failedCount: 0,
              loadingCount: 0,
            },
          }),
        }),
      ],
    });

    const checkbox = await screen.findByRole("checkbox");
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下载所选 \(2\)/ })).toBeTruthy(),
    );

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "下载所选" })).toBeTruthy(),
    );
    // 没有选中项时按钮不可点。
    expect(
      (screen.getByRole("button", { name: "下载所选" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("删除作品后勾选状态同步收敛，不会残留失效 id", async () => {
    renderLibraryPage({
      items: [
        createLibraryItem({
          asset: createAsset({ id: "asset_del_1", taskId: "task_del_1" }),
          task: createTask({ id: "task_del_1", prompt: "to delete" }),
        }),
      ],
    });

    await screen.findByText("to delete");
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /下载所选 \(1\)/ })).toBeTruthy(),
    );

    apiClientMock.deleteLibraryAsset.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => expect(screen.queryByText("to delete")).toBeNull());
    // 作品库空了，工具栏整体消失，也就不会残留失效的勾选 id。
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /下载所选/ })).toBeNull(),
    );
    expect(apiClientMock.downloadLibraryAssets).not.toHaveBeenCalled();
  });

  it("requires opening the batch modal instead of direct batch re-edit", async () => {
    renderLibraryPage({
      items: [
        createLibraryItem({
          kind: "batch",
          assets: [
            createAsset({ id: "asset_batch_1" }),
            createAsset({ id: "asset_batch_2" }),
          ],
          task: createTask({
            batch: {
              isBatch: true,
              batchSize: 2,
              returnedCount: 2,
              successCount: 2,
              failedCount: 0,
              loadingCount: 0,
            },
          }),
        }),
      ],
    });

    expect(await screen.findByText("批量 x2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开批量结果" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "继续创作" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fork" })).toBeNull();
  });

  it("加载更多 appends the next page and hides the button when exhausted", async () => {
    const nextItem = createLibraryItem({
      asset: createAsset({ id: "asset_next", taskId: "task_next" }),
      task: createTask({ id: "task_next" }),
    });
    apiClientMock.getLibrary
      .mockResolvedValueOnce({ items: [createLibraryItem()], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ items: [nextItem], nextCursor: null });

    render(
      <MemoryRouter initialEntries={["/library"]}>
        <LibraryPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));

    await waitFor(() => expect(apiClientMock.getLibrary).toHaveBeenLastCalledWith("cursor-1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull());
    expect(apiClientMock.getLibrary).toHaveBeenCalledTimes(2);
  });
});
