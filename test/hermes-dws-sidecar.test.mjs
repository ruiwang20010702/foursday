import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyOwnerIntervention,
  createSidecarRuntime,
  sidecarConfig,
} from "../src/hermes-dws-sidecar.mjs";
import { FoursdayControlStore } from "../src/foursday-control-store.mjs";

async function waitFor(predicate, { timeoutMs = 2_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((accept) => setTimeout(accept, intervalMs));
  }
  return true;
}

test("responsibility reaction configuration is bounded and disabled by default", () => {
  const defaults = sidecarConfig({ DWS_PATH: process.execPath });
  assert.equal(defaults.responsibilityReactionsEnabled, false);
  assert.equal(defaults.responsibilityReactionName, "OK");
  assert.throws(() => sidecarConfig({
    DWS_PATH: process.execPath,
    DWS_PERSONAL_RESPONSIBILITY_REACTION: "bad\nreaction",
  }), /reaction name is invalid/u);
});

test("sidecar exposes bounded Codex responsibility grouping only when enabled", async () => {
  const calls = [];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: [],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: null,
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      semanticInterventionTimeoutMs: 30_000,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: false,
    },
    dws: new FakeDws(),
    responsibilityGroupingResolver: async (messages) => {
      calls.push(messages);
      return { groups: [[0], [1]], confidence: 0.99, source: "codex" };
    },
  });
  try {
    assert.deepEqual(await runtime.groupResponsibilityMessages({
      messages: [
        { id: "message-1", content: "任务一" },
        { id: "message-2", content: "任务二" },
      ],
    }), {
      success: true,
      groups: [[0], [1]],
      source: "codex",
      confidence: 0.99,
    });
    assert.equal(calls.length, 1);
  } finally {
    await runtime.stop();
  }
});

test("owner intervention classifier keeps communication, task and unrelated ownership distinct", () => {
  assert.equal(classifyOwnerIntervention("我已经回复对方了"), "communication_takeover");
  assert.equal(classifyOwnerIntervention("改成先核对全量口径"), "task_correction");
  assert.equal(classifyOwnerIntervention("这个任务我来处理"), "task_takeover");
  assert.equal(classifyOwnerIntervention("继续"), "resume_requested");
  assert.equal(classifyOwnerIntervention("今天天气不错", { active: false }), "unrelated_owner_message");
  assert.equal(
    classifyOwnerIntervention("重点看人工回复探针失败时", { explicitOnly: true }),
    "unrelated_owner_message",
  );
  assert.equal(
    classifyOwnerIntervention("我已经回复对方了", { explicitOnly: true }),
    "communication_takeover",
  );
});

test("external global pause preserves the unread message until exact resume", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-control-pause-sidecar-")));
  const controlFile = join(root, "control.json");
  const control = await new FoursdayControlStore({ path: controlFile }).open();
  await control.apply({ action: "pause_all", expectedRevision: 0 });
  const frames = [];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "dws.json"),
      mediaRoot: null,
      controlFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws: new FakeDws(),
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-24T10:00:00+08:00"),
  });
  try {
    await runtime.start();
    assert.equal(frames[0].type, "ready");
    const failed = JSON.parse(await readFile(join(root, "dws.json"), "utf8"));
    assert.equal(failed.checkLifecycle.status, "failed");
    await control.apply({ action: "resume_all", expectedRevision: 1 });
    const retry = await runtime.check({ deferEmit: true });
    assert.equal(retry.filter((frame) => frame.record?.id === "dws-1").length, 1);
    const state = JSON.parse(await readFile(join(root, "dws.json"), "utf8").catch(() => "{}"));
    assert.deepEqual(state.recentMessageIds ?? [], []);
  } finally {
    await runtime.stop();
  }
});

test("Hermes DWS sidecar announces transport readiness before a slow startup reconcile", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-slow-start-sidecar-")));
  const frames = [];
  let releaseFetch;
  let enteredFetch;
  const entered = new Promise((resolve) => { enteredFetch = resolve; });
  const blocked = new Promise((resolve) => { releaseFetch = resolve; });
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "dws.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws: {
      async fetchBySender() {
        enteredFetch();
        await blocked;
        return [];
      },
      async fetchGroupMentions() { return []; },
    },
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-26T16:00:00+08:00"),
  });
  try {
    const starting = runtime.start();
    await entered;
    assert.equal(frames[0].type, "ready");
    assert.equal(frames[0].reconciling, true);
    const running = JSON.parse(await readFile(join(root, "dws.json"), "utf8"));
    assert.equal(running.checkLifecycle.status, "running");
    releaseFetch();
    await starting;
  } finally {
    releaseFetch?.();
    await runtime.stop();
  }
});

test("external takeover revision blocks a stale reply before DWS transport", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-control-send-sidecar-")));
  const controlFile = join(root, "control.json");
  const dws = new FakeDws();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "dws.json"),
      mediaRoot: null,
      controlFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-24T10:00:00+08:00"),
  });
  await runtime.start();
  try {
    const control = await new FoursdayControlStore({ path: controlFile }).open();
    const task = createHash("sha256").update("conversation-1:trusted-user").digest("hex");
    const before = await control.snapshot();
    await control.apply({
      action: "communication_takeover",
      expectedRevision: before.revision,
      taskId: task,
    });
    const result = await runtime.send({
      conversationId: "conversation-1",
      content: "stale reply",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(result.staleGeneration, true);
    assert.equal(dws.sent.length, 0);
    const frames = await runtime.check({ deferEmit: true });
    const event = frames.find((frame) => frame.record?.controlEventId);
    assert.equal(event.record.taskId, task);
    assert.equal((await control.snapshot()).tasks[task].pendingEvent.consumed, false);
    assert.deepEqual(await runtime.ackControl({
      taskId: task,
      eventId: event.record.controlEventId,
    }), { success: true });
    assert.equal((await control.snapshot()).tasks[task].pendingEvent.consumed, true);
  } finally {
    await runtime.stop();
  }
});

class FakeDws {
  constructor() {
    this.sent = [];
    this.directCalls = 0;
    this.manualReply = false;
    this.manualReplyFailures = 0;
    this.manualReplyFailure = null;
    this.manualReplyCalls = 0;
    this.withdrawn = false;
    this.receiptWithoutMessageId = false;
    this.receiptUnknown = false;
    this.transportFailure = false;
    this.readBackMessage = null;
    this.media = false;
    this.downloadFailures = 0;
    this.eventWakeStopped = false;
    this.reactionWakeStopped = false;
    this.reactionWatchers = [];
    this.reactionWrites = [];
    this.reactionWakeFailure = false;
    this.downloadInputs = [];
    this.messages = null;
  }

  createPersonalEventWake({ onEvent }) {
    this.eventOnEvent = onEvent;
    return {
      ready: Promise.resolve({ ready: true }),
      stop: async () => { this.eventWakeStopped = true; },
    };
  }

  createReactionEventWake(input) {
    if (this.reactionWakeFailure) {
      throw Object.assign(new Error("reaction unavailable"), {
        code: "reaction_event_unavailable",
      });
    }
    const watcher = { ...input };
    this.reactionWatchers.push(watcher);
    return {
      ready: Promise.resolve({ ready: true }),
      stop: async () => { this.reactionWakeStopped = true; },
    };
  }

  async resolveUserOpenDingTalkId(userId) {
    return userId === "owner-user" ? "open-owner" : `open-${userId}`;
  }

  async addEmojiReaction(input) {
    this.reactionWrites.push({ action: "added", ...input });
    return { success: true };
  }

  async removeEmojiReaction(input) {
    this.reactionWrites.push({ action: "removed", ...input });
    return { success: true };
  }

  async fetchBySender({ senderUserId }) {
    this.directCalls += 1;
    return this.messages ?? [{
      id: "dws-1",
      senderUserId,
      senderOpenDingTalkId: "open-trusted",
      senderName: "娜娜老师",
      conversationId: "conversation-1",
      content: "2.2目前生产了多少试题？",
      createTime: "2026-08-18T14:00:00+08:00",
      isSelf: false,
      isWithdrawn: this.withdrawn,
      withdrawnAt: this.withdrawn ? "2026-08-18T14:00:30+08:00" : null,
      media: this.media ? [{
        resourceId: this.media === "file" ? "file-1" : "$media-1",
        resourceType: this.media === "file" ? "fileId" : "mediaId",
        name: this.media === "file" ? "report.txt" : "image.png",
        mimeType: this.media === "file" ? "text/plain" : "image/png",
      }] : [],
    }];
  }

  async fetchGroupMentions() {
    return [];
  }

  async fetchEnterpriseDirect() {
    return [];
  }

  async sendMessage(input) {
    this.sent.push(input);
    if (this.transportFailure) throw new Error("transport outcome unknown");
    return this.receiptWithoutMessageId
      ? { status: "SENT" }
      : { status: "SENT", messageId: "server-message-1" };
  }

  verifySendReceipt(receipt) {
    if (this.receiptUnknown) {
      const error = new Error("DWS send did not return an explicit success receipt");
      error.code = "dws_send_receipt_unknown";
      throw error;
    }
    assert.equal(receipt.status, "SENT");
  }

  async hasManualReply(input) {
    this.manualReplyCalls += 1;
    this.manualInput = input;
    if (this.manualReplyFailures > 0) {
      this.manualReplyFailures -= 1;
      if (this.manualReplyFailure) throw this.manualReplyFailure;
      const error = new Error("temporary manual reply lookup failure");
      error.code = "dws_manual_reply_temporary";
      throw error;
    }
    return {
      known: true,
      replied: this.manualReply,
      message: this.manualReply ? {
        id: "owner-message-1",
        content: "我已经回复对方了",
        createTime: "2026-08-18T14:00:30+08:00",
      } : null,
    };
  }

  async fetchDirect() {
    return this.readBackMessage ? [this.readBackMessage] : [];
  }

  async downloadMedia(input) {
    const { outputDirectory } = input;
    this.downloadInputs.push(input);
    if (this.downloadFailures > 0) {
      this.downloadFailures -= 1;
      throw new Error("temporary media failure");
    }
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const path = join(outputDirectory, "image.png");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { mode: 0o600 });
    return { path };
  }
}

