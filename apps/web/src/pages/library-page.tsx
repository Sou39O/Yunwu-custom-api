import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download, FolderOpen, Trash2 } from "lucide-react";

import { LibraryItemCard } from "@/components/cards/library-item-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiClient } from "@/lib/api-client";
import { isLibraryItemDisplayable } from "@/lib/api-mappers";
import type { LibraryItemRecord, LibraryResponse } from "@/lib/api-types";
import { useBatchDownload } from "@/lib/use-batch-download";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

/** 批量任务卡里可能含多张图，勾选一张卡要把它的全部资产都加进下载清单。 */
function collectAssetIds(item: LibraryItemRecord) {
  const assets = item.assets?.length ? item.assets : [item.asset];
  return assets.map((asset) => asset.id);
}

/** 翻页去重用：批量卡按任务收敛，单张按资产 id。 */
function libraryItemKey(item: LibraryItemRecord) {
  return item.kind === "batch" ? `task:${item.task.id}` : `asset:${item.asset.id}`;
}

export function LibraryPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<LibraryResponse>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const { download, downloading, error: downloadError } = useBatchDownload();

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      setData(await apiClient.getLibrary());
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = data?.nextCursor;
    if (!cursor || loadingMore) {
      return;
    }

    setLoadingMore(true);
    setError(null);

    try {
      const next = await apiClient.getLibrary(cursor);
      setData((current) => {
        const items = [...(current?.items ?? [])];
        const seen = new Set(items.map(libraryItemKey));
        for (const item of next.items) {
          const key = libraryItemKey(item);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          items.push(item);
        }
        return { items, nextCursor: next.nextCursor ?? null };
      });
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setLoadingMore(false);
    }
  }, [data?.nextCursor, loadingMore]);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const deletingSet = useMemo(() => new Set(deletingIds), [deletingIds]);
  const visibleItems = useMemo(
    () => (data?.items ?? []).filter(isLibraryItemDisplayable),
    [data?.items],
  );

  // 删除后勾选状态要跟着收敛，否则会拿着已删除的 id 去请求下载。
  const validIds = useMemo(
    () => new Set(visibleItems.flatMap(collectAssetIds)),
    [visibleItems],
  );
  useEffect(() => {
    setSelectedIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [validIds]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggleItem = useCallback((item: LibraryItemRecord, selected: boolean) => {
    const ids = collectAssetIds(item);
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (selected) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return [...next];
    });
  }, []);

  const allSelected = useMemo(
    () =>
      visibleItems.length > 0 &&
      visibleItems.every((item) =>
        collectAssetIds(item).every((id) => selectedSet.has(id)),
      ),
    [visibleItems, selectedSet],
  );

  const toggleAll = useCallback(() => {
    setSelectedIds((current) => {
      const everySelected =
        visibleItems.length > 0 &&
        visibleItems.every((item) =>
          collectAssetIds(item).every((id) => current.includes(id)),
        );
      return everySelected ? [] : visibleItems.flatMap(collectAssetIds);
    });
  }, [visibleItems]);

  const handleDownload = useCallback(async () => {
    await download(selectedIds);
  }, [download, selectedIds]);

  const handleDelete = useCallback(async (item: LibraryItemRecord) => {
    setDeletingIds((current) => [...current, item.asset.id]);

    try {
      await apiClient.deleteLibraryAsset(item.asset.id);
      setData((current) =>
        current
          ? {
              items: current.items.filter((entry) => entry.asset.id !== item.asset.id),
              nextCursor: current.nextCursor,
            }
          : current,
      );
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setDeletingIds((current) => current.filter((id) => id !== item.asset.id));
    }
  }, []);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-primary" />
            <CardTitle>作品库</CardTitle>
          </div>
          <CardDescription>集中查看已完成作品，可继续创作、Fork 或删除。</CardDescription>
        </CardHeader>
      </Card>

      {visibleItems.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[hsl(var(--outline-variant)/0.72)] bg-[hsl(var(--surface-container)/0.9)] px-4 py-3 text-sm">
          <Button size="sm" variant="outline" onClick={toggleAll}>
            {allSelected ? "取消全选" : "全选"}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleDownload()}
            disabled={!selectedIds.length || downloading}
          >
            <Download className="h-4 w-4" />
            {downloading ? "打包中..." : `下载所选${selectedIds.length ? ` (${selectedIds.length})` : ""}`}
          </Button>
          {selectedIds.length ? (
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
              清空选择
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            文件名按「日期 + 哈希前几位」生成
          </span>
        </div>
      ) : null}

      {error || downloadError ? (
        <Card className="border-destructive/30 bg-destructive/10">
          <CardContent className="p-5 text-sm text-destructive">
            {error ?? downloadError}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          <div className="rounded-xl border border-[hsl(var(--outline-variant)/0.72)] bg-[hsl(var(--surface-container)/0.9)] p-4 text-sm text-muted-foreground">
            正在加载作品库...
          </div>
        ) : null}
        {!loading && !visibleItems.length ? (
          <div className="rounded-xl border border-[hsl(var(--outline-variant)/0.72)] bg-[hsl(var(--surface-container)/0.9)] p-4 text-sm text-muted-foreground">
            作品库为空，生成成功的作品会出现在这里。
          </div>
        ) : null}

        {visibleItems.map((item) => (
          <LibraryItemCard
            key={item.asset.id}
            item={item}
            deleting={deletingSet.has(item.asset.id)}
            onEditAsset={(asset) =>
              navigate(`/create?fromTaskId=${item.task.id}&assetId=${asset.id}&mode=edit`)
            }
            selected={collectAssetIds(item).every((id) => selectedSet.has(id))}
            onSelectedChange={toggleItem}
            actions={
              <>
                {item.conversation?.id ? (
                  <Button size="sm" variant="outline" onClick={() => navigate(`/workspace/${item.conversation?.id}`)}>
                    查看来源
                  </Button>
                ) : null}
                {item.task.batch?.isBatch ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigate(`/create?fromTaskId=${item.task.id}&mode=edit`)}
                  >
                    继续创作
                  </Button>
                )}
                {item.task.batch?.isBatch ? null : (
                  <Button size="sm" onClick={() => navigate(`/create?fromTaskId=${item.task.id}&mode=variant&fork=1`)}>
                    Fork
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleDelete(item)}
                  disabled={deletingSet.has(item.asset.id)}
                >
                  <Trash2 className="h-4 w-4" />
                  删除
                </Button>
              </>
            }
          />
        ))}

        {data?.nextCursor ? (
          <div className="flex justify-center md:col-span-2 xl:col-span-3">
            <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "加载中..." : "加载更多"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
