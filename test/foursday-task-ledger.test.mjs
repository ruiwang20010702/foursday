import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FoursdayTaskLedgerStore } from "../src/foursday-task-ledger.mjs";

const taskId = "a".repeat(64);

test("task ledger persists a private semantic contract and evidence manifest", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-ledger-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const path = join(root, "task-ledger.json");
  const store = await new FoursdayTaskLedgerStore({ path }).open({ createParent: true });
  const created = await store.upsertFromAgent({
    taskId,
    projectId: "foursday",
    title: "整理本周交付证据",
    goal: "把真实项目状态整理成可验收结论。",
    deliverables: ["交付清单", "风险与下一步"],
    acceptanceCriteria: ["结论均有真实证据", "缺失信息明确标注"],
    lifecycleState: "working",
    confidence: 0.96,
    evidence: [{ kind: "message", status: "observed", summary: "当前请求已进入任务上下文" }],
    ownerRevision: 2,
    sendGeneration: 3,
  });
  assert.equal(created.result.task.lifecycleState, "working");
  const waiting = await store.upsertFromAgent({
    ...created.result.task,
    lifecycleState: "waiting_acceptance",
    evidence: [{ kind: "test", status: "verified", summary: "相关回归测试已通过" }],
    ownerRevision: 2,
    sendGeneration: 3,
  });
  assert.equal(waiting.result.task.lifecycleState, "waiting_acceptance");
  const completed = await store.upsertFromAgent({
    ...waiting.result.task,
    lifecycleState: "completed",
    evidence: [{ kind: "test", status: "verified", summary: "可恢复工作已经完成并回读" }],
    ownerRevision: 2,
    sendGeneration: 3,
  });
  assert.equal(completed.result.task.lifecycleState, "completed");
  const metadata = await import("node:fs/promises").then(({ lstat }) => lstat(path));
  assert.equal(metadata.mode & 0o077, 0);
  assert.doesNotMatch(await readFile(path, "utf8"), /token\s*[:=]/iu);
});

test("task ledger stores only a bounded generation-specific historical summary", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-summary-ledger-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new FoursdayTaskLedgerStore({ path: join(root, "ledger.json") })
    .open({ createParent: true });
  const first = await store.recordSummary({
    taskId,
    title: "核对单词试题生产数量",
    ownerRevision: 4,
    sendGeneration: 8,
  });
  assert.equal(first.result.updated, true);
  const duplicate = await store.recordSummary({
    taskId,
    title: "核对单词试题生产数量",
    ownerRevision: 4,
    sendGeneration: 8,
  });
  assert.equal(duplicate.result.updated, false);
  assert.equal((await store.snapshot()).summaries[taskId].title, "核对单词试题生产数量");
  await assert.rejects(store.recordSummary({
    taskId,
    title: "token=do-not-store",
    ownerRevision: 5,
    sendGeneration: 9,
  }), /summary title is invalid/u);
});

