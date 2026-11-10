import type { ReactNode } from "react";
import { useState } from "react";
import { Download, FolderGit2, Image as ImageIcon } from "lucide-react";

import { BatchResultModal } from "@/components/cards/batch-result-modal";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  formatRelativeTime,
  isLibraryItemDisplayable,
  resolveAssetUrl,
  toUiTask,
} from "@/lib/api-mappers";
import type { LibraryItemRecord, UiTaskAsset } from "@/lib/api-types";

export function LibraryItemCard({
  item,
  actions,
  deleting = false,
  onEditAsset,
  onDeleteAssets,
  selected = false,
  onSelectedChange,
}: {
  item: LibraryItemRecord;
  actions?: ReactNode;
  deleting?: boolean;
  onEditAsset?: (asset: UiTaskAsset) => void;
  /** 批量结果内删除勾选图片；不传则不显示删除入口。 */
  onDeleteAssets?: (ids: string[]) => Promise<void>;
  /** 批量下载多选状态；传入 onSelectedChange 时才渲染勾选框。 */
  selected?: boolean;
  onSelectedChange?: (item: LibraryItemRecord, selected: boolean) => void;
}) {
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);

  if (!isLibraryItemDisplayable(item)) {
    return null;
  }

  const assetUrl = resolveAssetUrl(item.asset.url, item.asset.storageKey);
  const isBatch = item.kind === "batch" || Boolean(item.task.batch?.isBatch);
  const assets = item.assets?.length ? item.assets : [item.asset];
  const uiTask = toUiTask(item.task, assets);

  return (
    <>
      <Card className={cn("overflow-hidden", selected && "ring-2 ring-primary")}>
        {onSelectedChange ? (
          <label className="flex cursor-pointer items-center gap-2 border-b border-[hsl(var(--outline-variant)/0.72)] px-4 py-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[hsl(var(--primary))]"
              checked={selected}
              onChange={(event) => onSelectedChange(item, event.target.checked)}
            />
            加入下载清单
          </label>
        ) : null}
        <button
          type="button"
          className="relative block aspect-[4/3] w-full overflow-hidden border-b border-[hsl(var(--outline-variant)/0.72)] bg-[hsl(var(--surface-container-lowest))] text-left"
          onClick={() => (isBatch ? setIsBatchModalOpen(true) : undefined)}
          aria-label={isBatch ? "打开批量作品" : "预览作品"}
        >
          {isBatch ? (
            <div className="grid h-full w-full grid-cols-2 gap-1 p-1">
              {assets.slice(0, 4).map((asset) => {
                const url = resolveAssetUrl(asset.url, asset.storageKey);

                return url ? (
                  <img
                    key={asset.id}
                    src={url}
                    alt={item.task.prompt}
                    className="h-full w-full rounded-md object-cover"
                  />
                ) : (
                  <div key={asset.id} className="flex h-full items-center justify-center rounded-md bg-[hsl(var(--surface-container-low))]">
                    <ImageIcon className="h-5 w-5 text-muted-foreground" />
                  </div>
                );
              })}
            </div>
          ) : assetUrl ? (
          <img src={assetUrl} alt={item.task.prompt} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <ImageIcon className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        </button>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{item.task.capability}</Badge>
              <Badge variant="outline">{item.task.modelId}</Badge>
              {isBatch ? <Badge variant="outline">批量 x{item.task.batch?.batchSize ?? assets.length}</Badge> : null}
              {item.task.sourceAction ? <Badge variant="outline">{item.task.sourceAction}</Badge> : null}
            </div>
            <h3 className="line-clamp-2 text-sm font-medium text-foreground">{item.task.prompt || "未命名作品"}</h3>
            <p className="text-xs text-muted-foreground">
              {item.conversation?.title ?? item.task.conversationTitle ?? "未命名会话"} · {formatRelativeTime(item.asset.createdAt)}
            </p>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-[hsl(var(--outline-variant)/0.72)] bg-[hsl(var(--surface-container)/0.9)] px-3 py-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <FolderGit2 className="h-3.5 w-3.5" />
              {item.task.id}
            </span>
            <span>
              {isBatch
                ? `成功 ${item.task.batch?.successCount ?? assets.length} / 失败 ${item.task.batch?.failedCount ?? 0}`
                : item.asset.width && item.asset.height
                  ? `${item.asset.width} × ${item.asset.height}`
                  : item.asset.mimeType ?? "image"}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {isBatch ? (
              <Button variant="outline" size="sm" onClick={() => setIsBatchModalOpen(true)}>
                打开批量结果
              </Button>
            ) : assetUrl ? (
              <Button variant="outline" size="sm" asChild>
                <a href={assetUrl} download rel="noreferrer">
                  <Download className="h-4 w-4" />
                  下载
                </a>
              </Button>
            ) : null}
            {actions}
            {deleting ? <Badge variant="outline">删除中...</Badge> : null}
          </div>
        </CardContent>
      </Card>
      <BatchResultModal
        task={uiTask}
        open={isBatchModalOpen}
        onClose={() => setIsBatchModalOpen(false)}
        onEditAsset={
          onEditAsset
            ? (asset) => {
                setIsBatchModalOpen(false);
                onEditAsset(asset);
              }
            : undefined
        }
        onDeleteAssets={onDeleteAssets}
      />
    </>
  );
}
