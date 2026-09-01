import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeStatePersistence,
  loadFoursdayRuntimeState,
  saveFoursdayRuntimeState,
} from "../src/foursday-runtime-state.mjs";

test("runtime state store creates the legacy-compatible empty projection", async () => {
  const state = await loadFoursdayRuntimeState(null);
  assert.deepEqual(state.recentMessageIds, []);
  assert.deepEqual(state.enterpriseIdentityQueue, {});
  assert.equal(state.checkLifecycle.status, "idle");
  assert.equal(state.deferredReply.waiting, false);
});

test("runtime state store sanitizes restart-only and bounded fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foursday-runtime-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");
  await writeFile(path, `${JSON.stringify({
    recentMessageIds: Array.from({ length: 5_010 }, (_, index) => `m-${index}`),
    sendLedger: Object.fromEntries(Array.from({ length: 1_010 }, (_, index) => [
      `s-${index}`, { status: "completed" },
    ])),
    deferredReply: {
      waiting: true,
      attemptCount: 3,
      errorCode: "tls_timeout",
      expiresAt: "2026-09-01T00:05:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    reactionWake: { enabled: true, readyCount: -2, errorCount: 3 },
  })}\n`, { mode: 0o600 });
  const state = await loadFoursdayRuntimeState(path);
  assert.equal(state.recentMessageIds.length, 5_000);
  assert.equal(Object.keys(state.sendLedger).length, 1_000);
  assert.deepEqual(state.deferredReply, {
    waiting: false,
    attemptCount: 3,
    errorCode: "candidate_lost_on_restart",
    expiresAt: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(state.reactionWake.readyCount, 0);
  assert.equal(state.reactionWake.errorCount, 3);
});

test("runtime state store publishes one private atomic JSON document", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foursday-runtime-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "state.json");
  const state = await loadFoursdayRuntimeState(null);
  state.lastWakeSource = "dws_event";
  await saveFoursdayRuntimeState(path, state);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).lastWakeSource, "dws_event");
});

test("checkpoint health persistence cannot overwrite another state authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "foursday-runtime-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");
  const state = await loadFoursdayRuntimeState(null);
  const persistence = createRuntimeStatePersistence({ path, state });
  state.recipients = { original: { chatType: "direct" } };
  await persistence.persist();
  state.recipients = { unsaved: { chatType: "group" } };
  state.lastCheckAt = "2026-09-01T00:01:00.000Z";
  state.checkLifecycle = {
    status: "completed", generation: 1, operation: "history_check",
    wakeSource: "manual", startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:01:00.000Z", errorCount: 0,
  };
  await persistence.persistCheckHealth();
  const stored = await loadFoursdayRuntimeState(path);
  assert.deepEqual(stored.recipients, { original: { chatType: "direct" } });
  assert.equal(stored.lastCheckAt, "2026-09-01T00:01:00.000Z");
  assert.equal(stored.checkLifecycle.generation, 1);
});
