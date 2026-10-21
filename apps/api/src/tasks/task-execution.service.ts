import { Injectable, Logger } from "@nestjs/common";
import {
  Prisma,
  type Asset,
  type Task,
  type TaskBatchItem,
} from "@prisma/client";
import type { TaskStatus } from "@yunwu/shared";
import { randomUUID } from "node:crypto";
import { AssetStorageService } from "../api/storage/asset-storage.service";
import { downloadUpstreamImage } from "../api/storage/upstream-image-download";
import { ConversationEventsService } from "../api/conversation-events.service";
import { ImageProviderService } from "../openai-compatible/image-provider.service";
import { UserProviderCredentialsService } from "../openai-compatible/user-provider-credentials.service";
import { type ProviderRouteId } from "../openai-compatible/provider-route-registry";
import { OpenAICompatibleRequestError } from "../openai-compatible/openai-compatible.service";
import { ProviderAlertsService } from "../openai-compatible/provider-alerts.service";
import { ProviderOperationalStateService } from "../openai-compatible/provider-operational-state.service";
import { PrismaService } from "../prisma/prisma.service";
import { TaskEventsService } from "./task-events.service";

type SupportedTaskCapability = "image.generate" | "image.edit";

interface TaskInputShape {
  model?: string;
  prompt?: string;
  assetIds?: string[];
  params?: Record<string, unknown>;
  providerBaseUrl?: string;
  providerRouteId?: ProviderRouteId;
  batchCount?: number;
}

interface GeneratedOutputLocation {
  storageKey?: string;
  url: string;
  storage: {
    kind: "local" | "s3" | "remote-url";
    objectUrl?: string;
    downloadError?: string;
  };
}

type BatchParentTask = Task & {
  assets: Asset[];
  batchItems: TaskBatchItem[];
};

type BatchExecutionContext = {
  capability: SupportedTaskCapability;
  input: TaskInputShape;
  orderedInputAssets: Asset[];
  providerApiKey?: string;
  inputAssetIds: string[];
};

@Injectable()
export class TaskExecutionService {
  private readonly logger = new Logger(TaskExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly imageProvider: ImageProviderService,
    private readonly providerCredentials: UserProviderCredentialsService,
    private readonly providerState: ProviderOperationalStateService,
    private readonly providerAlerts: ProviderAlertsService,
    private readonly conversationEvents: ConversationEventsService,
    private readonly taskEvents: TaskEventsService,
    private readonly assetStorage: AssetStorageService,
  ) {}

