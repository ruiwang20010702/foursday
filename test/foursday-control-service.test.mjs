import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FoursdayControlService } from "../src/foursday-control-service.mjs";

const taskId = "b".repeat(64);

async function fixture(t, { now = Date.parse("2026-09-01T02:45:00.000Z") } = {}) {
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
  const taskLedgerPath = join(state, "task-ledger.json");
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
  await writeFile(taskLedgerPath, `${JSON.stringify({
    schema: "foursday-task-ledger/v1",
    revision: 1,
    tasks: {
      [taskId]: {
        taskId,
        projectId: "project",
        title: "核对项目交付状态",
        goal: "判断当前项目是否具备验收证据。",
        deliverables: ["交付结论"],
        acceptanceCriteria: ["结论有真实证据"],
        lifecycleState: "waiting_acceptance",
        confidence: 0.98,
        evidence: [
          { kind: "test", status: "verified", summary: "回归测试通过" },
          { kind: "delivery", status: "missing", summary: "等待业务签收" },
        ],
        ownerRevision: 2,
        sendGeneration: 3,
        updatedAt: "2026-08-24T10:01:00.000Z",
      },
    },
    activities: {
      [taskId]: [{
        eventId: "d".repeat(64),
        kind: "test",
        summary: "正在运行自动测试",
        detail: "项目回归",
        occurredAt: "2026-08-24T10:00:30.000Z",
      }],
    },
  })}\n`, { mode: 0o600 });
  const layout = { profileDirectory, userHome: root };
  const service = new FoursdayControlService({
    layout,
    controlPath,
    registryPath,
    threadBindingRoot: bindings,
    evidencePath,
    productionConfigPath,
    taskLedgerPath,
    desktopThreadVisible: true,
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
      enterpriseIdentityRetryPending: 3,
      enterpriseIdentityRejectionCount: 4,
      enterpriseIdentityLastErrorCode: "dws_enterprise_identity_unavailable",
      eventWakeEnabled: true, eventWakeReady: false, eventWakeDegraded: true,
      responsibilityReactionsEnabled: true,
      reactionWakeReadyCount: 2,
      reactionWakeErrorCount: 1,
      reactionWakeDegraded: true,
      reactionWakeLastErrorCode: "reaction_event_unavailable",
      responsibilityReactionCount: 3,
      lastWakeSource: "filesystem", lastDetectionLatencyMs: 1250,
    }),
    memoryCatalogReader: async () => ({
      sourceId: "default",
      projects: Array.from({ length: 45 }, (_, index) => ({
        slug: `projects/example-${index + 1}`,
      })),
      truncated: false,
    }),
    now: () => now,
  });
  return { service, bindings };
}

