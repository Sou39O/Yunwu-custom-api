import assert from "node:assert/strict";
import test from "node:test";
import {
  countTaskSuccesses,
  normalizeAutoRetryBatchSize,
  readAutoRetry,
} from "./task-auto-retry.service";

test("countTaskSuccesses counts batch slots, not failed slots", () => {
  const count = countTaskSuccesses({
    status: "succeeded",
    batchItems: [
      { status: "succeeded" },
      { status: "failed" },
      { status: "failed" },
    ],
    assets: [],
  });
  assert.equal(count, 1);
});

test("countTaskSuccesses counts generated assets for single tasks", () => {
  const count = countTaskSuccesses({
    status: "succeeded",
    batchItems: [],
    assets: [
      { type: "generated", status: "ready" },
      { type: "generated", status: "deleted" },
      { type: "upload", status: "ready" },
    ],
  });
  assert.equal(count, 1);
});

test("readAutoRetry parses round and batch size", () => {
  const config = readAutoRetry({ autoRetry: { batchSize: 20, round: 3 } });
  assert.deepEqual(config, { batchSize: 20, round: 3 });
});

test("readAutoRetry ignores completed or missing config", () => {
  assert.equal(
    readAutoRetry({ autoRetry: { batchSize: 20, round: 1, completedAt: "2026-01-01" } })?.completedAt,
    "2026-01-01",
  );
  assert.equal(readAutoRetry({}), undefined);
  assert.equal(readAutoRetry(null), undefined);
});

test("normalizeAutoRetryBatchSize clamps to 1..20 and defaults to 20", () => {
  assert.equal(normalizeAutoRetryBatchSize(undefined), 20);
  assert.equal(normalizeAutoRetryBatchSize(0), 1);
  assert.equal(normalizeAutoRetryBatchSize(999), 20);
  assert.equal(normalizeAutoRetryBatchSize("7"), 7);
});