test("task ledger promotes, acknowledges, leases, retries and completes one durable execution", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-long-task-ledger-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new FoursdayTaskLedgerStore({ path: join(root, "ledger.json") })
    .open({ createParent: true });
  const planned = await store.setExecutionPlan({
    taskId,
    expectedClass: "foreground",
    planSummary: "读取项目文件、运行分析并回读结果",
    stepCount: 3,
    requiresExternalWait: false,
    requiresDurability: false,
    acknowledgment: "收到，我先完成项目分析，整理好证据后再同步结果。",
    ownerRevision: 2,
    sendGeneration: 4,
  });
  assert.equal(planned.result.execution.mode, "foreground");
  await store.observeExecutionActivity({
    taskId, ownerRevision: 2, sendGeneration: 4,
    elapsedMs: 21_000, kind: "read",
  });
  const promoted = await store.observeExecutionActivity({
    taskId, ownerRevision: 2, sendGeneration: 4,
    elapsedMs: 22_000, kind: "test",
  });
  assert.equal(promoted.result.promoted, true);
  assert.equal(promoted.result.execution.state, "ack_pending");
  const identity = promoted.result.execution.executionId;
  const acknowledged = await store.acknowledgeExecution({
    taskId, executionId: identity, ownerRevision: 2, sendGeneration: 4,
  });
  assert.equal(acknowledged.result.execution.state, "acknowledged");
  const queued = await store.queueExecution({
    taskId, executionId: identity, ownerRevision: 2, sendGeneration: 4,
  });
  assert.equal(queued.result.execution.state, "queued");
  const leased = await store.leaseExecution({
    taskId, executionId: identity, ownerRevision: 2, sendGeneration: 4,
  });
  assert.equal(leased.result.execution.state, "running");
  assert.equal(leased.result.execution.attemptCount, 1);
  const retry = await store.retryExecution({
    taskId, executionId: identity, ownerRevision: 2, sendGeneration: 4,
    errorCode: "background_turn_failed",
  });
  assert.equal(retry.result.execution.state, "queued");
  await store.leaseExecution({
    taskId, executionId: identity, ownerRevision: 2, sendGeneration: 4,
  });
  const completed = await store.finishExecution({
    taskId, executionId: identity, ownerRevision: 2, sendGeneration: 4,
    outcome: "completed",
  });
  assert.equal(completed.result.execution.state, "completed");
  await assert.rejects(store.acknowledgeExecution({
    taskId, executionId: identity, ownerRevision: 2, sendGeneration: 5,
  }), /revision_conflict/u);
});

test("semantic durability and external waiting force background mode before tools", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-long-task-plan-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new FoursdayTaskLedgerStore({ path: join(root, "ledger.json") })
    .open({ createParent: true });
  const planned = await store.setExecutionPlan({
    taskId,
    expectedClass: "foreground",
    planSummary: "等待构建完成后继续验证",
    stepCount: 2,
    requiresExternalWait: true,
    requiresDurability: false,
    acknowledgment: "收到，我会等待构建并完成验证后再同步。",
    ownerRevision: 1,
    sendGeneration: 1,
  });
  assert.equal(planned.result.execution.mode, "background");
  assert.equal(planned.result.execution.state, "ack_pending");
  assert.doesNotMatch(JSON.stringify(await store.snapshot()), /current_user_request|reasoning/iu);
});

test("a foreground task gets one 15 second acknowledgment without becoming durable", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-normal-task-plan-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new FoursdayTaskLedgerStore({ path: join(root, "ledger.json") })
    .open({ createParent: true });
  await store.setExecutionPlan({
    taskId,
    expectedClass: "foreground",
    planSummary: "核对一个项目文件并回复结论",
    stepCount: 2,
    acknowledgment: "收到，我正在核对项目资料，完成后同步结果。",
    ownerRevision: 1,
    sendGeneration: 1,
  });
  const before = await store.observeExecutionActivity({
    taskId, ownerRevision: 1, sendGeneration: 1, elapsedMs: 14_999, kind: "read",
  });
  assert.equal(before.result.execution.state, "foreground");
  const pending = await store.observeExecutionActivity({
    taskId, ownerRevision: 1, sendGeneration: 1, elapsedMs: 15_000, kind: "verify",
  });
  assert.equal(pending.result.execution.mode, "foreground");
  assert.equal(pending.result.execution.state, "ack_pending");
  assert.equal(pending.result.promoted, false);
  const acknowledged = await store.acknowledgeExecution({
    taskId,
    executionId: pending.result.execution.executionId,
    ownerRevision: 1,
    sendGeneration: 1,
  });
  assert.equal(acknowledged.result.execution.state, "acknowledged");
  assert.equal(acknowledged.result.execution.requiresDurability, false);
});

