import assert from "node:assert/strict";
import test from "node:test";
import { createEnterpriseIdentityCoordinator } from "../src/foursday-enterprise-identity.mjs";

function message(id, identity = "openid-a") {
  return {
    id,
    senderUserId: null,
    senderOpenDingTalkId: identity,
    senderName: "同事",
    conversationId: "conversation",
    content: "测试任务",
    createTime: "2026-09-01T00:00:00.000Z",
    singleChat: true,
    media: [],
  };
}

function state() {
  return {
    enterpriseIdentityQueue: {},
    enterpriseIdentityRejectedIds: [],
    enterpriseIdentityRejections: { count: 0, lastAt: null, lastErrorCode: null },
  };
}

test("enterprise identity coordinator owns enqueue, retry and resolve", async () => {
  const runtimeState = state();
  const diagnostics = [];
  const dws = {
    retryEnterpriseDirectMessage: async (value) => ({ ...value, enterpriseVerified: true }),
  };
  const coordinator = createEnterpriseIdentityCoordinator({
    dws,
    state: runtimeState,
    seen: new Set(),
    diagnose: (value) => diagnostics.push(value),
    diagnosticHash: (value) => `hash:${value}`,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  const key = coordinator.enqueue({
    message: message("message-1"),
    errorCode: "directory_timeout",
  }, new Date("2026-09-01T00:00:00.000Z"));
  assert.match(key, /^[a-f0-9]{64}$/u);
  assert.equal(coordinator.pendingCount(), 1);
  const recovered = await coordinator.retry(new Date("2026-09-01T00:00:06.000Z"));
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].enterpriseIdentityRetryKey, key);
  assert.equal(coordinator.resolve(key, "message-1"), true);
  assert.equal(coordinator.pendingCount(), 0);
  assert.deepEqual(runtimeState.enterpriseIdentityQueue, {});
  assert.equal(diagnostics.length, 2);
});

test("enterprise identity coordinator enforces per-identity capacity", () => {
  const runtimeState = state();
  const coordinator = createEnterpriseIdentityCoordinator({
    dws: {},
    state: runtimeState,
    seen: new Set(),
    diagnose: () => {},
    diagnosticHash: String,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    retryCapacity: 32,
  });
  for (let index = 0; index < 8; index += 1) {
    assert.ok(coordinator.enqueue({
      message: message(`message-${index}`),
      errorCode: "directory_timeout",
    }, new Date("2026-09-01T00:00:00.000Z")));
  }
  assert.equal(coordinator.enqueue({
    message: message("message-overflow"),
    errorCode: "directory_timeout",
  }, new Date("2026-09-01T00:00:00.000Z")), null);
  assert.equal(coordinator.pendingCount(), 8);
  assert.equal(runtimeState.enterpriseIdentityRejections.count, 1);
  assert.equal(runtimeState.enterpriseIdentityRejections.lastErrorCode, "identity_retry_capacity_exceeded");
});
