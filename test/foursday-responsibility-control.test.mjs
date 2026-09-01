import assert from "node:assert/strict";
import test from "node:test";
import { createResponsibilityCoordinator } from "../src/foursday-responsibility-control.mjs";

function runtimeState() {
  return {
    responsibilityReactions: {},
    reactionAutomationOps: [],
    pendingOwnerReactions: {},
    recentReactionEventIds: [],
    reactionWake: {
      enabled: false, readyCount: 0, errorCount: 0,
      lastErrorCode: null, updatedAt: null,
    },
  };
}

function activeConversation() {
  return {
    participantUserId: "requester",
    participantOpenDingTalkId: "requester-openid",
    chatType: "direct",
    sourceMessageId: "message-1",
    ownerRevision: 2,
    sendGeneration: 3,
    enterpriseVerified: true,
  };
}

function coordinator({ sendEnabled = false, takeoverForReaction = async () => {} } = {}) {
  const state = runtimeState();
  const activeConversations = new Map([["conversation", activeConversation()]]);
  const control = createResponsibilityCoordinator({
    enabled: true,
    sendEnabled,
    selfUserId: "owner",
    dws: {
      resolveCurrentUserOpenDingTalkId: async () => "owner-openid",
      resolveUserOpenDingTalkId: async () => "requester-openid",
      createReactionEventWake: () => ({ ready: Promise.resolve(), stop: async () => {} }),
      addEmojiReaction: async () => ({ success: true }),
      removeEmojiReaction: async () => ({ success: true }),
    },
    state,
    persist: async () => {},
    diagnose: () => {},
    diagnosticHash: String,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    clock: () => Date.parse("2026-09-01T00:00:00.000Z"),
    activeConversations,
    isTakenOver: () => false,
    currentControl: () => ({ ownerRevision: 2, sendGeneration: 3, lastOwnerMessageId: null }),
    takeoverForReaction,
  });
  return { control, state };
}

test("responsibility coordinator keeps Shadow claims write-free", async () => {
  const { control, state } = coordinator({ sendEnabled: false });
  const result = await control.claim({
    conversationId: "conversation",
    messageId: "message-1",
    sourceMessageIds: ["message-1"],
    ownerRevision: 2,
    sendGeneration: 3,
  });
  assert.deepEqual(result, { success: true, sendDisabled: true });
  const [entry] = Object.values(state.responsibilityReactions);
  assert.equal(entry.status, "shadow");
  assert.equal(state.reactionAutomationOps.length, 0);
  await control.stop();
});

test("responsibility coordinator turns an owner reaction into one takeover", async () => {
  const takeovers = [];
  const { control } = coordinator({
    takeoverForReaction: async (value) => takeovers.push(value),
  });
  await control.handleEvent({
    eventId: "event-1",
    conversationId: "conversation",
    messageId: "message-1",
    operatorOpenDingTalkId: "owner-openid",
    senderOpenDingTalkId: "requester-openid",
    reactionName: "OK",
    action: "added",
    occurredAt: "2026-09-01T00:00:01.000Z",
  });
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0].event.eventId, "event-1");
  await control.stop();
});
