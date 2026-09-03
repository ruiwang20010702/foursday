import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTaskReconciliationCoordinator } from "../src/foursday-task-reconciliation.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

test("stale linked tasks enter one silent Codex reconciliation and retry only on due or new registry", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-reconcile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const participant = "trusted-user";
  const conversation = "direct-conversation";
  const taskId = sha(`${conversation}:${participant}`);
  const source = {
    sourceId: "provided_1",
    kind: "doc",
    nodeId: "EXACTDINGTALKDOCUMENTNODE12345678",
    messageHash: "b".repeat(64),
    requesterRole: "trusted",
  };
  const contextPath = join(root, "contexts.json");
  const registryPath = join(root, "projects.json");
  await writeFile(contextPath, `${JSON.stringify({
    schemaVersion: 1,
    contexts: {
      expired_but_private_source_binding: {
        sourceSessionHash: taskId,
        sourcePrincipalHash: sha(participant),
        sourceScope: "direct",
        requesterRole: "trusted",
        providedDingtalkSources: [source],
      },
    },
  })}\n`, { mode: 0o600 });
  await writeFile(registryPath, '{"schemaVersion":2,"workspaces":[],"scopes":[]}\n', { mode: 0o600 });
  const contract = {
    lifecycleState: "escalated",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
  const state = {};
  const emitted = [];
  let persisted = 0;
  let clock = new Date("2026-09-03T04:00:00.000Z");
  const coordinator = createTaskReconciliationCoordinator({
    enabled: true,
    workContextFile: contextPath,
    projectRegistryFile: registryPath,
    taskLedgerStore: { snapshot: async () => ({ tasks: { [taskId]: contract } }) },
    controlStore: { snapshot: async () => ({ tasks: { [taskId]: {
      state: "active",
      projectId: "shared_link",
      requester: { displayName: "项目同事", channel: "dingtalk_direct" },
      ownerRevision: 0,
      sendGeneration: 1,
    } } }) },
    activeConversations: new Map([[conversation, {
      participantUserId: participant,
      participantOpenDingTalkId: "open-participant",
      sourceMessageId: "source-message",
      chatType: "direct",
      enterpriseVerified: true,
    }]]),
    state,
    persist: async () => { persisted += 1; },
    emit: (frame) => emitted.push(frame),
    taskKey: (conversationId, userId) => sha(`${conversationId}:${userId}`),
    now: () => clock,
  });
  assert.deepEqual(await coordinator.run(), { queued: 1, skipped: false });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].record.internalReconciliation, true);
  assert.equal(emitted[0].record.wakeSource, "reconciliation");
  assert.deepEqual(emitted[0].record.providedDingtalkSources, [source]);
  assert.equal(JSON.stringify(emitted[0]).includes("权限申请"), false);
  assert.ok(persisted >= 2);
  assert.deepEqual(await coordinator.run(), { queued: 0, skipped: false });
  contract.updatedAt = "2026-09-03T04:00:30.000Z";
  assert.deepEqual(await coordinator.run(), { queued: 0, skipped: false });
  await writeFile(registryPath, '{"schemaVersion":2,"workspaces":[{"id":"new"}],"scopes":[]}\n', { mode: 0o600 });
  clock = new Date("2026-09-03T04:01:00.000Z");
  assert.deepEqual(await coordinator.run(), { queued: 1, skipped: false });
  contract.lifecycleState = "completed";
  assert.deepEqual(await coordinator.run(), { queued: 0, skipped: false });
  assert.equal(state.taskReconciliations[taskId], undefined);
});

test("reconciliation rejects a source binding that does not match the live requester", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-reconcile-mismatch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = "a".repeat(64);
  const contextPath = join(root, "contexts.json");
  const registryPath = join(root, "projects.json");
  await writeFile(contextPath, `${JSON.stringify({
    schemaVersion: 1,
    contexts: { one: {
      sourceSessionHash: taskId,
      sourcePrincipalHash: "b".repeat(64),
      sourceScope: "direct",
      requesterRole: "trusted",
      providedDingtalkSources: [{
        sourceId: "provided_1", kind: "doc",
        nodeId: "EXACTDINGTALKDOCUMENTNODE12345678",
        messageHash: "c".repeat(64), requesterRole: "trusted",
      }],
    } },
  })}\n`, { mode: 0o600 });
  await writeFile(registryPath, '{"schemaVersion":2}\n', { mode: 0o600 });
  const emitted = [];
  const coordinator = createTaskReconciliationCoordinator({
    enabled: true,
    workContextFile: contextPath,
    projectRegistryFile: registryPath,
    taskLedgerStore: { snapshot: async () => ({ tasks: { [taskId]: { lifecycleState: "escalated" } } }) },
    controlStore: { snapshot: async () => ({ tasks: { [taskId]: {
      state: "active", ownerRevision: 0, sendGeneration: 1,
    } } }) },
    activeConversations: new Map([["conversation", {
      participantUserId: "different-user", sourceMessageId: "message", chatType: "direct",
    }]]),
    state: {}, persist: async () => {}, emit: (frame) => emitted.push(frame),
    taskKey: () => taskId,
  });
  assert.deepEqual(await coordinator.run(), { queued: 0, skipped: false });
  assert.deepEqual(emitted, []);
});

test("an explicitly disabled reconciliation coordinator remains inert", async () => {
  const coordinator = createTaskReconciliationCoordinator({
    enabled: false,
    activeConversations: new Map(),
    state: {},
    persist: async () => {},
    emit: () => { throw new Error("must not emit"); },
    taskKey: () => "a".repeat(64),
  });
  assert.deepEqual(await coordinator.run(), { queued: 0, skipped: true });
  coordinator.start();
  coordinator.stop();
});
