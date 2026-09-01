import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryCoordinator } from "../src/foursday-delivery-coordinator.mjs";

function state() {
  return {
    sendLedger: {},
    sendBlocked: false,
    sendBlockReason: null,
    sendBlockedAt: null,
    manualReplyProbe: { ready: null, errorCode: null, updatedAt: null },
    deferredReply: {
      waiting: false, attemptCount: 0, errorCode: null,
      expiresAt: null, updatedAt: null,
    },
  };
}

function create({ sendEnabled = true, sendMessage } = {}) {
  const runtimeState = state();
  const dws = {
    hasManualReply: async () => ({ known: true, replied: false }),
    sendMessage: sendMessage ?? (async () => ({ messageId: "server-message" })),
    verifySendReceipt: () => {},
  };
  const coordinator = createDeliveryCoordinator({
    sendEnabled,
    selfUserId: "owner",
    outboundQuietMs: 0,
    outboundMaxQuietMs: 0,
    dws,
    state: runtimeState,
    persist: async () => {},
    diagnose: () => {},
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    clock: () => Date.parse("2026-09-01T00:00:00.000Z"),
    wait: async () => {},
    recipients: new Map([["conversation", {
      recipientId: "requester", recipientKind: "user_id", chatType: "direct",
    }]]),
    activeConversations: new Map([["conversation", {
      after: "2026-09-01T00:00:00.000Z",
      observedAt: "2026-09-01T00:00:00.000Z",
      detectionLatencyMs: 0,
    }]]),
    replyFenceCurrent: async () => true,
  });
  return { coordinator, runtimeState };
}

const payload = {
  conversationId: "conversation",
  content: "任务已完成",
  replyTo: "source-message",
  ownerRevision: 2,
  sendGeneration: 3,
};

test("delivery coordinator owns successful intent and server receipt", async () => {
  const { coordinator, runtimeState } = create();
  assert.deepEqual(await coordinator.send(payload), {
    success: true,
    messageId: "server-message",
    receiptKind: "server",
  });
  const [entry] = Object.values(runtimeState.sendLedger);
  assert.equal(entry.status, "completed");
  assert.equal(entry.messageId, "server-message");
  assert.equal(runtimeState.deferredReply.waiting, false);
});

test("delivery coordinator fails closed after an unknown transport outcome", async () => {
  const { coordinator, runtimeState } = create({
    sendMessage: async () => { throw new Error("network"); },
  });
  const result = await coordinator.send(payload);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(runtimeState.sendBlocked, true);
  assert.equal(runtimeState.sendBlockReason, "transport_exception_after_intent");
  assert.equal(Object.values(runtimeState.sendLedger)[0].status, "unknown");
});

test("delivery coordinator keeps Shadow transport write-free", async () => {
  let sends = 0;
  const { coordinator } = create({
    sendEnabled: false,
    sendMessage: async () => { sends += 1; },
  });
  await coordinator.start();
  const result = await coordinator.send(payload);
  assert.equal(result.sendDisabled, true);
  assert.equal(sends, 0);
});
