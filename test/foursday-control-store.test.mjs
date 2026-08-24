import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FoursdayControlStore } from "../src/foursday-control-store.mjs";

const taskId = "a".repeat(64);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-control-store-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "control.json");
  const store = await new FoursdayControlStore({ path }).open();
  return { root, path, store };
}

test("control store is private, revision fenced and carries no task body or identity", async (t) => {
  const value = await fixture(t);
  assert.equal((await value.store.snapshot()).revision, 0);
  const observed = await value.store.observeTask({
    taskId,
    projectId: "project",
    ownerRevision: 0,
    sendGeneration: 1,
    lastInboundAt: "2026-08-24T10:00:00.000Z",
  });
  assert.equal(observed.revision, 1);
  const paused = await value.store.apply({
    action: "pause_task",
    expectedRevision: 1,
    taskId,
  });
  assert.equal(paused.revision, 2);
  assert.equal(paused.result.state, "paused");
  await assert.rejects(value.store.apply({
    action: "resume_task",
    expectedRevision: 1,
    taskId,
  }), /revision_conflict/u);
  const snapshot = await value.store.snapshot();
  assert.equal(snapshot.tasks[taskId].ownerRevision, 1);
  assert.equal(snapshot.tasks[taskId].sendGeneration, 2);
  assert.equal(snapshot.tasks[taskId].pendingEvent.type, "task_takeover");
  assert.equal((await lstat(value.path)).mode & 0o077, 0);
  const serialized = await readFile(value.path, "utf8");
  assert.doesNotMatch(serialized, /conversation|trusted-user|message body/u);
});

test("acknowledging a correction scrubs its transient note", async (t) => {
  const value = await fixture(t);
  await value.store.observeTask({
    taskId,
    projectId: "project",
    ownerRevision: 0,
    sendGeneration: 1,
    lastInboundAt: "2026-08-24T10:00:00.000Z",
  });
  const correction = await value.store.apply({
    action: "task_correction",
    expectedRevision: 1,
    taskId,
    note: "Use the current approved scope.",
  });
  const eventId = correction.result.eventId;
  await value.store.consumeEvent(taskId, eventId);
  const snapshot = await value.store.snapshot();
  assert.equal(snapshot.tasks[taskId].pendingEvent.consumed, true);
  assert.equal(snapshot.tasks[taskId].pendingEvent.note, "");
});

test("control store rejects secret correction notes and serializes competing writers", async (t) => {
  const value = await fixture(t);
  await value.store.observeTask({
    taskId,
    projectId: "project",
    ownerRevision: 0,
    sendGeneration: 1,
    lastInboundAt: "2026-08-24T10:00:00.000Z",
  });
  await assert.rejects(value.store.apply({
    action: "task_correction",
    expectedRevision: 1,
    taskId,
    note: "password=do-not-store",
  }), /secret material/u);
  await assert.rejects(value.store.apply({
    action: "task_correction",
    expectedRevision: 1,
    taskId,
    note: ["sk", "1234567890abcdef"].join("-"),
  }), /secret material/u);
  const results = await Promise.allSettled([
    value.store.apply({ action: "pause_all", expectedRevision: 1 }),
    value.store.apply({ action: "resume_all", expectedRevision: 1 }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal((await value.store.snapshot()).revision, 2);
  const snapshot = await value.store.snapshot();
  assert.equal(snapshot.tasks[taskId].ownerRevision, 1);
  assert.equal(snapshot.tasks[taskId].sendGeneration, 2);
});

test("a bound task can be seeded atomically by its first control action", async (t) => {
  const value = await fixture(t);
  const result = await value.store.apply({
    action: "communication_takeover",
    expectedRevision: 0,
    taskId,
    taskSeed: {
      taskId,
      projectId: "project",
      ownerRevision: 4,
      sendGeneration: 7,
    },
  });
  assert.equal(result.revision, 1);
  assert.equal(result.document.tasks[taskId].ownerRevision, 5);
  assert.equal(result.document.tasks[taskId].sendGeneration, 8);
});

test("control store never tightens permissions on an existing broad parent", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-control-broad-parent-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const store = await new FoursdayControlStore({ path: join(root, "control.json") }).open();
  await assert.rejects(store.apply({ action: "pause_all", expectedRevision: 0 }), /parent is unsafe/u);
  assert.equal((await lstat(root)).mode & 0o777, 0o755);
});
