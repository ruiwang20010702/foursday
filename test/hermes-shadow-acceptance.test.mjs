import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHermesShadowAcceptance } from "../src/hermes-shadow-acceptance.mjs";

const releaseSha = "a".repeat(40);
const evidenceDigest = "b".repeat(64);
const evidence = { passed: true, releaseSha, evidenceDigest };

function completeEvents() {
  return [
    {
      type: "inbound",
      conversationHash: "conversation-hash",
      participantHash: "participant-hash",
      messageHashes: ["message-hash-1"],
      projectId: "vocab_2_2",
      routeStatus: "matched",
      memoryStatus: "available",
    },
    {
      type: "reply_attempt",
      conversationHash: "conversation-hash",
      replyToHash: "reply-to-1",
      deliveryContextHash: "delivery-1",
      contentHash: "c".repeat(64),
      contentBytes: 120,
      mode: "shadow",
      bridgeSuccess: false,
      outcomeUnknown: false,
    },
    {
      type: "inbound",
      conversationHash: "conversation-hash",
      participantHash: "participant-hash",
      messageHashes: ["message-hash-2"],
      projectId: "vocab_2_2",
      routeStatus: "bound",
      memoryStatus: "available",
    },
    {
      type: "communication_takeover",
      conversationHash: "conversation-hash",
      participantHash: "participant-hash",
    },
  ];
}

test("Foursday shadow 十项证据完整时生成不含正文的 acceptance", () => {
  const result = evaluateHermesShadowAcceptance({
    releaseSha,
    events: completeEvents(),
    restartEvidence: evidence,
    codeWorkEvidence: evidence,
    now: new Date("2026-08-18T12:00:00.000Z"),
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.receipt.schema, "foursday-shadow-acceptance/v1");
  assert.equal(result.receipt.releaseSha, releaseSha);
  assert.match(result.receipt.evidenceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(Object.values(result.receipt.scenarios).every(Boolean), true);
  assert.doesNotMatch(JSON.stringify(result), /message body|natural reply/u);
});

test("Foursday shadow 缺追问、接管或代码证据时只返回缺口", () => {
  const events = completeEvents().filter((event, index) => index < 2);
  const result = evaluateHermesShadowAcceptance({
    releaseSha,
    events,
    restartEvidence: evidence,
    codeWorkEvidence: { ...evidence, passed: false },
  });
  assert.equal(result.valid, false);
  assert.equal(result.receipt, null);
  assert.ok(result.missing.includes("followup"));
  assert.ok(result.missing.includes("ownerIntervention"));
  assert.ok(result.missing.includes("codeWork"));
});

test("Foursday shadow 重复消息哈希和错提交证据不能通过", () => {
  const events = completeEvents();
  events[2].messageHashes = ["message-hash-1"];
  const result = evaluateHermesShadowAcceptance({
    releaseSha,
    events,
    restartEvidence: { ...evidence, releaseSha: "d".repeat(40) },
    codeWorkEvidence: evidence,
  });
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("restartRecovery"));
  assert.ok(result.missing.includes("noDuplicate"));
});

test("Foursday shadow 同一自然回复被重试时不能通过无重复门禁", () => {
  const events = completeEvents();
  events.push({ ...events[1] });
  const result = evaluateHermesShadowAcceptance({
    releaseSha,
    events,
    restartEvidence: evidence,
    codeWorkEvidence: evidence,
  });
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("noDuplicate"));
});
