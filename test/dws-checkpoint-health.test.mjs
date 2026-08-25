import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDwsCheckpointHealth } from "../src/dws-checkpoint-health.mjs";

const now = new Date("2026-08-25T07:00:00.000Z").getTime();

function state(overrides = {}) {
  return {
    lastFullSuccessAt: new Date(now - 30_000).toISOString(),
    lastErrorCount: 0,
    ...overrides,
  };
}

test("legacy checkpoints without lifecycle remain healthy", () => {
  const result = evaluateDwsCheckpointHealth({
    state: state(), now, fallbackMs: 30_000, modifiedAt: now,
  });
  assert.equal(result.checkpointState, "healthy");
  assert.equal(result.checkpointHealthy, true);
  assert.equal(result.checkpointBusy, false);
});

test("a running check past the normal freshness window stays ready only while bounded", () => {
  const running = state({
    lastFullSuccessAt: new Date(now - 70_000).toISOString(),
    checkLifecycle: {
      status: "running",
      generation: 7,
      operation: "history_check",
      startedAt: new Date(now - 70_000).toISOString(),
      errorCount: 0,
    },
  });
  const bounded = evaluateDwsCheckpointHealth({
    state: running, now, fallbackMs: 30_000, modifiedAt: now - 70_000,
  });
  assert.equal(bounded.checkpointState, "busy_but_bounded");
  assert.equal(bounded.checkpointHealthy, true);
  assert.equal(bounded.checkpointBusy, true);
  assert.equal(bounded.checkpointGeneration, 7);
  assert.equal(bounded.checkpointOperation, "history_check");

  const timedOut = evaluateDwsCheckpointHealth({
    state: running,
    now: now + 51_000,
    fallbackMs: 30_000,
    modifiedAt: now - 70_000,
  });
  assert.equal(timedOut.checkpointState, "stale");
  assert.equal(timedOut.checkpointHealthy, false);
});

test("real errors fail closed and small filesystem clock skew does not", () => {
  const failed = evaluateDwsCheckpointHealth({
    state: state({
      lastErrorCount: 1,
      checkLifecycle: { status: "failed", generation: 2, errorCount: 1 },
    }),
    now,
    fallbackMs: 30_000,
    modifiedAt: now,
  });
  assert.equal(failed.checkpointState, "failed");
  assert.equal(failed.checkpointHealthy, false);

  const skewed = evaluateDwsCheckpointHealth({
    state: state({ lastFullSuccessAt: new Date(now + 2_000).toISOString() }),
    now,
    fallbackMs: 30_000,
    modifiedAt: now + 1,
  });
  assert.equal(skewed.checkpointState, "healthy");
});