test("control service projects tasks, schedules, memory and evidence without private bodies", async (t) => {
  const { service } = await fixture(t);
  const status = await service.status();
  assert.equal(status.gateway.eventWakeDegraded, true);
  assert.equal(status.gateway.responsibilityReactionsEnabled, true);
  assert.equal(status.gateway.reactionWakeReadyCount, 2);
  assert.equal(status.gateway.reactionWakeErrorCount, 1);
  assert.equal(status.gateway.reactionWakeDegraded, true);
  assert.equal(status.gateway.reactionControlHealthy, true);
  assert.equal(status.gateway.reactionWakeLastErrorCode, "reaction_event_unavailable");
  assert.equal(status.gateway.responsibilityReactionCount, 3);
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
  assert.equal(status.gateway.enterpriseIdentityRetryPending, 3);
  assert.equal(status.gateway.enterpriseIdentityRejectionCount, 4);
  assert.equal(
    status.gateway.enterpriseIdentityLastErrorCode,
    "dws_enterprise_identity_unavailable",
  );
  assert.equal(status.gateway.sendBlocked, false);
  assert.equal(status.gateway.lastWakeSource, "filesystem");
  assert.equal(status.gateway.lastDetectionLatencyMs, 1250);
  const tasks = await service.tasks();
  assert.equal(tasks.revision, 0);
  assert.equal(tasks.taskLedgerRevision, 1);
  assert.deepEqual(tasks.items[0], {
    taskId,
    projectId: "project",
    projectName: "Project",
    requester: null,
    executor: {
      displayName: "Foursday",
      runtime: "Codex",
      threadBound: true,
      threadSpace: "desktop",
    },
    assignmentState: "routed",
    projectGroupId: "project",
    projectGroupName: "Project",
    summaryTitle: null,
    execution: null,
    state: "active",
    ownerRevision: 2,
    sendGeneration: 3,
    codexThreadId: "thread-1",
    forkCount: 1,
    lastInboundAt: null,
    updatedAt: "2026-08-24T10:00:00.000Z",
    pendingIntervention: null,
    worksiteGroup: "needs_me",
    progress: {
      stage: "test",
      activityCount: 1,
      hasPlan: true,
      lastActivityAt: "2026-08-24T10:00:30.000Z",
    },
    activityTrail: [{
      eventId: "d".repeat(64),
      kind: "test",
      summary: "正在运行自动测试",
      detail: "项目回归",
      occurredAt: "2026-08-24T10:00:30.000Z",
    }],
    missingEvidence: ["等待业务签收"],
    threadView: { available: true, reason: "available" },
    taskContract: {
      title: "核对项目交付状态",
      goal: "判断当前项目是否具备验收证据。",
      deliverables: ["交付结论"],
      acceptanceCriteria: ["结论有真实证据"],
      lifecycleState: "waiting_acceptance",
      confidence: 0.98,
      evidenceCounts: { verified: 1, missing: 1 },
      updatedAt: "2026-08-24T10:01:00.000Z",
      businessAccepted: false,
    },
  });
  const schedules = await service.schedules();
  assert.equal(schedules.items[0].continuity, true);
  assert.equal("prompt" in schedules.items[0], false);
  assert.equal("script" in schedules.items[0], false);
  const memory = await service.memory();
  assert.equal(memory.schema, "foursday-control-memory/v2");
  assert.equal(memory.sourceId, "default");
  assert.equal(memory.registrySchemaVersion, 1);
  assert.deepEqual(memory.fixedBindings, { projectCount: 1, pageCount: 1 });
  assert.deepEqual(memory.discovery, {
    enabled: true,
    state: "ready",
    projectCount: 45,
    truncated: false,
  });
  assert.deepEqual(memory.projects[0].pages, ["projects/example"]);
  const evidence = await service.evidence();
  assert.deepEqual(evidence.byType, { inbound: 1, reply_attempt: 1 });
  assert.doesNotMatch(JSON.stringify(evidence), /body|reply"/u);
});

test("control memory degrades only its discovery count when gbrain listing fails", async (t) => {
  const { service } = await fixture(t);
  service.memoryCatalogReader = async () => { throw new Error("private upstream error"); };
  service.memoryCatalogCache = null;
  const memory = await service.memory();
  assert.equal(memory.readEnabled, true);
  assert.equal(memory.discovery.state, "unavailable");
  assert.equal(memory.discovery.projectCount, null);
  assert.deepEqual(memory.fixedBindings, { projectCount: 1, pageCount: 1 });
  assert.doesNotMatch(JSON.stringify(memory), /private upstream error/u);
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

test("taken-over tasks remain recent even when a takeover event is still pending", async (t) => {
  const { service } = await fixture(t);
  const takeover = await service.apply({
    action: "task_takeover",
    expectedRevision: 0,
    taskId,
  });
  assert.equal(takeover.result.state, "taken_over");
  const tasks = await service.tasks();
  assert.equal(tasks.items[0].pendingIntervention.type, "task_takeover");
  assert.equal(tasks.items[0].worksiteGroup, "recent");
});

test("current task generation selects its exact Thread binding instead of file order", async (t) => {
  const { service, bindings } = await fixture(t);
  await writeFile(join(bindings, `${"f".repeat(64)}.json`), `${JSON.stringify({
    schema: "foursday-thread-binding/v1",
    scope: { sourceSessionHash: taskId, projectId: "stale_project" },
    codexThreadId: "thread-stale",
    forkThreadIds: [],
    ownerRevision: 1,
    sendGeneration: 2,
    updatedAt: "2026-09-01T02:44:00.000Z",
  })}\n`, { mode: 0o600 });
  await service.store.observeTask({
    taskId,
    projectId: null,
    requester: { displayName: "娜娜老师", channel: "dingtalk_direct" },
    ownerRevision: 2,
    sendGeneration: 3,
    lastInboundAt: "2026-09-01T02:44:30.000Z",
  });

  const item = (await service.tasks()).items.find((task) => task.taskId === taskId);
  assert.equal(item.projectId, "project");
  assert.equal(item.codexThreadId, "thread-1");
  assert.equal(item.assignmentState, "routed");
  assert.deepEqual(item.requester, {
    displayName: "娜娜老师",
    channel: "dingtalk_direct",
  });
  assert.deepEqual(item.progress, {
    stage: "test",
    activityCount: 1,
    hasPlan: true,
    lastActivityAt: "2026-08-24T10:00:30.000Z",
  });
});

test("fresh unbound work routes briefly while stale orphan records move to recent history", async (t) => {
  const now = Date.parse("2026-09-01T02:45:00.000Z");
  const { service } = await fixture(t, { now });
  const freshId = "1".repeat(64);
  const legacyId = "2".repeat(64);
  await service.store.observeTask({
    taskId: freshId,
    projectId: null,
    ownerRevision: 1,
    sendGeneration: 1,
    lastInboundAt: "2026-09-01T02:40:00.000Z",
  });
  await service.store.observeTask({
    taskId: legacyId,
    projectId: null,
    ownerRevision: 1,
    sendGeneration: 1,
    lastInboundAt: "2026-08-28T09:20:51.000Z",
  });

  const items = (await service.tasks()).items;
  const fresh = items.find((task) => task.taskId === freshId);
  assert.equal(fresh.assignmentState, "routing");
  assert.equal(fresh.projectGroupName, "正在识别项目");
  assert.equal(fresh.worksiteGroup, "working");
  const legacy = items.find((task) => task.taskId === legacyId);
  assert.equal(legacy.assignmentState, "legacy_unassigned");
  assert.equal(legacy.projectGroupName, "未归档历史");
  assert.equal(legacy.worksiteGroup, "recent");
});
