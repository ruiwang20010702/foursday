import assert from "node:assert/strict";
import test from "node:test";
import { createMessageIngress } from "../src/foursday-message-ingress.mjs";

function runtimeState() {
  return {
    lastUsers: {}, lastGroups: {}, lastEnterpriseAt: null,
    lastCheckAt: null, lastFullSuccessAt: null, lastErrorCount: 0,
    lastWakeSource: null, lastDetection: null,
    checkLifecycle: {
      status: "idle", generation: 0, operation: null,
      wakeSource: null, startedAt: null, completedAt: null, errorCount: 0,
    },
    manualReplyProbe: { ready: null, errorCode: null, updatedAt: null },
  };
}

function create({ fetchBySender, now } = {}) {
  const state = runtimeState();
  const emitted = [];
  const taskMessages = [];
  const ingress = createMessageIngress({
    userIds: ["requester"],
    dws: {
      fetchBySender: fetchBySender ?? (async () => [{
        id: "message-1",
        conversationId: "conversation",
        senderUserId: "requester",
        content: "处理任务",
        createTime: "2026-09-01T00:00:00.000Z",
      }]),
    },
    state,
    persist: async () => {},
    persistCheckHealth: async () => {},
    now: now ?? (() => new Date("2026-09-01T00:02:00.000Z")),
    emit: (value) => emitted.push(value),
    diagnose: () => {},
    diagnosticHash: String,
    taskKey: (conversationId, userId) => `${conversationId}:${userId}`,
    enterpriseIdentity: {
      retry: async () => [], enqueue: () => {}, reject: () => {},
      attachRetryKey: (value) => value, resolve: () => {},
    },
    deliveryControl: {
      automatedEvidence: () => [],
      probeManualReply: async () => ({ known: true, replied: false }),
    },
    taskControl: {
      emitMessage: async (...args) => taskMessages.push(args),
    },
    activeConversations: new Map(),
    takeoverReported: new Set(),
    controlStates: new Map(),
    controlStore: null,
    ownerIntervention: { classify: async () => {}, dispatch: async () => {} },
  });
  return { ingress, state, emitted, taskMessages };
}

test("message ingress owns target read, ordering and checkpoint advancement", async () => {
  const runtime = create();
  const frames = await runtime.ingress.performCheck({ wakeSource: "manual" });
  assert.deepEqual(frames, []);
  assert.equal(runtime.taskMessages.length, 1);
  assert.equal(runtime.taskMessages[0][0].detectionLatencyMs, 120_000);
  assert.equal(runtime.taskMessages[0][0].checkToDetectionMs, 0);
  assert.equal(runtime.state.lastUsers.requester, "2026-09-01T00:00:00.000Z");
  assert.equal(runtime.state.checkLifecycle.status, "completed");
  assert.equal(runtime.state.checkLifecycle.generation, 1);
});

test("message ingress measures detection when the DWS read actually completes", async () => {
  let current = Date.parse("2026-09-01T00:02:00.000Z");
  const runtime = create({
    fetchBySender: async () => {
      current += 800;
      return [{
        id: "message-1", conversationId: "conversation", senderUserId: "requester",
        content: "处理任务", createTime: "2026-09-01T00:00:00.000Z",
      }];
    },
    now: () => new Date(current),
  });
  await runtime.ingress.performCheck({ wakeSource: "dws_event" });
  assert.equal(runtime.taskMessages[0][0].detectionLatencyMs, 120_800);
  assert.equal(runtime.taskMessages[0][0].checkToDetectionMs, 800);
  assert.equal(runtime.taskMessages[0][0].detectedAt, "2026-09-01T00:02:00.800Z");
});

test("message ingress keeps a failed target behind its checkpoint", async () => {
  const runtime = create({
    fetchBySender: async () => {
      const error = new Error("unavailable");
      error.code = "backend_unavailable";
      throw error;
    },
  });
  await assert.rejects(
    runtime.ingress.performCheck({ wakeSource: "manual" }),
    (error) => error.code === "DWS_SIDECAR_TARGETS_UNAVAILABLE",
  );
  assert.equal(runtime.state.lastUsers.requester, undefined);
  assert.equal(runtime.state.checkLifecycle.status, "failed");
  assert.equal(runtime.state.lastErrorCount, 1);
});
