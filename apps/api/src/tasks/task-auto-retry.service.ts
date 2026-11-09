import { Injectable, Logger } from "@nestjs/common";
import type { Asset, Prisma, Task, TaskBatchItem } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TaskQueueService } from "./task-queue.service";

export const AUTO_RETRY_DEFAULT_BATCH_SIZE = 20;
export const AUTO_RETRY_MAX_BATCH_SIZE = 20;

export interface AutoRetryConfig {
  batchSize: number;
  round: number;
  enabledAt?: string;
  completedAt?: string;
}

export function normalizeAutoRetryBatchSize(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) {
    return AUTO_RETRY_DEFAULT_BATCH_SIZE;
  }
  return Math.min(AUTO_RETRY_MAX_BATCH_SIZE, Math.max(1, Math.round(parsed)));
}

export function readAutoRetry(input: unknown): AutoRetryConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const raw = (input as Record<string, unknown>).autoRetry;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const round = typeof record.round === "number" ? record.round : 0;
  return {
    batchSize: normalizeAutoRetryBatchSize(record.batchSize),
    round: Number.isFinite(round) ? Math.max(0, Math.round(round)) : 0,
    ...(typeof record.enabledAt === "string" ? { enabledAt: record.enabledAt } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
  };
}

export function countTaskSuccesses(task: {
  status: string;
  batchItems?: Array<Pick<TaskBatchItem, "status">>;
  assets?: Array<Pick<Asset, "type" | "status">>;
}): number {
  if (task.batchItems && task.batchItems.length > 0) {
    return task.batchItems.filter((item) => item.status === "succeeded").length;
  }
  return (task.assets ?? []).filter(
    (asset) => asset.type === "generated" && asset.status !== "deleted",
  ).length;
}

/**
 * 自动重试到「至少一张成功」：
 * 任务终结时若成功数为 0 且开启了 autoRetry，就再排一轮 batchSize（默认 20）的重试任务；
 * 新一轮继承 autoRetry 并把 round +1，直到出现成功、被取消或用户关闭。
 */
@Injectable()
export class TaskAutoRetryService {
  private readonly logger = new Logger(TaskAutoRetryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly taskQueue: TaskQueueService,
  ) {}

  async maybeSchedule(
    taskId: string,
  ): Promise<{ scheduled: boolean; nextTaskId?: string }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { assets: true, batchItems: true },
    });
    if (!task) {
      return { scheduled: false };
    }

    const autoRetry = readAutoRetry(task.input);
    if (!autoRetry || autoRetry.completedAt) {
      return { scheduled: false };
    }
    if (task.status === "cancelled") {
      return { scheduled: false };
    }

    const successCount = countTaskSuccesses(task);
    if (successCount > 0) {
      await this.markCompleted(task, autoRetry);
      return { scheduled: false };
    }

    if (!["failed", "succeeded", "expired"].includes(task.status)) {
      // 还在跑（或被取消前的排队态），等下一次终结回调。
      return { scheduled: false };
    }

    const nextTaskId = await this.createRound(task, autoRetry);
    return { scheduled: true, nextTaskId };
  }

  private async markCompleted(task: Task, autoRetry: AutoRetryConfig) {
    const input = { ...(task.input as Record<string, unknown>) };
    input.autoRetry = {
      ...autoRetry,
      completedAt: new Date().toISOString(),
    } satisfies AutoRetryConfig;

    await this.prisma.task.update({
      where: { id: task.id },
      data: { input: input as Prisma.InputJsonObject },
    });
  }

  private async createRound(task: Task, autoRetry: AutoRetryConfig): Promise<string> {
    const round = autoRetry.round + 1;
    const batchSize = autoRetry.batchSize;
    const input: Prisma.InputJsonObject = {
      ...(task.input as Prisma.InputJsonObject),
      batchCount: batchSize,
      autoRetry: { ...autoRetry, round } as Prisma.InputJsonObject,
    } as Prisma.InputJsonObject;

    const created = await this.prisma.$transaction(async (tx) => {
      const next = await tx.task.create({
        data: {
          userId: task.userId,
          conversationId: task.conversationId,
          sourceTaskId: task.id,
          sourceAction: "retry",
          type: task.type,
          status: "queued",
          progress: 0,
          input,
        },
      });
      await tx.taskBatchItem.createMany({
        data: Array.from({ length: batchSize }, (_, index) => ({
          taskId: next.id,
          batchIndex: index,
          status: "queued" as const,
          progress: 0,
        })),
      });
      await tx.taskEvent.create({
        data: {
          taskId: next.id,
          eventType: "auto_retry.queued",
          status: "queued",
          summary: `Auto retry round ${round} queued.`,
          details: {
            title: `自动重试第 ${round} 轮`,
            detail: `上一轮没有成功图片，自动再排 ${batchSize} 次重试。`,
            retryOfTaskId: task.id,
            autoRetryRound: round,
            autoRetryBatchSize: batchSize,
            progress: 0,
          } as Prisma.InputJsonObject,
        },
      });
      return next;
    });

    await this.taskQueue.enqueueBatchTask(created.id, "auto-retry");
    this.logger.warn(
      `Task ${task.id} finished with no output; scheduled auto retry round ${round} as ${created.id}.`,
    );
    return created.id;
  }
}