test("self allowlist reads only the dedicated direct conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-self-direct-"));
  const frames = [];
  const calls = [];
  const dws = new FakeDws();
  let includeAutomatedReply = false;
  dws.fetchBySender = async ({ senderUserId }) => {
    calls.push(["sender", senderUserId]);
    return [];
  };
  dws.fetchDirect = async (input) => {
    calls.push(["direct", input.userId, input.identityKind]);
    const messages = [{
      id: "self-message-1",
      senderUserId: "owner-user",
      senderName: "Owner",
      conversationId: "self-conversation",
      content: "self shadow check",
      createTime: "2026-08-24T10:00:30+08:00",
      isSelf: true,
      isWithdrawn: false,
      media: [],
    }];
    if (includeAutomatedReply) {
      messages.push({
        id: "automated-self-message",
        senderUserId: "owner-user",
        senderName: "Owner",
        conversationId: "self-conversation",
        content: "automated reply",
        createTime: "2026-08-24T10:00:45+08:00",
        isSelf: true,
        isWithdrawn: false,
        media: [],
        raw: { aiTag: true },
      });
    }
    return messages;
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["owner-user", "trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-24T10:01:00+08:00"),
  });
  try {
    await runtime.start();
    assert.deepEqual(calls, [
      ["direct", "owner-user", "user_id"],
      ["sender", "trusted-user"],
    ]);
    assert.equal(frames.some((frame) =>
      frame.record?.conversationId === "self-conversation"), true);
    includeAutomatedReply = true;
    const retry = await runtime.check({ deferEmit: true });
    assert.equal(retry.some((frame) =>
      frame.record?.id === "automated-self-message"), false);
  } finally {
    await runtime.stop();
  }
});

test("enterprise mode scans verified organization direct messages without explicit user IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-enterprise-direct-"));
  const frames = [];
  const dws = new FakeDws();
  dws.fetchBySender = async () => [];
  let enterpriseCalls = 0;
  dws.fetchEnterpriseDirect = async ({ start, end, selfUserId }) => {
    enterpriseCalls += 1;
    assert.ok(start instanceof Date);
    assert.ok(end instanceof Date);
    assert.equal(end.getTime() - start.getTime() <= 120_000, true);
    assert.equal(end.getTime(), new Date("2026-08-26T14:00:50+08:00").getTime());
    assert.equal(selfUserId, "owner-user");
    return [{
      id: "enterprise-message-1",
      senderUserId: "enterprise-user",
      senderOpenDingTalkId: "open-enterprise",
      senderName: "Enterprise user",
      conversationId: "enterprise-conversation",
      content: "请处理这个项目问题",
      createTime: "2026-08-26T14:00:30+08:00",
      isSelf: false,
      isWithdrawn: false,
      enterpriseVerified: true,
      media: [],
    }];
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["owner-user"],
      groupIds: [],
      enterpriseUsersEnabled: true,
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 120_000,
      historySettleMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-26T14:01:00+08:00"),
  });
  try {
    await runtime.start();
    const event = frames.find((frame) => frame.record?.id === "enterprise-message-1");
    assert.ok(event);
    assert.equal(event.record.enterpriseVerified, true);
    assert.equal(event.record.chatType, "direct");
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.match(state.lastEnterpriseAt, /^2026-/u);
    assert.equal(enterpriseCalls, 1);
  } finally {
    await runtime.stop();
  }
});

test("task takeover suppresses later enterprise messages without poisoning the shared checkpoint", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-enterprise-taken-over-")));
  const controlFile = join(root, "control.json");
  const stateFile = join(root, "state.json");
  const control = await new FoursdayControlStore({ path: controlFile }).open();
  const conversationId = "taken-over-conversation";
  const senderUserId = "taken-over-user";
  const controlledTaskId = createHash("sha256")
    .update(`${conversationId}:${senderUserId}`)
    .digest("hex");
  await control.observeTask({
    taskId: controlledTaskId,
    ownerRevision: 0,
    sendGeneration: 1,
    lastInboundAt: "2026-08-26T14:00:00+08:00",
  });
  await control.apply({
    action: "task_takeover",
    expectedRevision: 1,
    taskId: controlledTaskId,
  });
  const frames = [];
  const diagnostics = [];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: [],
      groupIds: [],
      enterpriseUsersEnabled: true,
      selfUserId: "owner-user",
      stateFile,
      mediaRoot: null,
      controlFile,
      initialLookbackMs: 120_000,
      historySettleMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    controlStore: control,
    dws: {
      async fetchEnterpriseDirectScan() {
        return {
          messages: [{
            id: "message-after-takeover",
            senderUserId,
            senderOpenDingTalkId: "open-taken-over",
            senderName: "Taken over user",
            conversationId,
            content: "owner is handling this conversation",
            createTime: "2026-08-26T14:00:30+08:00",
            isSelf: false,
            isWithdrawn: false,
            enterpriseVerified: true,
            media: [],
          }],
          pending: [],
          rejected: [],
        };
      },
      async fetchBySender() { return []; },
      async fetchGroupMentions() { return []; },
    },
    emit: (frame) => frames.push(frame),
    diagnose: (value) => diagnostics.push(value),
    now: () => new Date("2026-08-26T14:01:00+08:00"),
  });
  try {
    await runtime.start();
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.checkLifecycle.status, "completed");
    assert.equal(state.lastErrorCount, 0);
    assert.match(state.lastEnterpriseAt, /^2026-/u);
    assert.equal(state.recentMessageIds.includes("message-after-takeover"), true);
    assert.equal(frames.some((frame) => frame.record?.id === "message-after-takeover"), false);
    assert.equal(
      diagnostics.some((value) => value.startsWith("dws_taken_over_message_suppressed:")),
      true,
    );
  } finally {
    await runtime.stop();
  }
});

test("enterprise identity retry survives restart and emits the recovered message exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-enterprise-identity-retry-"));
  const stateFile = join(root, "state.json");
  const diagnostics = [];
  const frames = [];
  let current = new Date("2026-08-27T10:33:00+08:00");
  let firstScan = true;
  let identityAvailable = false;
  const dws = {
    async fetchEnterpriseDirectScan() {
      if (!firstScan) return identityAvailable ? {
        messages: [{
          id: "identity-retry-message",
          senderUserId: "retry-employee",
          senderOpenDingTalkId: "open-retry",
          senderName: "Retry Employee",
          conversationId: "identity-retry-conversation",
          content: "retry me",
          createTime: "2026-08-27T10:32:10+08:00",
          singleChat: true,
          isSelf: false,
          enterpriseVerified: true,
          media: [],
        }],
        pending: [],
        rejected: [],
      } : { messages: [], pending: [], rejected: [] };
      firstScan = false;
      return {
        messages: [],
        pending: [{
          errorCode: "backend_dependency_unavailable",
          message: {
            id: "identity-retry-message",
            senderUserId: "open-retry",
            senderOpenDingTalkId: "open-retry",
            senderIdentitySource: "payload_open_id",
            senderName: "Retry Employee",
            conversationId: "identity-retry-conversation",
            content: "retry me",
            createTime: "2026-08-27T10:32:10+08:00",
            singleChat: true,
            isSelf: false,
            media: [],
          },
        }],
        rejected: [],
      };
    },
    async retryEnterpriseDirectMessage(message) {
      if (!identityAvailable) {
        const error = new Error("backend dependency unavailable");
        error.code = "backend_dependency_unavailable";
        throw error;
      }
      return {
        ...message,
        senderUserId: "retry-employee",
        senderOpenDingTalkId: "open-retry",
        enterpriseVerified: true,
      };
    },
    async fetchBySender() { return []; },
    async fetchGroupMentions() { return []; },
  };
  const config = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: [],
    groupIds: [],
    enterpriseUsersEnabled: true,
    selfUserId: null,
    stateFile,
    mediaRoot: null,
    initialLookbackMs: 120_000,
    historySettleMs: 120_000,
    fallbackMs: 300_000,
    eventWakeEnabled: false,
    outboundQuietMs: 8_000,
    outboundMaxQuietMs: 20_000,
    enterpriseIdentityRetryTtlMs: 30 * 60_000,
    enterpriseIdentityRetryMaxAttempts: 8,
    enterpriseIdentityRetryCapacity: 128,
    sendEnabled: false,
  };
  const first = await createSidecarRuntime({
    config,
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: (value) => diagnostics.push(value),
    now: () => current,
  });
  await first.start();
  await first.stop();
  let state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(Object.keys(state.enterpriseIdentityQueue).length, 1);
  assert.equal(frames.some((frame) => frame.record?.id === "identity-retry-message"), false);

  identityAvailable = true;
  current = new Date("2026-08-27T10:33:10+08:00");
  const second = await createSidecarRuntime({
    config,
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: (value) => diagnostics.push(value),
    now: () => current,
  });
  await second.start();
  await second.check();
  await second.stop();

  state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(Object.keys(state.enterpriseIdentityQueue).length, 0);
  assert.equal(
    frames.filter((frame) => frame.record?.id === "identity-retry-message").length,
    1,
  );
  assert.equal(diagnostics.some((value) => value.includes("identity_retry_resolved")), true);
});