  async execute(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        conversation: true,
        assets: true,
        batchItems: { orderBy: { batchIndex: "asc" } },
      },
    });

    if (!task || !task.conversationId || !task.userId || !task.conversation) {
      return;
    }

    if (this.isTerminalStatus(task.status)) {
      return;
    }

    const input = this.asRecord(task.input) as TaskInputShape;
    if ((input.batchCount ?? 1) > 1 || (task.batchItems?.length ?? 0) > 0) {
      await this.executeBatchTask(task.id);
      return;
    }

    const capability = this.asSupportedCapability(task.type);

    await this.prisma.task.update({
      where: { id: task.id },
      data: {
        status: "submitted",
        progress: Math.max(task.progress, 20),
        errorMessage: null,
      },
    });
    await this.recordTaskEvent(task.id, "submitted", "submitted", {
      summary: "Task submitted.",
      title: "Task submitted",
      detail: "A worker accepted the task and is preparing the image request.",
      progress: Math.max(task.progress, 20),
    });
    this.publishTaskUpdated(task.conversationId, task.id, "submitted");

    try {
      const inputAssets = input.assetIds?.length
        ? await this.prisma.asset.findMany({
            where: {
              id: { in: input.assetIds },
              userId: task.userId,
              status: { in: ["ready", "deleted"] },
              type: { in: ["upload", "generated"] },
            },
          })
        : [];
      const inputAssetsById = new Map(
        inputAssets.map((asset) => [asset.id, asset]),
      );
      const orderedInputAssets = (input.assetIds ?? [])
        .map((assetId) => inputAssetsById.get(assetId))
        .filter((asset): asset is Asset => Boolean(asset));

      await this.prisma.task.update({
        where: { id: task.id },
        data: {
          status: "running",
          progress: 60,
        },
      });
      await this.recordTaskEvent(task.id, "running", "running", {
        summary: "Task running.",
        title: "Task running",
        detail: "The image request is running.",
        progress: 60,
      });
      this.publishTaskUpdated(task.conversationId, task.id, "running");

      const providerRouteId = input.providerRouteId;
      if (!providerRouteId) {
        throw new Error("Legacy task has no provider route. Create a new task from current settings.");
      }
      const baseConfig = await this.imageProvider.getBaseConfig(providerRouteId);
      const providerApiKey = await this.providerCredentials.getSecretForExecution(
        task.userId,
        providerRouteId,
      );
      const requestSummary = this.buildProviderRequestSummary(
        {
          ...baseConfig,
          hasApiKey: Boolean(providerApiKey) || baseConfig.hasApiKey,
        },
        capability,
        input,
        orderedInputAssets,
      );
      await this.recordTaskEvent(task.id, "provider.request", "running", {
        summary: "Sanitized upstream request summary recorded.",
        details: requestSummary,
      });

      const result = await this.imageProvider.createImageTask(providerRouteId, {
        capability,
        model: input.model ?? "gpt-image-1",
        prompt: input.prompt ?? "",
        baseUrl: input.providerBaseUrl,
        apiKey: providerApiKey,
        allowMock: false,
        inputAssets: orderedInputAssets.map((asset) => ({
          id: asset.id,
          url: asset.url,
          mimeType: asset.mimeType,
          storageKey: asset.storageKey,
        })),
        params: input.params,
      });
      await this.recordTaskEvent(task.id, "provider.response", "running", {
        summary: "Sanitized upstream response summary recorded.",
        details: result.responseSummary,
      });

      const storedOutput = await this.storeGeneratedOutput(task.id, result);
      const asset = await this.prisma.asset.create({
        data: {
          userId: task.userId,
          taskId: task.id,
          type: "generated",
          mimeType: result.mimeType,
          storageKey: storedOutput.storageKey,
          url: storedOutput.url,
          status: "ready",
          metadata: {
            width: result.width,
            height: result.height,
            mocked: result.mocked,
            provider: this.imageProvider.providerId,
            responseSummary: result.responseSummary,
            storage: storedOutput.storage.kind,
            ...(storedOutput.storage.objectUrl
              ? { objectUrl: storedOutput.storage.objectUrl }
              : {}),
          } as Prisma.InputJsonObject,
        },
      });

      await this.prisma.task.update({
        where: { id: task.id },
        data: {
          status: "succeeded",
          progress: 100,
          output: {
            assetIds: [asset.id],
            inputAssetIds: orderedInputAssets.map((item) => item.id),
            mocked: result.mocked,
          },
        },
      });
      await this.recordTaskEvent(task.id, "succeeded", "succeeded", {
        summary: "Task completed.",
        title: "Task completed",
        detail: "The image task completed successfully.",
        progress: 100,
        assetIds: [asset.id],
        details: {
          mocked: result.mocked,
        },
      });

      await this.prisma.message.create({
        data: {
          conversationId: task.conversationId,
          role: "assistant",
          content: "Image task completed.",
          metadata: {
            type: "image_result",
            taskId: task.id,
            assetIds: [asset.id],
            inputAssetIds: orderedInputAssets.map((item) => item.id),
          },
        },
      });
      await this.providerState.persistTestFinished({
        taskId: task.id,
        status: "succeeded",
      });
      await this.providerAlerts.refreshAlerts(await this.providerState.getState());
      this.publishTaskUpdated(task.conversationId, task.id, "succeeded");
    } catch (error) {
      const failure = this.buildFailureSummary(error);
      if (error instanceof OpenAICompatibleRequestError) {
        await this.recordTaskEvent(task.id, "provider.response", "running", {
          summary: "Sanitized upstream failure summary recorded.",
          details: this.sanitizeProviderResponseSummary(error.responseSummary),
        });
      }

      await this.prisma.task.update({
        where: { id: task.id },
        data: {
          status: "failed",
          progress: 100,
          errorMessage: failure.errorMessage,
        },
      });
      await this.recordTaskEvent(task.id, "failed", "failed", {
        summary: "Task failed.",
        title: failure.title,
        detail: failure.detail,
        errorMessage: failure.errorMessage,
        progress: 100,
        details: {
          category: failure.category,
          retryable: failure.retryable,
          statusCode: failure.statusCode,
          errorStage: failure.errorStage,
          errorKind: failure.errorKind,
        },
      });

      await this.prisma.message.create({
        data: {
          conversationId: task.conversationId,
          role: "assistant",
          content: failure.errorMessage,
          metadata: { type: "error_card", taskId: task.id },
        },
      });
      await this.providerState.persistTestFinished({
        taskId: task.id,
        status: "failed",
        error: failure.errorMessage,
      });
      await this.providerAlerts.refreshAlerts(await this.providerState.getState());
      this.publishTaskUpdated(task.conversationId, task.id, "failed");

      this.logger.error(`Task ${task.id} failed: ${failure.errorMessage}`);
    }
  }

  private async executeBatchTask(taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        conversation: true,
        assets: true,
        batchItems: { orderBy: { batchIndex: "asc" } },
      },
    });

    if (!task || !task.conversationId || !task.userId || !task.conversation) {
      return;
    }

    if (this.isTerminalStatus(task.status)) {
      return;
    }

    const input = this.asRecord(task.input) as TaskInputShape;
    const capability = this.asSupportedCapability(task.type);
    const targetItems = task.batchItems.filter((item) =>
      ["queued", "submitted", "running"].includes(item.status),
    );

    if (targetItems.length === 0) {
      return;
    }

    await this.prisma.task.update({
      where: { id: task.id },
      data: {
        status: "submitted",
        progress: Math.max(task.progress, 20),
        errorMessage: null,
      },
    });
    await this.recordTaskEvent(task.id, "batch.submitted", "submitted", {
      summary: "Batch task submitted.",
      title: "Batch submitted",
      detail: "A worker accepted the batch task and is preparing all slots.",
      progress: Math.max(task.progress, 20),
    });
    this.publishTaskUpdated(task.conversationId, task.id, "submitted");

    let inputAssetIds: string[] = [];
    try {
      const inputAssets = input.assetIds?.length
        ? await this.prisma.asset.findMany({
            where: {
              id: { in: input.assetIds },
              userId: task.userId,
              status: { in: ["ready", "deleted"] },
              type: { in: ["upload", "generated"] },
            },
          })
        : [];
      const inputAssetsById = new Map(
        inputAssets.map((asset) => [asset.id, asset]),
      );
      const orderedInputAssets = (input.assetIds ?? [])
        .map((assetId) => inputAssetsById.get(assetId))
        .filter((asset): asset is Asset => Boolean(asset));
      inputAssetIds = orderedInputAssets.map((asset) => asset.id);

      await this.prisma.taskBatchItem.updateMany({
        where: {
          taskId: task.id,
          id: { in: targetItems.map((item) => item.id) },
        },
        data: {
          status: "running",
          progress: 20,
          errorMessage: null,
          startedAt: new Date(),
          completedAt: null,
          attempt: { increment: 1 },
        },
      });
      await this.prisma.task.update({
        where: { id: task.id },
        data: {
          status: "running",
          progress: 20,
          output: {
            ...this.asRecord(task.output),
            ...this.buildPersistedBatchSummary(
              await this.prisma.taskBatchItem.findMany({
                where: { taskId: task.id },
                orderBy: { batchIndex: "asc" },
              }),
            ),
            inputAssetIds,
          } as Prisma.InputJsonObject,
        },
      });
      await this.recordTaskEvent(task.id, "batch.running", "running", {
        summary: "Batch task running.",
        title: "Batch running",
        detail: `Running ${targetItems.length} batch slot(s) concurrently.`,
        progress: 20,
      });
      this.publishTaskUpdated(task.conversationId, task.id, "running");

      const providerRouteId = input.providerRouteId;
      if (!providerRouteId) {
        throw new Error("Legacy task has no provider route. Create a new task from current settings.");
      }
      const baseConfig = await this.imageProvider.getBaseConfig(providerRouteId);
      const providerApiKey = await this.providerCredentials.getSecretForExecution(
        task.userId,
        providerRouteId,
      );
      const requestSummary = this.buildProviderRequestSummary(
        {
          ...baseConfig,
          hasApiKey: Boolean(providerApiKey) || baseConfig.hasApiKey,
        },
        capability,
        input,
        orderedInputAssets,
      );
      await this.recordTaskEvent(task.id, "batch.provider.request", "running", {
        summary: "Sanitized upstream batch request summary recorded.",
        details: {
          ...requestSummary,
          batchSize: task.batchItems.length,
          targetSlotCount: targetItems.length,
        },
      });

      const context: BatchExecutionContext = {
        capability,
        input,
        orderedInputAssets,
        providerApiKey,
        inputAssetIds,
      };
      await Promise.allSettled(
        targetItems.map((item) =>
          this.executeBatchItem(task, item, context),
        ),
      );

      const finalItems = await this.prisma.taskBatchItem.findMany({
        where: { taskId: task.id },
        orderBy: { batchIndex: "asc" },
      });
      const summary = this.buildPersistedBatchSummary(finalItems);
      const finalStatus: TaskStatus =
        summary.successCount > 0 ? "succeeded" : "failed";
      const firstFailureMessage =
        typeof summary.firstFailureMessage === "string"
          ? summary.firstFailureMessage
          : undefined;

      await this.prisma.task.update({
        where: { id: task.id },
        data: {
          status: finalStatus,
          progress: 100,
          errorMessage:
            finalStatus === "failed"
              ? firstFailureMessage ?? "All batch slots failed."
              : null,
          output: {
            ...this.asRecord(task.output),
            ...summary,
            inputAssetIds: context.inputAssetIds,
            completedAt: new Date().toISOString(),
          } as Prisma.InputJsonObject,
        },
      });
      await this.recordTaskEvent(
        task.id,
        finalStatus === "succeeded" ? "batch.succeeded" : "batch.failed",
        finalStatus,
        {
          summary:
            finalStatus === "succeeded"
              ? "Batch task completed."
              : "Batch task failed.",
          title:
            finalStatus === "succeeded"
              ? summary.failedCount > 0
                ? "Batch partially completed"
                : "Batch completed"
              : "Batch failed",
          detail:
            finalStatus === "succeeded"
              ? `Batch completed with ${summary.successCount} success(es) and ${summary.failedCount} failure(s).`
              : "Every batch slot failed.",
          progress: 100,
          assetIds: summary.assetIds,
          details: summary,
          errorMessage:
            finalStatus === "failed" ? firstFailureMessage : undefined,
        },
      );

      await this.prisma.message.create({
        data: {
          conversationId: task.conversationId,
          role: "assistant",
          content:
            finalStatus === "succeeded"
              ? "Batch image task completed."
              : (firstFailureMessage ?? "Batch image task failed."),
          metadata: {
            type: finalStatus === "succeeded" ? "image_grid" : "error_card",
            taskId: task.id,
            assetIds: summary.assetIds,
            inputAssetIds: context.inputAssetIds,
            batch: summary,
          },
        },
      });
      await this.providerState.persistTestFinished({
        taskId: task.id,
        status: finalStatus,
        ...(finalStatus === "failed" && firstFailureMessage
          ? { error: firstFailureMessage }
          : {}),
      });
      await this.providerAlerts.refreshAlerts(await this.providerState.getState());
      this.publishTaskUpdated(task.conversationId, task.id, finalStatus);
    } catch (error) {
      const failure = this.buildFailureSummary(error);
      let summary:
        | ReturnType<TaskExecutionService["buildPersistedBatchSummary"]>
        | undefined;

      try {
        await this.prisma.taskBatchItem.updateMany({
          where: {
            taskId: task.id,
            id: { in: targetItems.map((item) => item.id) },
            status: { in: ["queued", "submitted", "running"] },
          },
          data: {
            status: "failed",
            progress: 100,
            assetId: null,
            errorMessage: failure.errorMessage,
            output: {
              errorMessage: failure.errorMessage,
              category: failure.category,
              retryable: failure.retryable,
              statusCode: failure.statusCode,
            } as Prisma.InputJsonObject,
            completedAt: new Date(),
          },
        });

        summary = this.buildPersistedBatchSummary(
          await this.prisma.taskBatchItem.findMany({
            where: { taskId: task.id },
            orderBy: { batchIndex: "asc" },
          }),
        );
      } catch (batchItemError) {
        const message =
          batchItemError instanceof Error
            ? batchItemError.message
            : "Unknown batch item update error.";
        this.logger.warn(
          `Failed to mark batch slots for task ${task.id}: ${message}`,
        );
      }

      const finalStatus: TaskStatus =
        summary && summary.successCount > 0 ? "succeeded" : "failed";
      await this.prisma.task.update({
        where: { id: task.id },
        data: {
          status: finalStatus,
          progress: 100,
          errorMessage:
            finalStatus === "failed" ? failure.errorMessage : null,
          ...(summary
            ? {
                output: {
                  ...this.asRecord(task.output),
                  ...summary,
                  inputAssetIds,
                  completedAt: new Date().toISOString(),
                } as Prisma.InputJsonObject,
              }
            : {}),
        },
      });
      await this.recordTaskEvent(
        task.id,
        finalStatus === "succeeded" ? "batch.succeeded" : "batch.failed",
        finalStatus,
        {
          summary:
            finalStatus === "succeeded"
              ? "Batch task completed."
              : "Batch task failed.",
          title:
            finalStatus === "succeeded"
              ? summary?.failedCount
                ? "Batch partially completed"
                : "Batch completed"
              : failure.title,
          detail:
            finalStatus === "succeeded" && summary
              ? `Batch completed with ${summary.successCount} success(es) and ${summary.failedCount} failure(s).`
              : failure.detail,
          errorMessage:
            finalStatus === "failed" ? failure.errorMessage : undefined,
          progress: 100,
          assetIds: summary?.assetIds,
          details: {
            ...(summary ?? {}),
            category: failure.category,
            retryable: failure.retryable,
            statusCode: failure.statusCode,
            errorStage: failure.errorStage,
            errorKind: failure.errorKind,
          },
        },
      );
      await this.prisma.message.create({
        data: {
          conversationId: task.conversationId,
          role: "assistant",
          content:
            finalStatus === "succeeded"
              ? "Batch image task completed."
              : failure.errorMessage,
          metadata: {
            type: finalStatus === "succeeded" ? "image_grid" : "error_card",
            taskId: task.id,
            inputAssetIds,
            ...(summary
              ? { assetIds: summary.assetIds, batch: summary }
              : {}),
          },
        },
      });
      await this.providerState.persistTestFinished({
        taskId: task.id,
        status: finalStatus,
        ...(finalStatus === "failed" ? { error: failure.errorMessage } : {}),
      });
      await this.providerAlerts.refreshAlerts(await this.providerState.getState());
      this.publishTaskUpdated(task.conversationId, task.id, finalStatus);
      this.logger.error(`Batch task ${task.id} failed: ${failure.errorMessage}`);
    }
  }

  private async executeBatchItem(
    task: BatchParentTask,
    item: TaskBatchItem,
    context: BatchExecutionContext,
  ) {
    try {
      const providerRouteId = context.input.providerRouteId;
      if (!providerRouteId) {
        throw new Error("Legacy task has no provider route. Create a new task from current settings.");
      }
      const result = await this.imageProvider.createImageTask(providerRouteId, {
        capability: context.capability,
        model: context.input.model ?? "gpt-image-1",
        prompt: context.input.prompt ?? "",
        baseUrl: undefined,
        apiKey: context.providerApiKey,
        allowMock: false,
        inputAssets: context.orderedInputAssets.map((asset) => ({
          id: asset.id,
          url: asset.url,
          mimeType: asset.mimeType,
          storageKey: asset.storageKey,
        })),
        params: context.input.params,
      });
      const storedOutput = await this.storeGeneratedOutput(task.id, result);
      const asset = await this.prisma.asset.create({
        data: {
          userId: task.userId,
          taskId: task.id,
          type: "generated",
          mimeType: result.mimeType,
          storageKey: storedOutput.storageKey,
          url: storedOutput.url,
          status: "ready",
          metadata: {
            batchTaskId: task.id,
            batchItemId: item.id,
            batchIndex: item.batchIndex,
            width: result.width,
            height: result.height,
            mocked: result.mocked,
            provider: this.imageProvider.providerId,
            responseSummary: result.responseSummary,
            storage: storedOutput.storage.kind,
            ...(storedOutput.storage.objectUrl
              ? { objectUrl: storedOutput.storage.objectUrl }
              : {}),
          } as Prisma.InputJsonObject,
        },
      });

      await this.prisma.taskBatchItem.update({
        where: { id: item.id },
        data: {
          status: "succeeded",
          progress: 100,
          assetId: asset.id,
          errorMessage: null,
          providerSummary: result.responseSummary as Prisma.InputJsonObject,
          output: {
            assetId: asset.id,
            mocked: result.mocked,
            width: result.width,
            height: result.height,
          } as Prisma.InputJsonObject,
          completedAt: new Date(),
        },
      });
      const summary = await this.refreshBatchParentSummary(
        task.id,
        context.inputAssetIds,
      );
      await this.recordTaskEvent(task.id, "batch.item.succeeded", "running", {
        summary: `Batch item ${item.batchIndex + 1} completed.`,
        title: "Batch item completed",
        detail: `Slot ${item.batchIndex + 1} completed successfully.`,
        progress: this.progressForBatchSummary(summary),
        assetIds: [asset.id],
        details: {
          batchIndex: item.batchIndex,
          batchItemId: item.id,
          assetId: asset.id,
          mocked: result.mocked,
        },
      });
      if (task.conversationId) {
        this.publishTaskUpdated(task.conversationId, task.id, "running");
      }
    } catch (error) {
      const failure = this.buildFailureSummary(error);
      const providerSummary =
        error instanceof OpenAICompatibleRequestError
          ? this.sanitizeProviderResponseSummary(error.responseSummary)
          : undefined;

      await this.prisma.taskBatchItem.update({
        where: { id: item.id },
        data: {
          status: "failed",
          progress: 100,
          assetId: null,
          errorMessage: failure.errorMessage,
          providerSummary: providerSummary
            ? (providerSummary as Prisma.InputJsonObject)
            : Prisma.JsonNull,
          output: {
            errorMessage: failure.errorMessage,
            category: failure.category,
            retryable: failure.retryable,
            statusCode: failure.statusCode,
          } as Prisma.InputJsonObject,
          completedAt: new Date(),
        },
      });
      const summary = await this.refreshBatchParentSummary(
        task.id,
        context.inputAssetIds,
      );
      await this.recordTaskEvent(task.id, "batch.item.failed", "running", {
        summary: `Batch item ${item.batchIndex + 1} failed.`,
        title: failure.title,
        detail: failure.detail,
        errorMessage: failure.errorMessage,
        progress: this.progressForBatchSummary(summary),
        details: {
          batchIndex: item.batchIndex,
          batchItemId: item.id,
          category: failure.category,
          retryable: failure.retryable,
          statusCode: failure.statusCode,
          errorStage: failure.errorStage,
          errorKind: failure.errorKind,
        },
      });
      if (task.conversationId) {
        this.publishTaskUpdated(task.conversationId, task.id, "running");
      }
      this.logger.warn(
        `Batch task ${task.id} slot ${item.batchIndex} failed: ${failure.errorMessage}`,
      );
    }
  }

  private async refreshBatchParentSummary(
    taskId: string,
    inputAssetIds: string[],
  ) {
    const [task, items] = await Promise.all([
      this.prisma.task.findUnique({
        where: { id: taskId },
        select: { output: true },
      }),
      this.prisma.taskBatchItem.findMany({
        where: { taskId },
        orderBy: { batchIndex: "asc" },
      }),
    ]);
    const summary = this.buildPersistedBatchSummary(items);

    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        progress: this.progressForBatchSummary(summary),
        output: {
          ...this.asRecord(task?.output),
          ...summary,
          inputAssetIds,
        } as Prisma.InputJsonObject,
      },
    });

    return summary;
  }

  private buildPersistedBatchSummary(items: TaskBatchItem[]) {
    const orderedItems = items
      .slice()
      .sort((left, right) => left.batchIndex - right.batchIndex);
    const successItems = orderedItems.filter(
      (item) => item.status === "succeeded",
    );
    const failedItems = orderedItems.filter((item) => item.status === "failed");
    const returnedCount = successItems.length + failedItems.length;
    const firstFailureMessage = failedItems.find(
      (item) => item.errorMessage,
    )?.errorMessage;

    return {
      batchSize: orderedItems.length,
      returnedCount,
      successCount: successItems.length,
      failedCount: failedItems.length,
      loadingCount: Math.max(0, orderedItems.length - returnedCount),
      assetIds: successItems
        .map((item) => item.assetId)
        .filter((assetId): assetId is string => Boolean(assetId)),
      ...(firstFailureMessage ? { firstFailureMessage } : {}),
      partialSuccess: successItems.length > 0 && failedItems.length > 0,
    };
  }

  private progressForBatchSummary(summary: {
    batchSize: number;
    returnedCount: number;
  }) {
    if (summary.batchSize <= 0) {
      return 0;
    }

    if (summary.returnedCount >= summary.batchSize) {
      return 100;
    }

    return 20 + Math.round((summary.returnedCount / summary.batchSize) * 75);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private asSupportedCapability(value: string): SupportedTaskCapability {
    return value === "image.edit" ? "image.edit" : "image.generate";
  }

  private async storeGeneratedOutput(
    taskId: string,
    result: {
      url: string;
      mimeType?: string;
    },
  ): Promise<GeneratedOutputLocation> {
    const mimeType = result.mimeType ?? this.mimeTypeFromDataUrl(result.url) ?? "image/png";
    const storageKey = `${Date.now()}-${taskId}-${randomUUID()}.${this.extensionFromMimeType(
      mimeType,
    )}`;

    try {
      const buffer = await this.readImageResultBuffer(result.url);
      const storage = await this.assetStorage.store({
        buffer,
        storageKey,
        mimeType,
      });

      return {
        storageKey,
        storage,
        url: this.assetStorage.getPublicUrl(storageKey, storage),
      };
    } catch (error) {
      if (!this.isRemoteImageUrl(result.url)) {
        throw error;
      }

      return {
        url: result.url,
        storage: {
          kind: "remote-url",
          downloadError: this.sanitizeDisplayText(
            error instanceof Error ? error.message : String(error),
            240,
          ),
        },
      };
    }
  }

  private isRemoteImageUrl(value: string) {
    return /^https?:\/\//i.test(value);
  }

  private async readImageResultBuffer(url: string) {
    const dataUrl = url.match(/^data:([^;,]+)?;base64,(.+)$/is);
    if (dataUrl) {
      return Buffer.from(dataUrl[2], "base64");
    }

    // 上游图片 CDN 会偶发抽风；不重试的话作品就退化成只剩一个会过期的临时链接。
    const buffer = await downloadUpstreamImage(url);
    if (!buffer) {
      throw new Error("Generated image download failed.");
    }
    return buffer;
  }

  private mimeTypeFromDataUrl(url: string) {
    return url.match(/^data:([^;,]+)?;base64,/i)?.[1];
  }

  private extensionFromMimeType(mimeType: string) {
    switch (mimeType) {
      case "image/jpeg":
        return "jpg";
      case "image/webp":
        return "webp";
      case "image/gif":
        return "gif";
      default:
        return "png";
    }
  }

  private isTerminalStatus(status: string) {
    return ["succeeded", "failed", "cancelled", "expired"].includes(status);
  }

  private publishTaskUpdated(
    conversationId: string,
    taskId: string,
    status: TaskStatus,
  ) {
    this.conversationEvents.publishTaskUpdated({
      conversationId,
      taskId,
      status,
    });
  }

  private buildProviderRequestSummary(
    baseConfig: { hasApiKey: boolean; baseUrl: string },
    capability: SupportedTaskCapability,
    input: TaskInputShape,
    inputAssets: Asset[],
  ) {
    const prompt = input.prompt ?? "";

    const isApixo = this.imageProvider.providerType === "apixo";

    return {
      mode: baseConfig.hasApiKey ? "live" : "mock",
      provider: this.imageProvider.providerId,
      // APIXO 上游地址固定由环境变量控制，用户设置的 baseUrl 仅作用于 Yunwu 上游
      baseUrl: isApixo
        ? baseConfig.baseUrl
        : (input.providerBaseUrl ?? baseConfig.baseUrl),
      endpointPath: isApixo
        ? `/generateTask/${input.model ?? "nano-banana"}`
        : this.resolveProviderEndpointPath(capability, input.model),
      model: input.model ?? (isApixo ? "nano-banana" : "gpt-image-1"),
      providerBaseUrl: isApixo ? undefined : input.providerBaseUrl,
      capability,
      promptPreview: this.truncateText(prompt, 180),
      promptLength: prompt.length,
      inputAssetCount: inputAssets.length,
      inputAssetIds: inputAssets.map((asset) => asset.id),
      params: this.summarizeParams(input.params),
    };
  }

  private resolveProviderEndpointPath(
    capability: SupportedTaskCapability,
    model?: string,
  ) {
    if (capability === "image.generate" && model?.startsWith("gemini-")) {
      return `/v1beta/models/${model}:generateContent`;
    }

    if (capability === "image.edit" && model?.startsWith("gemini-")) {
      return "/v1/chat/completions";
    }

    return capability === "image.edit"
      ? "/v1/images/edits"
      : "/v1/images/generations";
  }

  private summarizeParams(params?: Record<string, unknown>) {
    if (!params) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [
        key,
        this.summarizeValue(value),
      ]),
    );
  }

  private summarizeValue(value: unknown): unknown {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      return typeof value === "string" ? this.truncateText(value, 120) : value;
    }

    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
      };
    }

    if (value && typeof value === "object") {
      return {
        type: "object",
        keys: Object.keys(value).slice(0, 20),
      };
    }

    return typeof value;
  }

  private buildFailureSummary(error: unknown): {
    title: string;
    detail: string;
    errorMessage: string;
    category: string;
    retryable: boolean;
    statusCode?: number;
    errorStage?: string;
    errorKind?: string;
  } {
    const rawMessage =
      error instanceof Error ? error.message : "Image task failed.";
    const sanitizedMessage =
      this.sanitizeDisplayText(rawMessage, 240) || "Image task failed.";

    if (error instanceof OpenAICompatibleRequestError) {
      const statusCode = this.asNumber(error.responseSummary.statusCode);
      const errorStage = this.asString(error.responseSummary.stage);
      const errorKind = this.asString(error.responseSummary.errorKind);
      const upstreamMessage =
        this.sanitizeDisplayText(
          this.asString(error.responseSummary.errorMessage) ?? rawMessage,
          240,
        ) || sanitizedMessage;

      if (errorStage === "request") {
        if (errorKind === "connect_timeout") {
          return {
            title: "Provider unreachable",
            detail:
              "The service could not establish a connection to the image provider before the connection timeout.",
            errorMessage:
              "The connection to the image provider timed out. Check the provider base URL and network environment, then retry.",
            category: "provider_unreachable",
            retryable: true,
            errorStage,
            errorKind,
          };
        }

        if (errorKind === "timeout") {
          return {
            title: "Provider request timed out",
            detail:
              "The image request was sent, but the provider did not return a response before timeout.",
            errorMessage:
              "The image provider timed out before returning a response. Please retry later.",
            category: "provider_timeout",
            retryable: true,
            errorStage,
            errorKind,
          };
        }

        if (errorKind === "tls") {
          return {
            title: "Provider unreachable",
            detail:
              "The service could not establish a trusted TLS connection to the image provider.",
            errorMessage:
              "The image provider TLS connection failed. Check the provider base URL and network environment.",
            category: "provider_unreachable",
            retryable: true,
            errorStage,
            errorKind,
          };
        }

        if (errorKind === "connection_reset") {
          return {
            title: "Provider unreachable",
            detail:
              "The provider connection was closed before the image response was received.",
            errorMessage:
              "The image provider closed the connection before returning a response. Please retry later.",
            category: "provider_unreachable",
            retryable: true,
            errorStage,
            errorKind,
          };
        }

        return {
          title: "Provider request failed",
          detail:
            "The service could not complete the request to the image provider.",
          errorMessage: upstreamMessage,
          category: "provider_unreachable",
          retryable: true,
          errorStage,
          errorKind,
        };
      }

      if (errorStage === "response_read") {
        return {
          title: "Provider bad response",
          detail:
            "The provider responded, but the service could not finish reading the response body.",
          errorMessage:
            "The image provider response was interrupted before it could be read. Please retry later.",
          category: "provider_bad_response",
          retryable: true,
          statusCode,
          errorStage,
          errorKind,
        };
      }

      if (errorStage === "response_parse") {
        return {
          title: "Provider bad response",
          detail:
            "The provider returned a response body that was not valid JSON for this image endpoint.",
          errorMessage:
            "The image provider returned a response that could not be parsed. Please retry later.",
          category: "provider_bad_response",
          retryable: true,
          statusCode,
          errorStage,
          errorKind,
        };
      }

      if (errorStage === "response_unparseable") {
        return {
          title: "Provider image missing",
          detail:
            "The provider returned a successful response, but no image URL or base64 image payload could be found.",
          errorMessage:
            "The image provider returned a response without a usable image. Please retry or choose another model.",
          category: "provider_image_missing",
          retryable: true,
          statusCode,
          errorStage,
          errorKind,
        };
      }

      if (statusCode === 401 || statusCode === 403) {
        return {
          title: "Provider authentication failed",
          detail:
            "The image provider rejected the request because credentials or permissions are invalid.",
          errorMessage:
            "The image provider is not available because authentication failed.",
          category: "provider_auth",
          retryable: false,
          statusCode,
          errorStage,
          errorKind,
        };
      }

      if (statusCode === 429) {
        return {
          title: "Provider rate limit reached",
          detail:
            "The image provider is temporarily rate limited. Please retry later.",
          errorMessage:
            "The image provider is rate limited. Please retry later.",
          category: "provider_rate_limited",
          retryable: true,
          statusCode,
          errorStage,
          errorKind,
        };
      }

      if (statusCode && statusCode >= 500) {
        return {
          title: "Provider server error",
          detail:
            "The image provider returned a temporary server error. Please retry later.",
          errorMessage:
            "The image provider is temporarily unavailable. Please retry later.",
          category: "provider_server_error",
          retryable: true,
          statusCode,
          errorStage,
          errorKind,
        };
      }

      if (statusCode && statusCode >= 400) {
        return {
          title: "Provider invalid request",
          detail:
            "The image provider rejected the request. Check the prompt, model, and input images before retrying.",
          errorMessage: upstreamMessage,
          category: "provider_invalid_request",
          retryable: false,
          statusCode,
          errorStage,
          errorKind,
        };
      }
    }

    if (
      /timeout|timed out|network|fetch failed|ECONNRESET|ENOTFOUND/i.test(
        rawMessage,
      )
    ) {
      return {
        title: "Provider unreachable",
        detail:
          "The service could not reach the image provider. Please retry later.",
        errorMessage:
          "The service could not reach the image provider. Please retry later.",
        category: "provider_unreachable",
        retryable: true,
      };
    }

    return {
      title: "Image task failed",
      detail: "The image task failed. You can adjust the request or retry it.",
      errorMessage: sanitizedMessage,
      category: "unknown",
      retryable: true,
    };
  }

  private sanitizeProviderResponseSummary(summary: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(summary).map(([key, value]) => [
        key,
        typeof value === "string"
          ? this.sanitizeDisplayText(value, 240)
          : this.summarizeValue(value),
      ]),
    );
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  private asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : undefined;
  }

  private sanitizeDisplayText(value: string, maxLength: number) {
    const sanitized = value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
      .replace(
        /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        "[redacted-token]",
      )
      .replace(
        /\b(api[_-]?key|token|authorization|password|secret)=([^&\s]+)/gi,
        "$1=[redacted]",
      )
      .replace(/[A-Za-z0-9+/=_-]{64,}/g, "[redacted-token]");

    return this.truncateText(sanitized.trim(), maxLength);
  }

  private truncateText(value: string, maxLength: number) {
    return value.length > maxLength
      ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
      : value;
  }

  private async recordTaskEvent(
    taskId: string,
    eventType: string,
    status: TaskStatus,
    input: {
      summary: string;
      details?: Record<string, unknown>;
      title?: string;
      detail?: string;
      errorMessage?: string;
      progress?: number;
      assetIds?: string[];
    },
  ) {
    try {
      await this.taskEvents.record({
        taskId,
        eventType,
        status,
        summary: input.summary,
        details: input.details,
        title: input.title,
        detail: input.detail,
        errorMessage: input.errorMessage,
        progress: input.progress,
        assetIds: input.assetIds,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown task event error.";
      this.logger.warn(`Failed to record task event ${eventType}: ${message}`);
    }
  }
}
