import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FoursdayControlService } from "../src/foursday-control-service.mjs";

const taskId = "b".repeat(64);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-control-service-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileDirectory = join(root, "profile");
  const state = join(profileDirectory, "local", "foursday", "state");
  const bindings = join(state, "thread-bindings");
  const cron = join(profileDirectory, "cron");
  await Promise.all([
    mkdir(bindings, { recursive: true, mode: 0o700 }),
    mkdir(cron, { recursive: true, mode: 0o700 }),
  ]);
  const registryPath = join(profileDirectory, "local", "foursday", "projects.json");
  const productionConfigPath = join(profileDirectory, "local", "foursday", "production.json");
  const evidencePath = join(state, "shadow-evidence.jsonl");
  const controlPath = join(state, "control.json");
  await writeFile(registryPath, `${JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: "project", name: "Project", aliases: [], root, gbrainSlugs: ["projects/example"] }],
  })}\n`, { mode: 0o600 });
  await writeFile(productionConfigPath, JSON.stringify({
    FOURSDAY_GBRAIN_ENABLED: "true",
    FOURSDAY_GBRAIN_WRITE_ENABLED: "false",
  }), { mode: 0o600 });
  await writeFile(join(bindings, `${"c".repeat(64)}.json`), `${JSON.stringify({
    schema: "foursday-thread-binding/v1",
    scope: { sourceSessionHash: taskId, projectId: "project" },
    codexThreadId: "thread-1",
    forkThreadIds: ["fork-1"],
    ownerRevision: 2,
    sendGeneration: 3,
    updatedAt: "2026-08-24T10:00:00.000Z",
  })}\n`, { mode: 0o600 });
  await writeFile(join(cron, "jobs.json"), `${JSON.stringify([{
    id: "job-1", name: "Risk watch", prompt: "private prompt", script: "private.py",
    workdir: root, enabled: true, state: "scheduled", schedule_display: "every 1h",
    deliver: "local", context_from: ["self"],
  }])}\n`, { mode: 0o600 });
  await writeFile(evidencePath, [
    JSON.stringify({ type: "inbound", occurredAt: "2026-08-24T09:00:00Z", private: "body" }),
    JSON.stringify({ type: "reply_attempt", occurredAt: "2026-08-24T09:01:00Z", private: "reply" }),
    "",
  ].join("\n"), { mode: 0o600 });
  const layout = { profileDirectory, userHome: root };
  const service = new FoursdayControlService({
    layout,
    controlPath,
    registryPath,
    threadBindingRoot: bindings,
    evidencePath,
    productionConfigPath,
    gatewayInspector: async () => ({
      ready: true, installed: true, mode: "shadow", sendEnabled: false,
      sendBlocked: false,
      running: true, checkpointHealthy: true, checkpointState: "busy_but_bounded",
      checkpointBusy: true, modeConsistent: true,
      checkpointGeneration: 9, checkpointOperation: "history_check",
      manualReplyProbeReady: false, manualReplyProbeDegraded: true,
      manualReplyProbeErrorCode: "dws_manual_reply_temporary",
      deferredReplyWaiting: true, deferredReplyAttemptCount: 2,
      deferredReplyErrorCode: "tls_timeout",
      deferredReplyExpiresAt: "2026-08-25T10:00:00.000Z",
      eventWakeEnabled: true, eventWakeReady: false, eventWakeDegraded: true,
      lastWakeSource: "filesystem", lastDetectionLatencyMs: 1250,
    }),
  });
  return { service };
}

test("control service projects tasks, schedules, memory and evidence without private bodies", async (t) => {
  const { service } = await fixture(t);
  const status = await service.status();
  assert.equal(status.gateway.eventWakeDegraded, true);
  assert.equal(status.gateway.checkpointState, "busy_but_bounded");
  assert.equal(status.gateway.checkpointBusy, true);
  assert.equal(status.gateway.checkpointGeneration, 9);
  assert.equal(status.gateway.checkpointOperation, "history_check");
  assert.equal(status.gateway.manualReplyProbeReady, false);
  assert.equal(status.gateway.manualReplyProbeDegraded, true);
  assert.equal(status.gateway.manualReplyProbeErrorCode, "dws_manual_reply_temporary");
  assert.equal(status.gateway.deferredReplyWaiting, true);
  assert.equal(status.gateway.deferredReplyAttemptCount, 2);
  assert.equal(status.gateway.deferredReplyErrorCode, "tls_timeout");
  assert.equal(status.gateway.deferredReplyExpiresAt, "2026-08-25T10:00:00.000Z");
  assert.equal(status.gateway.sendBlocked, false);
  assert.equal(status.gateway.lastWakeSource, "filesystem");
  assert.equal(status.gateway.lastDetectionLatencyMs, 1250);
  const tasks = await service.tasks();
  assert.equal(tasks.revision, 0);
  assert.deepEqual(tasks.items[0], {
    taskId,
    projectId: "project",
    state: "active",
    ownerRevision: 2,
    sendGeneration: 3,
    codexThreadId: "thread-1",
    forkCount: 1,
    lastInboundAt: null,
    updatedAt: "2026-08-24T10:00:00.000Z",
    pendingIntervention: null,
  });
  const schedules = await service.schedules();
  assert.equal(schedules.items[0].continuity, true);
  assert.equal("prompt" in schedules.items[0], false);
  assert.equal("script" in schedules.items[0], false);
  const memory = await service.memory();
  assert.equal(memory.sourceId, "default");
  assert.deepEqual(memory.projects[0].pages, ["projects/example"]);
  const evidence = await service.evidence();
  assert.deepEqual(evidence.byType, { inbound: 1, reply_attempt: 1 });
  assert.doesNotMatch(JSON.stringify(evidence), /body|reply"/u);
});

test("control service seeds a bound task and global pause changes readiness", async (t) => {
  const { service } = await fixture(t);
  const controlled = await service.apply({
    action: "pause_task",
    expectedRevision: 0,
    taskId,
  });
  assert.equal(controlled.result.state, "paused");
  let status = await service.status();
  assert.equal(status.taskCounts.paused, 1);
  const paused = await service.apply({ action: "pause_all", expectedRevision: controlled.revision });
  assert.equal(paused.result.state, "paused");
  status = await service.status();
  assert.equal(status.ready, false);
  assert.equal(status.control.state, "paused");
});