test("enterprise identity retry expires without execution and preserves an audit count", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-enterprise-identity-expiry-"));
  const stateFile = join(root, "state.json");
  let current = new Date("2026-08-27T10:33:00+08:00");
  let firstScan = true;
  const frames = [];
  const diagnostics = [];
  const dws = {
    async fetchEnterpriseDirectScan() {
      if (!firstScan) return { messages: [], pending: [], rejected: [] };
      firstScan = false;
      return {
        messages: [],
        pending: [{
          errorCode: "backend_dependency_unavailable",
          message: {
            id: "identity-expiry-message",
            senderUserId: "open-expiry",
            senderOpenDingTalkId: "open-expiry",
            senderIdentitySource: "payload_open_id",
            senderName: "Expiry Employee",
            conversationId: "identity-expiry-conversation",
            content: "expire me",
            createTime: "2026-08-27T10:32:10+08:00",
            singleChat: true,
            isSelf: false,
            media: [],
          },
        }],
        rejected: [],
      };
    },
    async retryEnterpriseDirectMessage() {
      const error = new Error("backend dependency unavailable");
      error.code = "backend_dependency_unavailable";
      throw error;
    },
    async fetchBySender() { return []; },
    async fetchGroupMentions() { return []; },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: [],
      groupIds: [],
      enterpriseUsersEnabled: true,
      selfUserId: null,
      stateFile,
      mediaRoot: null,
      initialLookbackMs: 120_000,
      historySettleMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      enterpriseIdentityRetryTtlMs: 1_000,
      enterpriseIdentityRetryMaxAttempts: 8,
      enterpriseIdentityRetryCapacity: 128,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: (value) => diagnostics.push(value),
    now: () => current,
  });
  await runtime.start();
  current = new Date("2026-08-27T10:33:02+08:00");
  await runtime.check();
  await runtime.stop();

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(state.enterpriseIdentityQueue, {});
  assert.equal(state.enterpriseIdentityRejections.count, 1);
  assert.equal(frames.some((frame) => frame.record?.id === "identity-expiry-message"), false);
  assert.equal(diagnostics.some((value) => value.includes("identity_retry_expired")), true);
});

test("enterprise identity retry capacity prevents an unverified sender backlog from growing", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-enterprise-identity-capacity-"));
  const stateFile = join(root, "state.json");
  const candidate = (id, identity) => ({
    errorCode: "backend_dependency_unavailable",
    message: {
      id,
      senderUserId: identity,
      senderOpenDingTalkId: identity,
      senderIdentitySource: "payload_open_id",
      senderName: identity,
      conversationId: `conversation-${id}`,
      content: "pending",
      createTime: "2026-08-27T10:32:10+08:00",
      singleChat: true,
      isSelf: false,
      media: [],
    },
  });
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: [],
      groupIds: [],
      enterpriseUsersEnabled: true,
      selfUserId: null,
      stateFile,
      mediaRoot: null,
      initialLookbackMs: 120_000,
      historySettleMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      enterpriseIdentityRetryCapacity: 1,
      sendEnabled: false,
    },
    dws: {
      async fetchEnterpriseDirectScan() {
        return {
          messages: [],
          pending: [candidate("pending-one", "open-one"), candidate("pending-two", "open-two")],
          rejected: [],
        };
      },
      async fetchBySender() { return []; },
      async fetchGroupMentions() { return []; },
    },
    emit: () => {},
    diagnose: () => {},
    now: () => new Date("2026-08-27T10:33:00+08:00"),
  });
  await runtime.start();
  await runtime.stop();
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(Object.keys(state.enterpriseIdentityQueue).length, 1);
  assert.equal(state.enterpriseIdentityRejections.count, 1);
});

test("enterprise policy rejection is audited without entering the retry queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-enterprise-policy-reject-"));
  const diagnostics = [];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: [],
      groupIds: [],
      enterpriseUsersEnabled: true,
      selfUserId: null,
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 120_000,
      historySettleMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      sendEnabled: false,
    },
    dws: {
      async fetchEnterpriseDirectScan() {
        return {
          messages: [],
          pending: [],
          rejected: [{
            errorCode: "dws_enterprise_identity_unavailable",
            message: {
              id: "external-message",
              senderUserId: "external-user",
              senderName: "External",
              conversationId: "external-conversation",
              content: "external",
              createTime: "2026-08-27T10:32:10+08:00",
              singleChat: true,
            },
          }],
        };
      },
      async fetchBySender() { return []; },
      async fetchGroupMentions() { return []; },
    },
    emit: () => {},
    diagnose: (value) => diagnostics.push(value),
    now: () => new Date("2026-08-27T10:33:00+08:00"),
  });
  await runtime.start();
  await runtime.stop();
  const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  assert.deepEqual(state.enterpriseIdentityQueue, {});
  assert.equal(state.enterpriseIdentityRejections.count, 1);
  assert.equal(diagnostics.some((value) => value.includes("identity_rejected")), true);
});

test("DWS event wake triggers the same allowlisted history read with event latency evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-event-wake-"));
  const frames = [];
  const dws = new FakeDws();
  let available = false;
  dws.fetchBySender = async ({ senderUserId }) => available ? [{
    id: "event-message-1",
    senderUserId,
    senderOpenDingTalkId: "open-trusted",
    senderName: "Trusted",
    conversationId: "event-conversation",
    content: "event wake",
    createTime: "2026-08-24T10:00:00+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  }] : [];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: true,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-24T10:00:01+08:00"),
  });
  try {
    await runtime.start();
    await Promise.resolve();
    available = true;
    dws.eventOnEvent();
    assert.equal(
      await waitFor(() => frames.some((item) => item.record?.id === "event-message-1")),
      true,
    );
    const frame = frames.find((item) => item.record?.id === "event-message-1");
    assert.equal(frame.record.wakeSource, "dws_event");
    assert.equal(frame.record.detectionLatencyMs, 1_000);
  } finally {
    await runtime.stop();
  }
  assert.equal(dws.eventWakeStopped, true);
});

test("DWS message event prewarms the direct reaction stream before history projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-reaction-prewarm-"));
  const dws = new FakeDws();
  dws.messages = [];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: [],
      groupIds: [],
      enterpriseUsersEnabled: true,
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      historySettleMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: true,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
  });
  try {
    await runtime.start();
    assert.equal(dws.reactionWatchers.length, 0);
    dws.reactionWakeFailure = true;
    dws.eventOnEvent({
      eventId: "message-wake-before-projection",
      type: "message",
      conversationId: "future-conversation",
      messageId: "future-message",
      senderOpenDingTalkId: "open-future-sender",
    });
    await new Promise((accept) => setTimeout(accept, 25));
    let state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(state.reactionWake.errorCount, 1);
    dws.reactionWakeFailure = false;
    dws.eventOnEvent({
      eventId: "message-wake-retry-before-projection",
      type: "message",
      conversationId: "future-conversation",
      messageId: "future-message",
      senderOpenDingTalkId: "open-future-sender",
    });
    assert.equal(await waitFor(() => dws.reactionWatchers.length === 1), true);
    assert.equal(dws.reactionWatchers[0].chatType, "direct");
    assert.equal(dws.reactionWatchers[0].conversationId, "future-conversation");
    assert.equal(
      dws.reactionWatchers[0].participantOpenDingTalkId,
      "open-future-sender",
    );
    await new Promise((accept) => setTimeout(accept, 25));
    state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(state.reactionWake.readyCount, 1);
    assert.equal(state.reactionWake.errorCount, 0);
  } finally {
    await runtime.stop();
  }
});

test("DWS event wake source survives a check already in progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-event-pending-"));
  const frames = [];
  const dws = new FakeDws();
  let fetchCalls = 0;
  let releaseBlockedFetch;
  let markBlockedFetch;
  const blockedFetch = new Promise((accept) => { markBlockedFetch = accept; });
  const releaseFetch = new Promise((accept) => { releaseBlockedFetch = accept; });
  dws.fetchBySender = async ({ senderUserId }) => {
    fetchCalls += 1;
    if (fetchCalls === 2) {
      markBlockedFetch();
      await releaseFetch;
      return [];
    }
    if (fetchCalls >= 3) return [{
      id: "pending-event-message",
      senderUserId,
      senderOpenDingTalkId: "open-trusted",
      senderName: "Trusted",
      conversationId: "pending-event-conversation",
      content: "pending event wake",
      createTime: "2026-08-24T10:00:01+08:00",
      isSelf: false,
      isWithdrawn: false,
      media: [],
    }];
    return [];
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-24T10:00:02+08:00"),
  });
  try {
    await runtime.start();
    const firstCheck = runtime.check({ wakeSource: "filesystem" });
    await blockedFetch;
    await runtime.check({ wakeSource: "dws_event" });
    await runtime.check({ wakeSource: "fallback" });
    releaseBlockedFetch();
    await firstCheck;
    for (let index = 0; index < 50 && !frames.some((frame) =>
      frame.record?.id === "pending-event-message"); index += 1) {
      await new Promise((accept) => setTimeout(accept, 10));
    }
    const frame = frames.find((item) => item.record?.id === "pending-event-message");
    assert.equal(frame.record.wakeSource, "dws_event");
  } finally {
    releaseBlockedFetch?.();
    await runtime.stop();
  }
});

test("delayed DWS history projection stays behind the checkpoint protection window", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-history-settle-"));
  const frames = [];
  const dws = new FakeDws();
  let current = new Date("2026-08-24T10:00:00+08:00");
  let visible = false;
  const message = {
    id: "delayed-history-message",
    senderUserId: "trusted-user",
    senderOpenDingTalkId: "open-trusted",
    senderName: "Trusted",
    conversationId: "delayed-history-conversation",
    content: "delayed history",
    createTime: "2026-08-24T10:00:00+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  };
  dws.fetchBySender = async ({ start, end }) => (
    visible && start <= new Date(message.createTime) && new Date(message.createTime) <= end
      ? [message]
      : []
  );
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 600_000,
      fallbackMs: 300_000,
      historySettleMs: 120_000,
      eventWakeEnabled: false,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => current,
  });
  try {
    await runtime.start();
    current = new Date("2026-08-24T10:00:01+08:00");
    await runtime.check({ wakeSource: "dws_event" });
    current = new Date("2026-08-24T10:00:31+08:00");
    await runtime.check({ wakeSource: "fallback" });
    current = new Date("2026-08-24T10:01:01+08:00");
    visible = true;
    await runtime.check({ wakeSource: "fallback" });
    const frame = frames.find((item) => item.record?.id === message.id);
    assert.equal(frame.record.wakeSource, "fallback");
    assert.equal(frame.record.detectionLatencyMs, 61_000);
  } finally {
    await runtime.stop();
  }
});