test("task ledger rejects self-acceptance, stale generations, missing proof and secrets", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-ledger-negative-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new FoursdayTaskLedgerStore({ path: join(root, "ledger.json") })
    .open({ createParent: true });
  const base = {
    taskId,
    projectId: "foursday",
    title: "验证任务",
    goal: "证明任务状态可靠。",
    deliverables: [],
    acceptanceCriteria: ["有验证证据"],
    lifecycleState: "working",
    confidence: 0.9,
    evidence: [],
    ownerRevision: 4,
    sendGeneration: 8,
  };
  await store.upsertFromAgent(base);
  await assert.rejects(
    store.upsertFromAgent({ ...base, lifecycleState: "accepted" }),
    /update is invalid/u,
  );
  await assert.rejects(
    store.upsertFromAgent({ ...base, lifecycleState: "waiting_acceptance" }),
    /requires verified evidence/u,
  );
  await assert.rejects(
    store.upsertFromAgent({ ...base, ownerRevision: 3, sendGeneration: 9 }),
    /revision_conflict/u,
  );
  await assert.rejects(
    store.upsertFromAgent({ ...base, goal: "token=do-not-store-this" }),
    /goal is invalid/u,
  );
});

test("task ledger keeps a bounded idempotent activity trail before or after the contract", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-activity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new FoursdayTaskLedgerStore({ path: join(root, "ledger.json") })
    .open({ createParent: true });
  const first = await store.appendActivity({
    taskId,
    ownerRevision: 1,
    sendGeneration: 2,
    activity: {
      eventId: "b".repeat(64),
      kind: "read",
      summary: "正在读取项目文件",
      detail: "README.md",
      occurredAt: "2026-08-31T12:00:00.000Z",
    },
  });
  assert.equal(first.result.appended, true);
  const duplicate = await store.appendActivity({
    taskId,
    ownerRevision: 1,
    sendGeneration: 2,
    activity: first.result.activity,
  });
  assert.equal(duplicate.result.appended, false);
  assert.equal(duplicate.revision, first.revision);
  for (let index = 0; index < 24; index += 1) {
    await store.appendActivity({
      taskId,
      ownerRevision: 1,
      sendGeneration: 2,
      activity: {
        eventId: index.toString(16).padStart(64, "0"),
        kind: "test",
        summary: `测试步骤 ${index}`,
        detail: "自动测试",
        occurredAt: new Date(Date.UTC(2026, 7, 31, 12, 1, index)).toISOString(),
      },
    });
  }
  const snapshot = await store.snapshot();
  assert.equal(snapshot.activities[taskId].length, 20);
  assert.equal(snapshot.activities[taskId].at(-1).summary, "测试步骤 23");
  await assert.rejects(store.appendActivity({
    taskId,
    ownerRevision: 1,
    sendGeneration: 2,
    activity: {
      eventId: "c".repeat(64), kind: "tool", summary: "token=secret", detail: "",
      occurredAt: "2026-08-31T12:00:00.000Z",
    },
  }), /activity summary is invalid/u);
});

test("concurrent activity events are serialized without loss", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-activity-race-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new FoursdayTaskLedgerStore({ path: join(root, "ledger.json") })
    .open({ createParent: true });
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.appendActivity({
    taskId,
    ownerRevision: 1,
    sendGeneration: 1,
    activity: {
      eventId: (index + 32).toString(16).padStart(64, "0"),
      kind: "tool",
      summary: `并发活动 ${index}`,
      detail: "受控工具调用",
      occurredAt: new Date(Date.UTC(2026, 7, 31, 12, 2, index)).toISOString(),
    },
  })));
  const snapshot = await store.snapshot();
  assert.equal(snapshot.activities[taskId].length, 12);
  assert.equal(new Set(snapshot.activities[taskId].map((item) => item.eventId)).size, 12);
});

test("task ledger rejects an activity document above the global capacity", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-activity-capacity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const path = join(root, "ledger.json");
  const event = {
    eventId: "f".repeat(64),
    kind: "read",
    summary: "读取",
    detail: "文件",
    occurredAt: "2026-08-31T12:00:00.000Z",
  };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, `${JSON.stringify({
    schema: "foursday-task-ledger/v1",
    revision: 1,
    tasks: {},
    activities: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [
      index.toString(16).padStart(64, "0"),
      Array.from({ length: 20 }, (__, row) => ({
        ...event,
        eventId: `${index.toString(16).padStart(62, "0")}${row.toString(16).padStart(2, "0")}`,
      })),
    ])),
  })}\n`, { mode: 0o600 }));
  const store = await new FoursdayTaskLedgerStore({ path }).open();
  await assert.rejects(store.snapshot(), /activity capacity is invalid/u);
});
