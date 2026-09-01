import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerInterventionCoordinator } from "../src/foursday-owner-intervention-coordinator.mjs";

test("owner intervention coordinator carries bounded recent task context", async () => {
  const calls = [];
  const coordinator = createOwnerInterventionCoordinator({
    semanticClassifier: async (text, options) => {
      calls.push({ text, options });
      return { intent: "task_correction", source: "codex", confidence: 0.9 };
    },
    classifierEnvironment: { TEST: "true" },
    legacyClassifier: () => "communication_takeover",
    diagnosticHash: String,
    emit: () => {},
    applyControl: async () => {},
    recordIntervention: async () => {},
  });
  coordinator.observeTaskText("conversation", "原任务目标");
  const result = await coordinator.classify("改成新目标", {
    selfChat: true,
    taskActive: true,
    conversationId: "conversation",
  });
  assert.equal(result.intent, "task_correction");
  assert.equal(calls[0].options.recentTaskText, "原任务目标");
});

test("owner intervention coordinator applies one revisioned takeover event", async () => {
  const controls = [];
  const events = [];
  const records = [];
  const coordinator = createOwnerInterventionCoordinator({
    semanticClassifier: async () => ({
      intent: "communication_takeover", source: "codex", confidence: 1,
    }),
    legacyClassifier: () => "communication_takeover",
    diagnosticHash: (value) => `hash:${value}`,
    clock: () => Date.parse("2026-09-01T00:00:00.000Z"),
    emit: (event) => events.push(event),
    applyControl: async (value) => controls.push(value),
    recordIntervention: async (value) => records.push(value),
  });
  const control = await coordinator.dispatch({
    conversationId: "conversation",
    active: {
      participantUserId: "requester",
      chatType: "direct",
      sourceMessageId: "source",
      enterpriseVerified: true,
    },
    ownerMessageId: "owner-message",
    ownerContent: "我来回复",
    createTime: "2026-09-01T00:00:00.000Z",
    frozenControl: { ownerRevision: 4, sendGeneration: 7, lastOwnerMessageId: null },
    classification: {
      intent: "communication_takeover", source: "codex", confidence: 1,
    },
  });
  assert.equal(control.ownerRevision, 5);
  assert.equal(control.sendGeneration, 7);
  assert.equal(controls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].record.control, "communication_takeover");
  assert.equal(records.length, 1);
});

test("owner intervention semantic failure remains conservative", async () => {
  const coordinator = createOwnerInterventionCoordinator({
    semanticClassifier: async () => { throw new Error("unavailable"); },
    legacyClassifier: () => "unrelated_owner_message",
    diagnosticHash: String,
    emit: () => {},
    applyControl: async () => {},
    recordIntervention: async () => {},
  });
  assert.deepEqual(await coordinator.classify("不确定的介入", {
    selfChat: false,
    taskActive: true,
    conversationId: "conversation",
  }), {
    intent: "communication_takeover",
    source: "conservative_fallback",
    confidence: 0,
  });
});