test("startup reconciliation replays an unseen message behind a newer checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-startup-reconcile-"));
  const stateFile = join(root, "state.json");
  await writeFile(stateFile, JSON.stringify({
    lastUsers: { "trusted-user": "2026-08-24T10:05:00+08:00" },
    recentMessageIds: [],
  }));
  const frames = [];
  const dws = new FakeDws();
  const message = {
    id: "startup-replayed-message",
    senderUserId: "trusted-user",
    senderOpenDingTalkId: "open-trusted",
    senderName: "Trusted",
    conversationId: "startup-replayed-conversation",
    content: "startup replay",
    createTime: "2026-08-24T10:04:00+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  };
  dws.fetchBySender = async ({ start, end }) => (
    start <= new Date(message.createTime) && new Date(message.createTime) <= end
      ? [message]
      : []
  );
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile,
      mediaRoot: null,
      initialLookbackMs: 600_000,
      fallbackMs: 300_000,
      historySettleMs: 120_000,
      eventWakeEnabled: false,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-24T10:06:00+08:00"),
  });
  try {
    await runtime.start();
    assert.equal(frames.some((frame) => frame.record?.id === message.id), true);
  } finally {
    await runtime.stop();
  }
});

test("unavailable DWS event wake is visible while history fallback remains usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-event-degraded-"));
  const frames = [];
  const dws = new FakeDws();
  const unavailable = new Error("event command unavailable");
  unavailable.code = "dws_event_unavailable";
  dws.createPersonalEventWake = () => ({
    ready: Promise.reject(unavailable),
    stop: async () => {},
  });
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: true,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  try {
    await runtime.start();
    await new Promise((accept) => setImmediate(accept));
    await runtime.check({ wakeSource: "fallback" });
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(persisted.eventWake.enabled, true);
    assert.equal(persisted.eventWake.ready, false);
    assert.equal(persisted.eventWake.errorCode, "dws_event_unavailable");
    assert.equal(frames.some((frame) => frame.record?.id === "dws-1"), true);
  } finally {
    await runtime.stop();
  }
});

test("failed media download does not consume the message before retry succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-media-retry-"));
  const frames = [];
  const dws = new FakeDws();
  dws.media = true;
  dws.downloadFailures = 1;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      mediaRoot: join(root, "media"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  try {
    await runtime.start();
    const failed = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(failed.checkLifecycle.status, "failed");
    const retryFrames = await runtime.check({ deferEmit: true });
    const event = retryFrames.find((frame) => frame.record?.id === "dws-1");
    assert.ok(event);
    assert.equal(event.record.attachments.length, 1);
    assert.equal(event.record.sendGeneration, 1);
  } finally {
    await runtime.stop();
  }
});

test("failed control persistence does not consume the message before retry succeeds", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-control-retry-sidecar-")));
  let failures = 1;
  const controlStore = {
    snapshot: async () => ({ global: { state: "running" }, tasks: {} }),
    async observeTask() {
      if (failures > 0) {
        failures -= 1;
        throw new Error("temporary control write failure");
      }
      return { revision: 1 };
    },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "dws.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    controlStore,
    dws: new FakeDws(),
    emit: () => {},
    diagnose: () => {},
    now: () => new Date("2026-08-24T10:00:00+08:00"),
  });
  try {
    await runtime.start();
    const failed = JSON.parse(await readFile(join(root, "dws.json"), "utf8"));
    assert.equal(failed.checkLifecycle.status, "failed");
    const retry = await runtime.check({ deferEmit: true });
    const event = retry.find((frame) => frame.record?.id === "dws-1");
    assert.ok(event);
    assert.equal(event.record.sendGeneration, 1);
  } finally {
    await runtime.stop();
  }
});

test("Hermes DWS sidecar downloads message media into the private profile cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-media-sidecar-"));
  const frames = [];
  const dws = new FakeDws();
  dws.media = true;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      mediaRoot: join(root, "media"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  await runtime.stop();
  const event = frames.find((frame) => frame.type === "event");
  assert.equal(event.record.attachments.length, 1);
  assert.equal(event.record.attachments[0].mimeType, "image/png");
  assert.match(event.record.attachments[0].path, /media\/.*\/image\.png$/u);
  assert.equal(dws.downloadInputs[0].resourceType, "mediaId");
});

test("Hermes DWS sidecar preserves fileId type through the download boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-file-sidecar-"));
  const frames = [];
  const dws = new FakeDws();
  dws.media = "file";
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      mediaRoot: join(root, "media"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  await runtime.stop();
  const event = frames.find((frame) => frame.type === "event");
  assert.equal(event.record.attachments.length, 1);
  assert.equal(event.record.attachments[0].name, "report.txt");
  assert.equal(dws.downloadInputs[0].resourceType, "fileId");
});

test("Hermes DWS sidecar emits allowlisted records and persists a private checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-sidecar-"));
  const stateFile = join(root, "state.json");
  const frames = [];
  const dws = new FakeDws();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  await runtime.check();
  await runtime.stop();

  assert.equal(frames[0].type, "ready");
  assert.equal(frames.filter((frame) => frame.type === "event").length, 1);
  assert.equal(frames[1].record.senderUserId, "trusted-user");
  assert.equal(frames[1].record.chatType, "direct");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.lastUsers["trusted-user"], "2026-08-18T05:59:00.000Z");
  assert.equal(state.lastFullSuccessAt, "2026-08-18T06:01:00.000Z");
  assert.equal(state.lastErrorCount, 0);
  assert.equal(state.checkLifecycle.status, "completed");
  assert.equal(state.checkLifecycle.generation, 2);
  assert.equal(state.checkLifecycle.operation, "history_check");
  assert.equal(state.checkLifecycle.completedAt, "2026-08-18T06:01:00.000Z");
});

test("Hermes DWS sidecar persists a bounded running lifecycle before waiting for DWS", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-lifecycle-"));
  const stateFile = join(root, "state.json");
  let current = new Date("2026-08-25T15:00:00+08:00");
  let calls = 0;
  let releaseFetch;
  let enteredFetch;
  const entered = new Promise((resolve) => { enteredFetch = resolve; });
  const blocked = new Promise((resolve) => { releaseFetch = resolve; });
  const dws = {
    async fetchBySender() {
      calls += 1;
      if (calls === 2) {
        enteredFetch();
        await blocked;
      }
      return [];
    },
    async fetchGroupMentions() { return []; },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile,
      mediaRoot: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
    now: () => current,
  });
  try {
    await runtime.start();
    current = new Date("2026-08-25T15:01:10+08:00");
    const check = runtime.check({ wakeSource: "fallback" });
    await entered;
    const running = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(running.checkLifecycle.status, "running");
    assert.equal(running.checkLifecycle.generation, 2);
    assert.equal(running.checkLifecycle.wakeSource, "fallback");
    assert.equal(running.lastFullSuccessAt, "2026-08-25T07:00:00.000Z");

    current = new Date("2026-08-25T15:01:15+08:00");
    releaseFetch();
    await check;
    const completed = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(completed.checkLifecycle.status, "completed");
    assert.equal(completed.checkLifecycle.completedAt, "2026-08-25T07:01:15.000Z");
    assert.equal(completed.lastFullSuccessAt, "2026-08-25T07:01:15.000Z");
  } finally {
    releaseFetch?.();
    await runtime.stop();
  }
});

test("Hermes DWS sidecar 按源消息时间升序交给 Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-order-"));
  const frames = [];
  const dws = {
    async fetchBySender({ senderUserId }) {
      return [
        { id: "later", senderUserId, conversationId: "conversation", content: "later", createTime: "2026-08-18T14:01:00+08:00" },
        { id: "earlier", senderUserId, conversationId: "conversation", content: "earlier", createTime: "2026-08-18T14:00:00+08:00" },
      ];
    },
    async fetchGroupMentions() { return []; },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:02:00+08:00"),
  });
  await runtime.start();
  await runtime.stop();
  assert.deepEqual(
    frames.filter((frame) => frame.type === "event").map((frame) => frame.record.id),
    ["earlier", "later"],
  );
});

test("Hermes DWS sidecar 并发抓取目标且部分失败不覆盖失败游标", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-concurrent-"));
  const stateFile = join(root, "state.json");
  let currentTime = new Date("2026-08-18T14:01:00+08:00");
  let active = 0;
  let maximumActive = 0;
  const failing = new Set();
  const dws = {
    async fetchBySender({ senderUserId }) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        if (failing.has(senderUserId)) throw new Error("target unavailable");
        return [];
      } finally {
        active -= 1;
      }
    },
    async fetchGroupMentions() { return []; },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["good-user", "bad-user"],
      groupIds: [],
      selfUserId: null,
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
    now: () => currentTime,
  });
  await runtime.start();
  assert.equal(maximumActive, 2);
  const first = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(first.lastErrorCount, 0);

  failing.add("bad-user");
  currentTime = new Date("2026-08-18T14:02:00+08:00");
  await assert.rejects(
    runtime.check(),
    (error) => error.code === "DWS_SIDECAR_TARGETS_UNAVAILABLE",
  );
  const second = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(second.lastUsers["good-user"], "2026-08-18T06:00:00.000Z");
  assert.equal(second.lastUsers["bad-user"], "2026-08-18T05:59:00.000Z");
  assert.equal(second.lastFullSuccessAt, "2026-08-18T06:01:00.000Z");
  assert.equal(second.lastErrorCount, 1);
  assert.equal(second.checkLifecycle.status, "failed");
  assert.equal(second.checkLifecycle.errorCount, 1);

  failing.clear();
  currentTime = new Date("2026-08-18T14:03:00+08:00");
  await runtime.check();
  const recovered = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(recovered.lastErrorCount, 0);
  assert.equal(recovered.checkLifecycle.status, "completed");
  assert.equal(recovered.checkLifecycle.generation, 3);
  await runtime.stop();
});

