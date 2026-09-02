import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createTaskCoordinator } from "../src/foursday-task-coordinator.mjs";

function taskKey(conversationId, userId) {
  return createHash("sha256").update(`${conversationId}:${userId}`).digest("hex");
}

function create() {
  const state = {
    recentMessageIds: [], recipients: {}, activeConversations: {},
    takeoverReported: [], controlStates: {},
  };
  const recipients = new Map();
  const activeConversations = new Map();
  const takeoverReported = new Set();
  const controlStates = new Map();
  const events = [];
  const observed = [];
  const released = [];
  const coordinator = createTaskCoordinator({
    selfUserId: "owner",
    dws: {},
    state,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    diagnose: () => {},
    diagnosticHash: String,
    taskKey,
    taskBoundaryResolver: async () => ({ intent: "new_task", source: "codex", confidence: 1 }),
    responsibilityGroupingResolver: async (messages) => ({
      groups: [messages.map((_message, index) => index)], source: "codex", confidence: 1,
    }),
    responseDutyResolver: async () => ({
      decision: "action_required", source: "codex", confidence: 1,
    }),
    controlStore: {
      snapshot: async () => ({ global: { state: "running" }, tasks: {} }),
      observeTask: async (value) => observed.push(value),
    },
    recipients,
    activeConversations,
    takeoverReported,
    controlStates,
    seen: new Set(),
    ownerIntervention: {
      classify: async () => ({ intent: "unrelated_owner_message" }),
      dispatch: async () => {},
      observeTaskText: () => {},
    },
    responsibilityControl: {
      ensureWake: async () => true,
      releaseConversation: async (...args) => released.push(args),
      replayPending: async () => {},
    },
    cancelExecutionGeneration: async () => {},
    emit: (value) => events.push(value),
  });
  return {
    coordinator, state, recipients, activeConversations, controlStates,
    events, observed, released,
  };
}

test("task coordinator owns one inbound task generation", async () => {
  const runtime = create();
  await runtime.coordinator.emitMessage({
    id: "message-1",
    conversationId: "conversation",
    senderUserId: "requester",
    senderOpenDingTalkId: "requester-openid",
    senderName: "同事",
    content: "请处理这个任务",
    createTime: "2026-09-01T00:00:00.000Z",
    enterpriseVerified: true,
    detectedAt: "2026-09-01T00:00:00.000Z",
    detectionLatencyMs: 1_200,
    checkToDetectionMs: 400,
    wakeSource: "dws_event",
  }, "direct", false);
  assert.equal(runtime.events.length, 1);
  assert.equal(runtime.events[0].record.sendGeneration, 1);
  assert.equal(runtime.recipients.get("conversation").recipientKind, "open_dingtalk_id");
  assert.equal(runtime.activeConversations.get("conversation").sourceMessageId, "message-1");
  assert.equal(runtime.activeConversations.get("conversation").checkToDetectionMs, 400);
  assert.equal(runtime.events[0].record.checkToDetectionMs, 400);
  assert.equal(runtime.controlStates.get("conversation").sendGeneration, 1);
  assert.equal(runtime.observed.length, 1);
  assert.deepEqual(runtime.state.recentMessageIds, ["message-1"]);
});

test("task coordinator turns withdrawal into responsibility release", async () => {
  const runtime = create();
  await runtime.coordinator.emitMessage({
    id: "message-withdrawn",
    conversationId: "conversation",
    senderUserId: "requester",
    content: "已撤回",
    createTime: "2026-09-01T00:00:00.000Z",
    isWithdrawn: true,
    withdrawnAt: "2026-09-01T00:00:01.000Z",
  }, "direct", false);
  assert.deepEqual(runtime.released, [["conversation", "message-withdrawn"]]);
  assert.equal(runtime.events[0].record.control, "message_withdrawn");
});
