import { useState } from "react";
import { Download, ExternalLink, Image as ImageIcon, Pencil, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { resolveAssetUrl } from "@/lib/api-mappers";
import type { UiTask, UiTaskAsset } from "@/lib/api-types";
import { useBatchDownload } from "@/lib/use-batch-download";

export function BatchResultModal({
  task,
  open,
  onClose,
  onEditAsset,
  onDeleteAssets,
}: {
  task: UiTask;
  open: boolean;
  onClose: () => void;
  onEditAsset?: (asset: UiTaskAsset) => void;
  /** 批量结果内删除勾选的图片；不传则不显示勾选与删除入口。 */
  onDeleteAssets?: (ids: string[]) => Promise<void>;
}) {
  const [previewAsset, setPreviewAsset] = useState<{
    asset: UiTaskAsset;
    url: string;
  } | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const { download, downloading } = useBatchDownload();

  if (!open) {
    return null;
  }

  const removedSet = new Set(removedIds);
  const slotsWithAssets = (task.batchSlots ?? [])
    .filter(
      (slot) =>
        slot.status === "succeeded" && slot.asset && !removedSet.has(slot.asset.id),
    )
    .sort((left, right) => left.batchIndex - right.batchIndex);
  const successfulSlots =
    slotsWithAssets.length > 0
      ? slotsWithAssets
      : (task.resultAssets ?? []).filter((asset) => !removedSet.has(asset.id)).map((asset, index) => ({
          id: `${task.id}-${asset.id}`,
          taskId: task.id,
          batchIndex: index,
          status: "succeeded" as const,
          progress: 100,
          asset,
          attempt: 1,
        }));

  const toggleSelected = (assetId: string, selected: boolean) => {
    setSelectedIds((current) =>
      selected
        ? [...new Set([...current, assetId])]
        : current.filter((id) => id !== assetId),
    );
  };

  const handleDeleteSelected = async () => {
    if (!onDeleteAssets || selectedIds.length === 0 || deleting) {
      return;
    }
    if (!window.confirm(`删除选中的 ${selectedIds.length} 张图片？删除后不可恢复。`)) {
      return;
    }

    setDeleting(true);
    try {
      await onDeleteAssets(selectedIds);
      setRemovedIds((current) => [...new Set([...current, ...selectedIds])]);
      setSelectedIds([]);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="批量结果"
      onClick={onClose}
      data-testid="batch-result-modal"
    >
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">批量结果</p>
            <p className="text-xs text-muted-foreground">
              成功 {task.batch?.successCount ?? successfulSlots.length} / 共 {task.batch?.batchSize ?? successfulSlots.length} 个
            </p>
          </div>
          <div className="flex items-center gap-2">
            {onDeleteAssets ? (
              <Button
                size="sm"
                variant="outline"
                disabled={deleting || selectedIds.length === 0}
                onClick={() => void handleDeleteSelected()}
              >
                <Trash2 className="h-4 w-4" />
                {deleting ? "删除中..." : `删除选中 (${selectedIds.length})`}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={downloading || successfulSlots.length === 0}
              onClick={() =>
                void download(successfulSlots.map((slot) => slot.asset?.id ?? ""))
              }
            >
              <Download className="h-4 w-4" />
              {downloading ? "打包中..." : `下载全部 (${successfulSlots.length})`}
            </Button>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-white/10 text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
              aria-label="关闭批量结果"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 overflow-auto p-4">
          {successfulSlots.length === 0 ? (
            <div className="rounded-xl border border-[hsl(var(--outline-variant)/0.72)] bg-[hsl(var(--surface-container)/0.9)] p-4 text-sm text-muted-foreground">
              当前批量任务还没有成功图片。
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {successfulSlots.map((slot) => {
              const asset = slot.asset;
              if (!asset) {
                return null;
              }

              const assetUrl = resolveAssetUrl(asset.url, asset.storageKey);

              return (
                <div
                  key={slot.id}
                  className="overflow-hidden rounded-xl border border-[hsl(var(--outline-variant)/0.72)] bg-[hsl(var(--surface-container)/0.9)]"
                >
                  <div className="relative aspect-[4/3] bg-[hsl(var(--surface-container-lowest))]">
                    {onDeleteAssets ? (
                      <label className="absolute left-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/20 bg-black/60">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-sky-400"
                          aria-label={`选择批量结果 ${slot.batchIndex + 1}`}
                          checked={selectedIds.includes(asset.id)}
                          onChange={(event) =>
                            toggleSelected(asset.id, event.target.checked)
                          }
                        />
                      </label>
                    ) : null}
                    {assetUrl ? (
                      <button
                        type="button"
                        className="block h-full w-full"
                        aria-label={`预览批量结果 ${slot.batchIndex + 1}`}
                        onClick={() => setPreviewAsset({ asset, url: assetUrl })}
                      >
                        <img
                          src={assetUrl}
                          alt={`批量结果 ${slot.batchIndex + 1}`}
                          className="h-full w-full object-cover"
                        />
                      </button>
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <ImageIcon className="h-6 w-6 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="space-y-3 p-3">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium text-foreground">#{slot.batchIndex + 1}</span>
                      <span className="text-muted-foreground">{asset.mimeType ?? asset.type}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {onEditAsset ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onEditAsset(asset)}
                        >
                          <Pencil className="h-4 w-4" />
                          再编辑
                        </Button>
                      ) : null}
                      {assetUrl ? (
                        <>
                          <Button size="sm" variant="outline" asChild>
                            <a href={assetUrl} download rel="noreferrer">
                              <Download className="h-4 w-4" />
                              下载
                            </a>
                          </Button>
                          <Button size="sm" variant="ghost" asChild>
                            <a href={assetUrl} target="_blank" rel="noreferrer">
                              <ExternalLink className="h-4 w-4" />
                              原图
                            </a>
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {previewAsset ? (
        <ImageLightbox
          imageUrl={previewAsset.url}
          label={previewAsset.asset.label}
          onClose={() => setPreviewAsset(null)}
          testId="batch-asset-lightbox"
          zIndexClassName="z-[60]"
        />
      ) : null}
    </div>
  );
}