test("Hermes DWS sidecar keeps real sending disabled unless explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-send-"));
  const dws = new FakeDws();
  const base = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: "owner-user",
    stateFile: join(root, "state.json"),
    initialLookbackMs: 120_000,
    fallbackMs: 300_000,
  };
  const disabled = await createSidecarRuntime({
    config: { ...base, sendEnabled: false },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await disabled.start();
  assert.deepEqual(await disabled.send({
    conversationId: "conversation-1",
    content: "完成了",
    ownerRevision: 0,
    sendGeneration: 1,
  }), {
    success: false,
    sendDisabled: true,
    error: "DWS personal send is disabled",
  });
  await disabled.stop();

  const enabled = await createSidecarRuntime({
    config: { ...base, stateFile: join(root, "enabled.json"), sendEnabled: true },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await enabled.start();
  const receipt = await enabled.send({
    conversationId: "conversation-1",
    content: "完成了",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  const duplicate = await enabled.send({
    conversationId: "conversation-1",
    content: "完成了",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await enabled.stop();
  assert.equal(receipt.success, true);
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.messageId, receipt.messageId);
  assert.equal(dws.sent.length, 1);
  assert.equal(receipt.messageId, "server-message-1");
  assert.equal(dws.sent.at(-1).recipientId, "open-trusted");
  assert.equal(dws.sent.at(-1).recipientKind, "open_dingtalk_id");
});

test("outbound quiet window lets a six-second follow-up invalidate the old reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-outbound-quiet-"));
  const dws = new FakeDws();
  let includeFollowup = false;
  let current = new Date("2026-08-24T10:00:07+08:00");
  dws.fetchBySender = async ({ senderUserId }) => [{
    id: "burst-1",
    senderUserId,
    senderOpenDingTalkId: "open-trusted",
    senderName: "Trusted",
    conversationId: "burst-conversation",
    content: "first fragment",
    createTime: "2026-08-24T10:00:00+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  }, ...(includeFollowup ? [{
    id: "burst-2",
    senderUserId,
    senderOpenDingTalkId: "open-trusted",
    senderName: "Trusted",
    conversationId: "burst-conversation",
    content: "second fragment",
    createTime: "2026-08-24T10:00:06+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  }] : [])];
  let runtime;
  let waited = 0;
  runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      outboundQuietMs: 8_000,
      outboundMaxQuietMs: 20_000,
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
    now: () => current,
    clock: () => current.getTime(),
    wait: async (milliseconds) => {
      waited = milliseconds;
      includeFollowup = true;
      current = new Date("2026-08-24T10:00:19+08:00");
      await runtime.check({ wakeSource: "filesystem" });
      current = new Date("2026-08-24T10:00:22+08:00");
    },
  });
  try {
    await runtime.start();
    current = new Date("2026-08-24T10:00:13+08:00");
    const result = await runtime.send({
      conversationId: "burst-conversation",
      content: "old answer",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(waited, 9_000);
    assert.equal(result.staleGeneration, true);
    assert.equal(dws.sent.length, 0);
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.deepEqual(persisted.sendLedger, {});
  } finally {
    await runtime.stop();
  }
});

test("self-chat fragments stay as input while explicit intervention still takes over", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-self-fragment-"));
  const frames = [];
  const dws = new FakeDws();
  let manualMessage = {
    id: "self-fragment-2",
    content: "重点看人工回复探针失败时",
    createTime: "2026-08-24T10:00:30+08:00",
  };
  dws.fetchDirect = async () => [{
    id: "self-fragment-1",
    senderUserId: "owner-user",
    senderName: "Owner",
    conversationId: "self-conversation",
    content: "请帮我核对Foursday项目",
    createTime: "2026-08-24T10:00:00+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  }];
  dws.hasManualReply = async () => ({
    known: true,
    replied: true,
    message: manualMessage,
  });
  const stateFile = join(root, "state.json");
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["owner-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      mediaRoot: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-24T10:01:00+08:00"),
  });
  try {
    await runtime.start();
    assert.equal(frames.some((frame) => frame.record?.control), false);
    let state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.controlStates["self-conversation"].ownerRevision, 0);
    assert.equal(state.controlStates["self-conversation"].sendGeneration, 1);

    manualMessage = {
      id: "self-takeover-1",
      content: "这个任务我来处理",
      createTime: "2026-08-24T10:00:40+08:00",
    };
    await runtime.check();
    const interventions = frames.filter((frame) => frame.record?.control);
    assert.equal(
      interventions.length,
      1,
      JSON.stringify(interventions.map((frame) => ({
        control: frame.record?.control,
        ownerMessageId: frame.record?.ownerMessageId,
        sourceMessageId: frame.record?.sourceMessageId,
      }))),
    );
    assert.equal(interventions[0].record.control, "task_takeover");
    assert.equal(interventions[0].record.ownerRevision, 1);
    assert.equal(interventions[0].record.sendGeneration, 2);
    state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.controlStates["self-conversation"].lastOwnerMessageId, "self-takeover-1");
  } finally {
    await runtime.stop();
  }
});

test("semantic self-chat takeover freezes the old reply before Codex classification", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-semantic-takeover-"));
  const frames = [];
  let messages = [{
    id: "self-task-1",
    senderUserId: "owner-user",
    senderName: "Owner",
    conversationId: "self-conversation",
    content: "请核对Foursday项目",
    createTime: "2026-08-24T10:00:00+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  }];
  let releaseClassifier;
  let enteredClassifier;
  const classifierEntered = new Promise((resolve) => { enteredClassifier = resolve; });
  const classifierBlocked = new Promise((resolve) => { releaseClassifier = resolve; });
  const dws = new FakeDws();
  dws.fetchDirect = async () => messages;
  dws.hasManualReply = async () => ({ known: true, replied: false, message: null });
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["owner-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      semanticInterventionEnabled: true,
      semanticInterventionTimeoutMs: 30_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    semanticInterventionClassifier: async (text, options) => {
      assert.match(text, /接管这轮沟通/u);
      assert.equal(options.selfChat, true);
      enteredClassifier();
      await classifierBlocked;
      return { intent: "communication_takeover", source: "codex", confidence: 0.94 };
    },
    now: () => new Date("2026-08-24T10:01:00+08:00"),
  });
  try {
    await runtime.start();
    assert.equal(frames.filter((frame) => frame.record?.id === "self-task-1").length, 1);
    messages = [...messages, {
      id: "self-takeover-semantic",
      senderUserId: "owner-user",
      senderName: "Owner",
      conversationId: "self-conversation",
      content: "我现在接管这轮沟通，请停止本轮AI回复",
      createTime: "2026-08-24T10:00:30+08:00",
      isSelf: false,
      isWithdrawn: false,
      media: [],
    }];
    const checking = runtime.check();
    await classifierEntered;
    const stale = await runtime.send({
      conversationId: "self-conversation",
      content: "old reply",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(stale.staleGeneration, true);
    releaseClassifier();
    await checking;
    assert.equal(
      frames.some((frame) => frame.record?.id === "self-takeover-semantic"),
      false,
    );
    const takeover = frames.find((frame) =>
      frame.record?.control === "communication_takeover" &&
      frame.record?.ownerMessageId === "self-takeover-semantic"
    );
    assert.equal(takeover.record.classificationSource, "codex");
    assert.equal(takeover.record.classificationConfidence, 0.94);
    assert.equal(takeover.record.ownerRevision, 1);
    assert.equal(takeover.record.sendGeneration, 2);
  } finally {
    releaseClassifier?.();
    await runtime.stop();
  }
});

test("responsibility reaction is idempotent and clears only after an explicit terminal action", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-responsibility-reaction-"));
  const frames = [];
  const dws = new FakeDws();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: true,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-28T10:01:00+08:00"),
  });
  try {
    await runtime.start();
    const claim = {
      conversationId: "conversation-1",
      messageId: "dws-1",
      sourceMessageIds: ["dws-1"],
      ownerRevision: 0,
      sendGeneration: 1,
    };
    assert.deepEqual(await runtime.claimResponsibility(claim), { success: true });
    assert.deepEqual(await runtime.claimResponsibility(claim), {
      success: true,
      idempotent: true,
    });
    assert.deepEqual(dws.reactionWrites, [{
      action: "added",
      conversationId: "conversation-1",
      messageId: "dws-1",
      emoji: "OK",
    }]);
    assert.deepEqual(await runtime.settleResponsibility(claim), { success: true });
    assert.deepEqual(await runtime.claimResponsibility(claim), {
      success: true,
      idempotent: true,
    });
    assert.deepEqual(await runtime.releaseResponsibility(claim), { success: true });
    assert.deepEqual(await runtime.releaseResponsibility(claim), {
      success: true,
      idempotent: true,
    });
    assert.equal(dws.reactionWrites.at(-1).action, "removed");
    dws.reactionWatchers[0].onEvent({
      eventId: "post-completion-feedback",
      conversationId: "conversation-1",
      messageId: "dws-1",
      operatorOpenDingTalkId: "open-owner",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "赞",
      action: "added",
      occurredAt: "2026-08-28T02:03:00.000Z",
    });
    await new Promise((accept) => setTimeout(accept, 25));
    assert.equal(frames.some((frame) =>
      frame.record?.ownerMessageId === "post-completion-feedback"
    ), false);
  } finally {
    await runtime.stop();
  }
});

test("a newer generation migrates only an in-flight responsibility label", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-reaction-migration-"));
  const dws = new FakeDws();
  const firstMessage = {
    id: "message-1",
    senderUserId: "trusted-user",
    senderOpenDingTalkId: "open-trusted",
    senderName: "娜娜老师",
    conversationId: "conversation-1",
    content: "第一段任务",
    createTime: "2026-08-28T10:00:00+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  };
  dws.messages = [firstMessage];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
  });
  try {
    await runtime.start();
    await runtime.claimResponsibility({
      conversationId: "conversation-1",
      messageId: "message-1",
      sourceMessageIds: ["message-1"],
      ownerRevision: 0,
      sendGeneration: 1,
    });
    dws.messages = [firstMessage, {
      ...firstMessage,
      id: "message-2",
      content: "第二段补充",
      createTime: "2026-08-28T10:00:05+08:00",
    }];
    await runtime.check();
    await runtime.claimResponsibility({
      conversationId: "conversation-1",
      messageId: "message-2",
      sourceMessageIds: ["message-2"],
      ownerRevision: 0,
      sendGeneration: 2,
    });
    assert.deepEqual(dws.reactionWrites.map((entry) => ({
      action: entry.action,
      messageId: entry.messageId,
    })), [
      { action: "added", messageId: "message-1" },
      { action: "removed", messageId: "message-1" },
      { action: "added", messageId: "message-2" },
    ]);
  } finally {
    await runtime.stop();
  }
});

