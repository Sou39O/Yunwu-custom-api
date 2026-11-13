import assert from "node:assert/strict";
import test from "node:test";
import { ApiService } from "../src/api/api.service";
import {
  AUTO_RETRY_MAX_ROUNDS,
  readAutoRetry,
} from "../src/tasks/task-auto-retry.service";

const NOW = new Date("2026-11-14T00:00:00.000Z");

/**
 * 回归用例：自动重试链无限派生。
 *
 * 线上曾有一条链跑到第 965 轮、累计 4000+ 失败任务，服务进程长期占着
 * 几十条到上游的连接。这里锁住两点：链有轮数上限，且「停止」能整条掐断。
 */

function buildChain(rounds: number) {
  // task-0 -> task-1 -> ... -> task-(rounds-1)，最后一轮仍在运行
  const tasks = new Map<string, any>();
  for (let index = 0; index < rounds; index += 1) {
    tasks.set(`task-${index}`, {
      id: `task-${index}`,
      userId: "user-1",
      conversationId: "conv-1",
      sourceTaskId: index === 0 ? null : `task-${index - 1}`,
      status: index === rounds - 1 ? "running" : "failed",
      progress: 20,
      input: {
        autoRetry: { batchSize: 20, round: index, enabledAt: NOW.toISOString() },
      },
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return tasks;
}

function createHarness(rounds: number) {
  const tasks = buildChain(rounds);
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const queueCancels: string[] = [];
  const batchUpdates: Array<{ where: Record<string, unknown>; data: unknown }> = [];

  const prisma = {
    task: {
      // 返回浅拷贝，模拟数据库快照（直接返回对象引用会让 update 污染后续读取）。
      findFirst: async ({ where }: { where: { id: string } }) => {
        const task = tasks.get(where.id);
        return task ? { ...task } : undefined;
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const task = tasks.get(where.id);
        return task ? { ...task } : null;
      },
      findMany: async ({ where }: { where: { sourceTaskId: string } }) =>
        [...tasks.values()]
          .filter((task) => task.sourceTaskId === where.sourceTaskId)
          .map((task) => ({ ...task })),
      update: async (input: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(input);
        const task = tasks.get(input.where.id);
        if (task) Object.assign(task, input.data);
        return task;
      },
    },
    taskBatchItem: {
      updateMany: async (input: { where: Record<string, unknown>; data: unknown }) => {
        batchUpdates.push(input);
        return { count: 0 };
      },
    },
    taskEvent: {
      create: async () => ({ id: "event-1" }),
    },
    $transaction: async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as Function)(prisma),
  };

  const service = new ApiService(
    prisma as never,
    { cancelTask: (id: string) => queueCancels.push(id) } as never,
    {} as never,
    { publishTaskUpdated: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  return { service, tasks, updates, queueCancels, batchUpdates };
}

test("停止任务会掐断整条自动重试链，而不是只停当前一轮", async () => {
  const { service, tasks, queueCancels, updates } = createHarness(5);

  await service.cancelTask({ id: "user-1", role: "member" } as never, "task-4");

  // 最新一轮被取消
  assert.equal(tasks.get("task-4").status, "cancelled");
  assert.ok(queueCancels.includes("task-4"), "应从队列移除");

  // 整条链的 autoRetry 都被打上完成标记，终结回调不会再派生
  for (let index = 0; index < 5; index += 1) {
    const input = tasks.get(`task-${index}`).input;
    assert.ok(readAutoRetry(input)?.completedAt, `task-${index} 应被标记完成`);
    // stoppedByUser 是写进 input 的原始字段，readAutoRetry 只读白名单字段，故直接看 input。
    assert.equal((input as Record<string, any>).autoRetry.stoppedByUser, true);
  }

  assert.ok(updates.length >= 5);
});

test("停止链尾也会向上找到链头，不会漏掉中间轮次", async () => {
  const { service, tasks } = createHarness(4);

  await service.cancelTask({ id: "user-1", role: "member" } as never, "task-2");

  for (let index = 0; index < 4; index += 1) {
    assert.ok(readAutoRetry(tasks.get(`task-${index}`).input)?.completedAt);
  }
});

test("自动重试轮数上限是 50", () => {
  // 用户明确要求 50 轮封顶，避免再次出现 965 轮这种无限链。
  assert.equal(AUTO_RETRY_MAX_ROUNDS, 50);
});
