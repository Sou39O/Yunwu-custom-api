import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface TaskQueueJobData {
  taskId: string;
}

export type TaskQueueProcessor = (taskId: string) => Promise<void>;

interface QueuedJob {
  taskId: string;
  batch: boolean;
  attempt: number;
}

/**
 * 进程内任务队列：替代原 BullMQ + Redis 实现。
 * 普通任务与批量父任务使用独立并发额度；失败时按指数退避重试；
 * 相同 taskId 在排队或执行中时默认去重。
 * 进程重启后的恢复由 TaskQueueRecoveryService 基于数据库状态重新入队。
 */
@Injectable()
export class TaskQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(TaskQueueService.name);
  private readonly maxAttempts = 3;
  private readonly retryBaseDelayMs = 5_000;
  private readonly pending: QueuedJob[] = [];
  private readonly inFlight = new Set<string>();
  private readonly queuedIds = new Set<string>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  /** 已取消的 taskId：排队中的直接丢弃，已在执行的结果由执行器自行丢弃。 */
  private readonly cancelledIds = new Set<string>();
  private readonly concurrency: number;
  private readonly batchConcurrency: number;
  private activeCount = 0;
  private activeBatchCount = 0;
  private processor?: TaskQueueProcessor;
  private stopped = false;

  constructor(private readonly config: ConfigService) {
    this.concurrency = Math.max(
      1,
      this.config.get<number>("tasks.workerConcurrency", 50),
    );
    this.batchConcurrency = Math.max(
      1,
      this.config.get<number>("tasks.batchWorkerConcurrency", 2),
    );
  }

  onModuleDestroy() {
    this.stopped = true;
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.retryTimers.clear();
    this.pending.length = 0;
  }

  setProcessor(processor: TaskQueueProcessor) {
    this.processor = processor;
    this.pump();
  }

  getStats() {
    return {
      pending: this.pending.length,
      running: this.inFlight.size,
      concurrency: this.concurrency,
      batchConcurrency: this.batchConcurrency,
      processorRegistered: Boolean(this.processor),
    };
  }

  async enqueueTask(taskId: string, source = "api") {
    this.add({ taskId, batch: false, attempt: 0 }, source, true);
  }

  async enqueueBatchTask(
    taskId: string,
    source = "api",
    options: { dedupe?: boolean } = {},
  ) {
    this.add({ taskId, batch: true, attempt: 0 }, source, options.dedupe ?? true);
  }

  /** 取消排队中的任务：从队列移除，并拦截后续（重试定时器）入队。 */
  cancelTask(taskId: string) {
    this.cancelledIds.add(taskId);
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index].taskId === taskId) {
        this.pending.splice(index, 1);
      }
    }
    this.queuedIds.delete(taskId);
    this.logger.debug(`Task ${taskId} cancelled and dropped from queue.`);
  }

  /** 重新激活一个 taskId（原地重试失败槽位时会复用同一个 id）。 */
  resumeTask(taskId: string) {
    this.cancelledIds.delete(taskId);
    this.queuedIds.delete(taskId);
  }

  isCancelled(taskId: string) {
    return this.cancelledIds.has(taskId);
  }

  private add(job: QueuedJob, source: string, dedupe: boolean) {
    if (this.stopped || this.cancelledIds.has(job.taskId)) {
      return;
    }

    if (dedupe && (this.queuedIds.has(job.taskId) || this.inFlight.has(job.taskId))) {
      this.logger.debug(`Task ${job.taskId} already queued/running; skipped.`);
      return;
    }

    this.pending.push(job);
    this.queuedIds.add(job.taskId);
    this.logger.debug(
      `Queued ${job.batch ? "batch " : ""}task ${job.taskId} from ${source}.`,
    );
    this.pump();
  }

  private pump() {
    if (!this.processor || this.stopped) {
      return;
    }

    for (let index = 0; index < this.pending.length; ) {
      const job = this.pending[index];
      const hasSlot = job.batch
        ? this.activeBatchCount < this.batchConcurrency
        : this.activeCount - this.activeBatchCount < this.concurrency;

      if (!hasSlot) {
        index += 1;
        continue;
      }

      this.pending.splice(index, 1);
      this.queuedIds.delete(job.taskId);
      void this.run(job);
    }
  }

  private async run(job: QueuedJob) {
    const processor = this.processor;
    if (!processor) {
      return;
    }

    this.inFlight.add(job.taskId);
    this.activeCount += 1;
    if (job.batch) {
      this.activeBatchCount += 1;
    }

    try {
      await processor(job.taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const attempt = job.attempt + 1;
      if (attempt < this.maxAttempts && !this.stopped) {
        const delayMs = this.retryBaseDelayMs * 2 ** (attempt - 1);
        this.logger.warn(
          `Task ${job.taskId} failed (attempt ${attempt}/${this.maxAttempts}); retrying in ${Math.round(delayMs / 1000)}s: ${message}`,
        );
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          this.add({ ...job, attempt }, "retry", true);
        }, delayMs);
        this.retryTimers.add(timer);
      } else {
        this.logger.error(
          `Task ${job.taskId} failed after ${attempt} attempt(s): ${message}`,
        );
      }
    } finally {
      this.inFlight.delete(job.taskId);
      this.activeCount -= 1;
      if (job.batch) {
        this.activeBatchCount -= 1;
      }
      this.pump();
    }
  }
}