test("owner reaction itself completes external communication without an AI text reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-owner-reaction-"));
  const frames = [];
  const dws = new FakeDws();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: true,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-28T10:01:00+08:00"),
  });
  try {
    await runtime.start();
    await runtime.claimResponsibility({
      conversationId: "conversation-1",
      messageId: "dws-1",
      sourceMessageIds: ["dws-1"],
      ownerRevision: 0,
      sendGeneration: 1,
    });
    const onReaction = dws.reactionWatchers[0].onEvent;
    onReaction({
      eventId: "automated-add",
      conversationId: "conversation-1",
      messageId: "dws-1",
      operatorOpenDingTalkId: "open-owner",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "OK",
      action: "added",
      occurredAt: "2026-08-28T02:01:01.000Z",
    });
    onReaction({
      eventId: "other-member-add",
      conversationId: "conversation-1",
      messageId: "dws-1",
      operatorOpenDingTalkId: "open-other-member",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "赞",
      action: "added",
      occurredAt: "2026-08-28T02:01:02.000Z",
    });
    onReaction({
      eventId: "owner-wrong-message",
      conversationId: "conversation-1",
      messageId: "unrelated-message",
      operatorOpenDingTalkId: "open-owner",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "赞",
      action: "added",
      occurredAt: "2026-08-28T02:01:02.500Z",
    });
    await new Promise((accept) => setTimeout(accept, 50));
    assert.equal(frames.some((frame) => frame.record?.control), false);

    onReaction({
      eventId: "owner-adds-reply",
      conversationId: "conversation-1",
      messageId: "dws-1",
      operatorOpenDingTalkId: "open-owner",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "赞",
      action: "added",
      occurredAt: "2026-08-28T02:01:03.000Z",
    });
    assert.equal(await waitFor(() => frames.some((frame) =>
      frame.record?.control === "communication_takeover" &&
      frame.record?.ownerMessageId === "owner-adds-reply"
    )), true);
    const takeover = frames.find((frame) =>
      frame.record?.control === "communication_takeover" &&
      frame.record?.ownerMessageId === "owner-adds-reply"
    );
    assert.ok(takeover);
    assert.equal(takeover.record.classificationSource, "owner_reaction");
    assert.equal(takeover.record.ownerContent, "");
    assert.equal(takeover.record.ownerRevision, 1);
    assert.equal(takeover.record.sendGeneration, 2);
    assert.equal(dws.sent.length, 0);
    assert.equal(dws.reactionWrites.at(-1).action, "removed");
    onReaction({
      eventId: "owner-adds-reply",
      conversationId: "conversation-1",
      messageId: "dws-1",
      operatorOpenDingTalkId: "open-owner",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "赞",
      action: "added",
      occurredAt: "2026-08-28T02:01:03.000Z",
    });
    await new Promise((accept) => setTimeout(accept, 25));
    assert.equal(frames.filter((frame) =>
      frame.record?.control === "communication_takeover" &&
      frame.record?.ownerMessageId === "owner-adds-reply"
    ).length, 1);
  } finally {
    await runtime.stop();
  }
});

test("responsibility reactions stay write-free while sending is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-responsibility-shadow-"));
  const dws = new FakeDws();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
  });
  try {
    await runtime.start();
    const result = await runtime.claimResponsibility({
      conversationId: "conversation-1",
      messageId: "dws-1",
      sourceMessageIds: ["dws-1"],
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.deepEqual(result, { success: true, sendDisabled: true });
    assert.deepEqual(dws.reactionWrites, []);
  } finally {
    await runtime.stop();
  }
});

test("a degraded reaction watcher suppresses text delivery instead of risking a collision", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-reaction-degraded-"));
  const dws = new FakeDws();
  dws.reactionWakeFailure = true;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      outboundQuietMs: 0,
      outboundMaxQuietMs: 0,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
  });
  try {
    await runtime.start();
    const result = await runtime.send({
      conversationId: "conversation-1",
      content: "旧AI回复",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(result.staleGeneration, true);
    assert.equal(dws.sent.length, 0);
  } finally {
    await runtime.stop();
  }
});

test("owner reaction freezes the current task even before the responsibility label is written", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-owner-fast-reaction-"));
  const frames = [];
  const dws = new FakeDws();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: true,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
  });
  try {
    await runtime.start();
    dws.reactionWatchers[0].onEvent({
      eventId: "owner-fast-reply",
      conversationId: "conversation-1",
      messageId: "dws-1",
      operatorOpenDingTalkId: "open-owner",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "OK",
      action: "added",
      occurredAt: "2026-08-28T02:01:01.000Z",
    });
    assert.equal(await waitFor(() => frames.some((frame) =>
      frame.record?.control === "communication_takeover" &&
      frame.record?.ownerMessageId === "owner-fast-reply"
    )), true);
    const takeover = frames.find((frame) => frame.record?.ownerMessageId === "owner-fast-reply");
    assert.equal(takeover.record.classificationSource, "owner_reaction");
    assert.equal(takeover.record.sendGeneration, 2);
    assert.equal(dws.reactionWrites.length, 0);
  } finally {
    await runtime.stop();
  }
});

test("owner reaction arriving before the newer message projection is replayed on that exact anchor", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-owner-reaction-before-message-"));
  const stateFile = join(root, "state.json");
  const frames = [];
  const dws = new FakeDws();
  const firstMessage = {
    id: "dws-1",
    senderUserId: "trusted-user",
    senderOpenDingTalkId: "open-trusted",
    senderName: "Trusted user",
    conversationId: "conversation-1",
    content: "第一条任务消息",
    createTime: "2026-08-28T10:00:00+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
  };
  dws.messages = [firstMessage];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-28T10:01:00+08:00"),
  });
  try {
    await runtime.start();
    dws.reactionWatchers[0].onEvent({
      eventId: "owner-reacts-to-future-anchor",
      conversationId: "conversation-1",
      messageId: "dws-2",
      operatorOpenDingTalkId: "open-owner",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "👌",
      action: "added",
      occurredAt: "2026-08-28T02:01:01.000Z",
    });
    await new Promise((accept) => setTimeout(accept, 50));
    let state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(Object.keys(state.pendingOwnerReactions ?? {}).length, 1);
    assert.equal(frames.some((frame) => frame.record?.control), false);

    dws.messages = [firstMessage, {
      ...firstMessage,
      id: "dws-2",
      content: "第二条补充消息",
      createTime: "2026-08-28T10:00:30+08:00",
    }];
    await runtime.check();
    assert.equal(await waitFor(() => frames.some((frame) =>
      frame.record?.control === "communication_takeover" &&
      frame.record?.ownerMessageId === "owner-reacts-to-future-anchor"
    )), true);
    state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(Object.keys(state.pendingOwnerReactions ?? {}).length, 0);
    assert.equal(state.recentReactionEventIds.includes("owner-reacts-to-future-anchor"), true);
    const lateClaim = await runtime.claimResponsibility({
      conversationId: "conversation-1",
      messageId: "dws-2",
      sourceMessageIds: ["dws-1", "dws-2"],
      ownerRevision: 0,
      sendGeneration: 2,
    });
    assert.equal(lateClaim.success, false);
    assert.equal(lateClaim.error, "responsibility_claim_stale");
    state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(Object.values(state.responsibilityReactions ?? {}).some((entry) =>
      entry.status !== "cleared"
    ), false);
    assert.equal(dws.sent.length, 0);
  } finally {
    await runtime.stop();
  }
});

test("responsibility label and reaction takeover survive a sidecar restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-reaction-restart-"));
  const stateFile = join(root, "state.json");
  const config = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: "owner-user",
    stateFile,
    mediaRoot: null,
    controlFile: null,
    initialLookbackMs: 120_000,
    fallbackMs: 300_000,
    eventWakeEnabled: false,
    responsibilityReactionsEnabled: true,
    responsibilityReactionName: "OK",
    sendEnabled: true,
  };
  const firstDws = new FakeDws();
  const first = await createSidecarRuntime({ config, dws: firstDws, emit: () => {}, diagnose: () => {} });
  await first.start();
  await first.claimResponsibility({
    conversationId: "conversation-1",
    messageId: "dws-1",
    sourceMessageIds: ["dws-1"],
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await first.stop();

  const frames = [];
  const secondDws = new FakeDws();
  const second = await createSidecarRuntime({
    config,
    dws: secondDws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
  });
  try {
    await second.start();
    assert.deepEqual(secondDws.reactionWrites, []);
    secondDws.reactionWatchers[0].onEvent({
      eventId: "owner-after-restart",
      conversationId: "conversation-1",
      messageId: "dws-1",
      operatorOpenDingTalkId: "open-owner",
      senderOpenDingTalkId: "open-trusted",
      reactionName: "赞",
      action: "added",
      occurredAt: "2026-08-28T02:02:00.000Z",
    });
    assert.equal(await waitFor(() => frames.some((frame) =>
      frame.record?.ownerMessageId === "owner-after-restart"
    )), true);
    assert.equal(secondDws.reactionWrites.at(-1).action, "removed");
  } finally {
    await second.stop();
  }
});

test("reaction startup ignores legacy conversations without a current responsibility claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-reaction-legacy-startup-"));
  const stateFile = join(root, "state.json");
  await writeFile(stateFile, JSON.stringify({
    activeConversations: {
      "legacy-conversation": {
        participantUserId: "legacy-user",
        chatType: "direct",
        after: "2026-08-24T08:56:04.000Z",
      },
    },
    reactionWake: {
      enabled: true,
      readyCount: 1,
      errorCount: 5,
      lastErrorCode: "4",
      updatedAt: "2026-08-24T08:56:04.000Z",
    },
  }), { mode: 0o600 });
  const dws = new FakeDws();
  dws.messages = [];
  dws.reactionWakeFailure = true;
  let identityResolutions = 0;
  dws.resolveUserOpenDingTalkId = async () => {
    identityResolutions += 1;
    throw Object.assign(new Error("legacy identity must not be resolved"), { code: 4 });
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      mediaRoot: null,
      controlFile: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      responsibilityReactionsEnabled: true,
      responsibilityReactionName: "OK",
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
  });
  try {
    await runtime.start();
    assert.equal(dws.reactionWatchers.length, 0);
    assert.equal(identityResolutions, 0);
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.reactionWake.readyCount, 0);
    assert.equal(state.reactionWake.errorCount, 0);
    assert.equal(state.reactionWake.lastErrorCode, null);
  } finally {
    await runtime.stop();
  }
});

test("Hermes DWS sidecar converts a verified owner reply into one communication takeover event", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-takeover-"));
  const frames = [];
  const dws = new FakeDws();
  dws.manualReply = true;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  await runtime.check();
  await runtime.stop();
  const takeovers = frames.filter((frame) =>
    frame.record?.control === "communication_takeover"
  );
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0].record.participantUserId, "trusted-user");
  assert.equal(takeovers[0].record.ownerRevision, 1);
  assert.equal(takeovers[0].record.sendGeneration, 2);
  assert.equal(dws.manualInput.selfUserId, "owner-user");
  assert.deepEqual(dws.manualInput.automatedSendEvidence, []);

  const stale = await runtime.send({
    conversationId: "conversation-1",
    content: "这是一条晚到的旧回复",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  assert.equal(stale.success, false);
  assert.equal(stale.staleGeneration, true);
  assert.equal(dws.sent.length, 0);
});

test("manual-reply probe failure degrades only the probe and recovers on the next check", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-manual-probe-"));
  const stateFile = join(root, "state.json");
  const diagnostics = [];
  const dws = new FakeDws();
  dws.manualReplyFailures = 2;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: (value) => diagnostics.push(value),
    wait: async () => {},
    now: () => new Date("2026-08-25T16:43:12+08:00"),
  });
  try {
    await runtime.start();
    const degraded = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(degraded.lastErrorCount, 0);
    assert.equal(degraded.checkLifecycle.status, "completed");
    assert.equal(degraded.manualReplyProbe.ready, false);
    assert.equal(degraded.manualReplyProbe.errorCode, "dws_manual_reply_temporary");
    assert.deepEqual(diagnostics, [
      "dws_sidecar_manual_reply_probe_failed:dws_manual_reply_temporary",
    ]);

    await runtime.check({ wakeSource: "fallback" });
    const recovered = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(recovered.lastErrorCount, 0);
    assert.equal(recovered.manualReplyProbe.ready, true);
    assert.equal(recovered.manualReplyProbe.errorCode, null);
  } finally {
    await runtime.stop();
  }
});

test("send boundary retains the candidate until a transient manual probe recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-manual-send-gate-"));
  const stateFile = join(root, "state.json");
  const dws = new FakeDws();
  const retryCodes = [];
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      outboundQuietMs: 0,
      outboundMaxQuietMs: 0,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
    wait: async () => {
      const persisted = JSON.parse(await readFile(stateFile, "utf8"));
      retryCodes.push(persisted.deferredReply.errorCode);
    },
    now: () => new Date("2026-08-25T16:43:12+08:00"),
  });
  try {
    await runtime.start();
    const tlsTimeout = new Error("DWS request failed");
    tlsTimeout.code = 1;
    tlsTimeout.stderr = JSON.stringify({ error: { reason: "tls_timeout" } });
    dws.manualReplyFailure = tlsTimeout;
    dws.manualReplyFailures = 2;
    const recovered = await runtime.send({
      conversationId: "conversation-1",
      content: "safe after bounded retry",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(recovered.success, true);
    assert.equal(dws.sent.length, 1);
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(persisted.manualReplyProbe.ready, true);
    assert.equal(persisted.deferredReply.waiting, false);
    assert.equal(persisted.deferredReply.attemptCount, 2);
    assert.equal(persisted.deferredReply.errorCode, null);
    assert.equal(Object.values(persisted.sendLedger).length, 1);
    assert.equal(Object.hasOwn(persisted.deferredReply, "content"), false);
    assert.deepEqual(retryCodes, ["tls_timeout", "tls_timeout"]);
  } finally {
    await runtime.stop();
  }
});

test("deferred reply expires after ninety seconds without creating an intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-deferred-expiry-"));
  const stateFile = join(root, "state.json");
  const dws = new FakeDws();
  let current = new Date("2026-08-25T17:54:12+08:00").getTime();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      outboundQuietMs: 0,
      outboundMaxQuietMs: 0,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
    clock: () => current,
    now: () => new Date(current),
    wait: async (milliseconds) => { current += milliseconds; },
  });
  try {
    await runtime.start();
    const tlsTimeout = new Error("DWS request failed");
    tlsTimeout.code = 1;
    tlsTimeout.stderr = JSON.stringify({ error: { reason: "tls_timeout" } });
    dws.manualReplyFailure = tlsTimeout;
    dws.manualReplyFailures = 100;
    const expired = await runtime.send({
      conversationId: "conversation-1",
      content: "must expire without transport",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(expired.success, false);
    assert.equal(expired.staleGeneration, true);
    assert.equal(expired.deferredReplyExpired, true);
    assert.equal(dws.sent.length, 0);
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(persisted.sendLedger, {});
    assert.equal(persisted.deferredReply.waiting, false);
    assert.equal(persisted.deferredReply.errorCode, "deferred_reply_expired");
    assert.equal(persisted.deferredReply.attemptCount, 10);
    assert.equal(Object.hasOwn(persisted.deferredReply, "content"), false);
  } finally {
    await runtime.stop();
  }
});

test("deferred reply is discarded when task ownership changes during retry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-deferred-takeover-")));
  const controlFile = join(root, "control.json");
  const control = await new FoursdayControlStore({ path: controlFile }).open();
  const dws = new FakeDws();
  let takeoverApplied = false;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      outboundQuietMs: 0,
      outboundMaxQuietMs: 0,
      sendEnabled: true,
    },
    controlStore: control,
    dws,
    emit: () => {},
    diagnose: () => {},
    wait: async () => {
      if (takeoverApplied) return;
      takeoverApplied = true;
      const snapshot = await control.snapshot();
      await control.apply({
        action: "task_takeover",
        expectedRevision: snapshot.revision,
        taskId: createHash("sha256")
          .update("conversation-1:trusted-user")
          .digest("hex"),
      });
    },
    now: () => new Date("2026-08-25T17:54:12+08:00"),
  });
  try {
    await runtime.start();
    dws.manualReplyFailures = 1;
    const stale = await runtime.send({
      conversationId: "conversation-1",
      content: "must be discarded after takeover",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(stale.success, false);
    assert.equal(stale.staleGeneration, true);
    assert.equal(stale.manualReplyUnknown, false);
    assert.equal(dws.sent.length, 0);
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.deepEqual(persisted.sendLedger, {});
    assert.equal(persisted.deferredReply.waiting, false);
    assert.equal(persisted.deferredReply.errorCode, "deferred_reply_stale");
  } finally {
    await runtime.stop();
  }
});

test("deferred reply is discarded when the global control pauses during retry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-deferred-pause-")));
  const controlFile = join(root, "control.json");
  const control = await new FoursdayControlStore({ path: controlFile }).open();
  const dws = new FakeDws();
  let pauseApplied = false;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      controlFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      outboundQuietMs: 0,
      outboundMaxQuietMs: 0,
      sendEnabled: true,
    },
    controlStore: control,
    dws,
    emit: () => {},
    diagnose: () => {},
    wait: async () => {
      if (pauseApplied) return;
      pauseApplied = true;
      const snapshot = await control.snapshot();
      await control.apply({ action: "pause_all", expectedRevision: snapshot.revision });
    },
    now: () => new Date("2026-08-25T17:54:12+08:00"),
  });
  try {
    await runtime.start();
    dws.manualReplyFailures = 1;
    const stale = await runtime.send({
      conversationId: "conversation-1",
      content: "must be discarded after global pause",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(stale.success, false);
    assert.equal(stale.staleGeneration, true);
    assert.equal(dws.sent.length, 0);
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.deepEqual(persisted.sendLedger, {});
    assert.equal(persisted.deferredReply.errorCode, "deferred_reply_stale");
    assert.equal((await control.snapshot()).global.state, "paused");
  } finally {
    await runtime.stop();
  }
});

test("deferred reply cannot create an intent after another send blocks transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-deferred-send-block-"));
  const stateFile = join(root, "state.json");
  const dws = new FakeDws();
  let runtime;
  let blockerResult = null;
  let blockerStarted = false;
  runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      outboundQuietMs: 0,
      outboundMaxQuietMs: 0,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    diagnose: () => {},
    wait: async () => {
      if (blockerStarted) return;
      blockerStarted = true;
      dws.transportFailure = true;
      blockerResult = await runtime.send({
        conversationId: "conversation-1",
        content: "blocker transport",
        ownerRevision: 0,
        sendGeneration: 1,
      });
    },
    now: () => new Date("2026-08-25T17:54:12+08:00"),
  });
  try {
    await runtime.start();
    dws.manualReplyFailures = 1;
    const suppressed = await runtime.send({
      conversationId: "conversation-1",
      content: "outer candidate must not send",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(blockerResult.outcomeUnknown, true);
    assert.equal(suppressed.success, false);
    assert.equal(suppressed.staleGeneration, true);
    assert.equal(dws.sent.length, 1);
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(persisted.sendBlocked, true);
    assert.equal(Object.values(persisted.sendLedger).length, 1);
    assert.equal(Object.values(persisted.sendLedger)[0].status, "unknown");
    assert.equal(persisted.deferredReply.waiting, false);
    assert.equal(persisted.deferredReply.errorCode, "deferred_reply_stale");
  } finally {
    await runtime.stop();
  }
});

test("restart retires an in-memory deferred reply without replaying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-deferred-restart-"));
  const stateFile = join(root, "state.json");
  await writeFile(stateFile, `${JSON.stringify({
    deferredReply: {
      waiting: true,
      attemptCount: 3,
      errorCode: "tls_timeout",
      expiresAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T09:59:00.000Z",
    },
  })}\n`, { mode: 0o600 });
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: [],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      eventWakeEnabled: false,
      sendEnabled: false,
    },
    dws: new FakeDws(),
    emit: () => {},
  });
  try {
    await runtime.start();
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(persisted.deferredReply.waiting, false);
    assert.equal(persisted.deferredReply.attemptCount, 3);
    assert.equal(persisted.deferredReply.errorCode, "candidate_lost_on_restart");
    assert.equal(persisted.deferredReply.expiresAt, null);
    assert.deepEqual(persisted.sendLedger, {});
  } finally {
    await runtime.stop();
  }
});

test("deferred reply is suppressed when an owner reply appears during retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-manual-detected-"));
  const stateFile = join(root, "state.json");
  const dws = new FakeDws();
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      outboundQuietMs: 0,
      outboundMaxQuietMs: 0,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    wait: async () => { dws.manualReply = true; },
    now: () => new Date("2026-08-25T16:43:12+08:00"),
  });
  try {
    await runtime.start();
    dws.manualReplyFailures = 1;
    const suppressed = await runtime.send({
      conversationId: "conversation-1",
      content: "late answer",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(suppressed.success, false);
    assert.equal(suppressed.staleGeneration, true);
    assert.equal(suppressed.manualReplyDetected, true);
    assert.equal(dws.sent.length, 0);
    const persisted = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(persisted.deferredReply.waiting, false);
    assert.equal(persisted.deferredReply.errorCode, "owner_reply_detected");
    assert.deepEqual(persisted.sendLedger, {});
  } finally {
    await runtime.stop();
  }
});

test("Hermes DWS sidecar emits withdrawal audit without replaying message content", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-withdrawn-"));
  const frames = [];
  const dws = new FakeDws();
  dws.withdrawn = true;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws,
    emit: (frame) => frames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  await runtime.stop();
  const withdrawn = frames.find((frame) => frame.record?.control === "message_withdrawn");
  assert.ok(withdrawn);
  assert.equal(withdrawn.record.messageId, "dws-1");
  assert.equal(Object.hasOwn(withdrawn.record, "content"), false);
});

test("Hermes DWS sidecar marks an explicit send without server message id as unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-unknown-"));
  const dws = new FakeDws();
  dws.receiptWithoutMessageId = true;
  dws.fetchDirect = undefined;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  const result = await runtime.send({
    conversationId: "conversation-1",
    content: "完成了",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  const duplicate = await runtime.send({
    conversationId: "conversation-1",
    content: "完成了",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await runtime.stop();
  assert.equal(result.success, false);
  assert.equal(result.outcomeUnknown, true);
  assert.equal(duplicate.outcomeUnknown, true);
  assert.equal(duplicate.sendSuspended, true);
  assert.equal(dws.sent.length, 1);
  const blocked = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  assert.equal(blocked.sendBlocked, true);
  assert.equal(blocked.sendBlockReason, "missing_server_message_id");

  const shadow = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: null,
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: false,
    },
    dws: new FakeDws(),
    emit: () => {},
    now: () => new Date("2026-08-18T14:02:00+08:00"),
  });
  await shadow.start();
  await shadow.stop();
  const cleared = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  assert.equal(cleared.sendBlocked, false);
});

test("Hermes DWS sidecar reuses a completed send receipt after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-send-ledger-"));
  const stateFile = join(root, "state.json");
  const config = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: "owner-user",
    stateFile,
    initialLookbackMs: 120_000,
    fallbackMs: 300_000,
    sendEnabled: true,
  };
  const firstDws = new FakeDws();
  const first = await createSidecarRuntime({
    config,
    dws: firstDws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await first.start();
  const receipt = await first.send({
    conversationId: "conversation-1",
    content: "完成了",
    replyTo: "source-1",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await first.stop();

  const secondDws = new FakeDws();
  const second = await createSidecarRuntime({
    config,
    dws: secondDws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:02:00+08:00"),
  });
  await second.start();
  const repeated = await second.send({
    conversationId: "conversation-1",
    content: "完成了",
    replyTo: "source-1",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await second.stop();
  assert.equal(receipt.success, true);
  assert.equal(repeated.success, true);
  assert.equal(repeated.messageId, receipt.messageId);
  assert.equal(secondDws.sent.length, 0);
});

test("Hermes DWS sidecar restart keeps dedupe and recipient recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-restart-"));
  const stateFile = join(root, "state.json");
  const config = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: "owner-user",
    stateFile,
    initialLookbackMs: 120_000,
    fallbackMs: 300_000,
    sendEnabled: true,
  };
  const firstFrames = [];
  const firstDws = new FakeDws();
  const first = await createSidecarRuntime({
    config,
    dws: firstDws,
    emit: (frame) => firstFrames.push(frame),
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await first.start();
  await first.stop();
  assert.equal(firstFrames.filter((frame) => frame.type === "event").length, 1);

  const secondFrames = [];
  const secondDws = new FakeDws();
  const second = await createSidecarRuntime({
    config,
    dws: secondDws,
    emit: (frame) => secondFrames.push(frame),
    now: () => new Date("2026-08-18T14:01:10+08:00"),
  });
  await second.start();
  const receipt = await second.send({
    conversationId: "conversation-1",
    content: "恢复后的结果",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await second.stop();
  assert.equal(secondFrames.filter((frame) => frame.type === "event").length, 0);
  assert.equal(receipt.success, true);
  assert.equal(secondDws.sent[0].recipientId, "open-trusted");
  assert.equal(secondDws.sent[0].recipientKind, "open_dingtalk_id");
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(persisted.recentMessageIds, ["dws-1"]);
  assert.equal(persisted.recipients["conversation-1"].recipientId, "open-trusted");
  assert.equal(persisted.recipients["conversation-1"].recipientKind, "open_dingtalk_id");
});

test("Hermes DWS sidecar verifies a missing receipt id by exact DWS readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-readback-"));
  const dws = new FakeDws();
  dws.receiptWithoutMessageId = true;
  dws.readBackMessage = {
    id: "readback-message-1",
    conversationId: "conversation-1",
    createTime: new Date().toISOString(),
    content: "完成了",
    raw: { aiTag: true },
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  const receipt = await runtime.send({
    conversationId: "conversation-1",
    content: "完成了",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await runtime.stop();
  assert.equal(receipt.success, true);
  assert.equal(receipt.messageId, "readback-message-1");
});

test("Hermes DWS sidecar verifies Markdown-transformed readback without an AI marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-rendered-readback-"));
  const stateFile = join(root, "state.json");
  const dws = new FakeDws();
  dws.receiptWithoutMessageId = true;
  dws.readBackMessage = {
    id: "rendered-readback-message",
    conversationId: "conversation-1",
    createTime: "2026-08-18T14:01:01+08:00",
    content: "当前状态：  \n1. 版本：**v1**1. 模式：**active**1. 发送：**true**1. 证据：[技术设计文档](:234)",
    raw: {},
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  const receipt = await runtime.send({
    conversationId: "conversation-1",
    content: "当前状态：\n\n1. 版本：`v1`\n2. 模式：`active`\n3. 发送：`true`\n4. 证据：[技术设计文档](/Users/example/Foursday/docs/技术设计文档.md:234)",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await runtime.stop();
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(receipt.success, true);
  assert.equal(receipt.messageId, "rendered-readback-message");
  assert.equal(state.sendBlocked, false);
  assert.equal(Object.values(state.sendLedger)[0].status, "completed");
  assert.equal(Object.values(state.sendLedger)[0].fingerprintVersion, 2);
  assert.equal(Object.values(state.sendLedger)[0].orderedListFingerprint, true);
  assert.match(Object.values(state.sendLedger)[0].contentRenderFingerprint, /^[a-f0-9]{64}$/u);
});

test("Hermes DWS sidecar resolves an ambiguous receipt through exact readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-ambiguous-readback-"));
  const dws = new FakeDws();
  dws.receiptUnknown = true;
  dws.receiptWithoutMessageId = true;
  dws.readBackMessage = {
    id: "readback-message-ambiguous",
    conversationId: "conversation-1",
    createTime: "2026-08-18T14:01:01+08:00",
    content: "完成了",
    raw: {},
  };
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["trusted-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: () => {},
    now: () => new Date("2026-08-18T14:01:00+08:00"),
  });
  await runtime.start();
  const receipt = await runtime.send({
    conversationId: "conversation-1",
    content: "完成了",
    ownerRevision: 0,
    sendGeneration: 1,
  });
  await runtime.stop();
  assert.equal(receipt.success, true);
  assert.equal(receipt.messageId, "readback-message-ambiguous");
  assert.equal(dws.sent.length, 1);
});

test("Hermes DWS sidecar filters its own message after an unknown transport outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-unknown-self-loop-"));
  const frames = [];
  const dws = new FakeDws();
  let phase = "inbound";
  dws.fetchBySender = async () => [];
  dws.fetchDirect = async () => phase === "inbound" ? [{
    id: "owner-request",
    senderUserId: "owner-user",
    senderName: "Owner",
    conversationId: "self-conversation",
    content: "请核对状态",
    createTime: "2026-08-24T10:00:30+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
    raw: {},
  }] : [{
    id: "ambiguous-ai-reply",
    senderUserId: "owner-user",
    senderName: "Owner",
    conversationId: "self-conversation",
    content: "已核对完成",
    createTime: "2026-08-24T10:01:01+08:00",
    isSelf: false,
    isWithdrawn: false,
    media: [],
    raw: {},
  }];
  dws.transportFailure = true;
  const runtime = await createSidecarRuntime({
    config: {
      dwsPath: process.execPath,
      dingtalkRoot: "",
      userIds: ["owner-user"],
      groupIds: [],
      selfUserId: "owner-user",
      stateFile: join(root, "state.json"),
      mediaRoot: null,
      initialLookbackMs: 120_000,
      fallbackMs: 300_000,
      sendEnabled: true,
    },
    dws,
    emit: (frame) => frames.push(frame),
    diagnose: () => {},
    now: () => new Date("2026-08-24T10:01:00+08:00"),
  });
  try {
    await runtime.start();
    const result = await runtime.send({
      conversationId: "self-conversation",
      content: "已核对完成",
      ownerRevision: 0,
      sendGeneration: 1,
    });
    assert.equal(result.outcomeUnknown, true);
    phase = "outbound";
    const retry = await runtime.check({ deferEmit: true });
    assert.equal(retry.some((frame) => frame.record?.id === "ambiguous-ai-reply"), false);
    const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    const intent = Object.values(persisted.sendLedger)[0];
    assert.match(intent.contentDigest, /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(intent, "content"), false);
    assert.equal(Object.hasOwn(intent, "receipt"), false);
  } finally {
    await runtime.stop();
  }
});
