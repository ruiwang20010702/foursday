import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyOwnerIntervention,
  createSidecarRuntime,
} from "../src/hermes-dws-sidecar.mjs";
import { FoursdayControlStore } from "../src/foursday-control-store.mjs";

test("owner intervention classifier keeps communication, task and unrelated ownership distinct", () => {
  assert.equal(classifyOwnerIntervention("我已经回复对方了"), "communication_takeover");
  assert.equal(classifyOwnerIntervention("改成先核对全量口径"), "task_correction");
  assert.equal(classifyOwnerIntervention("这个任务我来处理"), "task_takeover");
  assert.equal(classifyOwnerIntervention("继续"), "resume_requested");
  assert.equal(classifyOwnerIntervention("今天天气不错", { active: false }), "unrelated_owner_message");
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
    await assert.rejects(
      runtime.start(),
      (error) => error.code === "DWS_SIDECAR_TARGETS_UNAVAILABLE",
    );
    await control.apply({ action: "resume_all", expectedRevision: 1 });
    const retry = await runtime.check({ deferEmit: true });
    assert.equal(retry.filter((frame) => frame.record?.id === "dws-1").length, 1);
    const state = JSON.parse(await readFile(join(root, "dws.json"), "utf8").catch(() => "{}"));
    assert.deepEqual(state.recentMessageIds ?? [], []);
  } finally {
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
    this.withdrawn = false;
    this.receiptWithoutMessageId = false;
    this.readBackMessage = null;
    this.media = false;
    this.downloadFailures = 0;
  }

  async fetchBySender({ senderUserId }) {
    this.directCalls += 1;
    return [{
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
      media: this.media ? [{ resourceId: "$media-1", name: "image.png", mimeType: "image/png" }] : [],
    }];
  }

  async fetchGroupMentions() {
    return [];
  }

  async sendMessage(input) {
    this.sent.push(input);
    return this.receiptWithoutMessageId
      ? { status: "SENT" }
      : { status: "SENT", messageId: "server-message-1" };
  }

  verifySendReceipt(receipt) {
    assert.equal(receipt.status, "SENT");
  }

  async hasManualReply(input) {
    this.manualInput = input;
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

  async downloadMedia({ outputDirectory }) {
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
    await assert.rejects(
      runtime.start(),
      (error) => error.code === "DWS_SIDECAR_TARGETS_UNAVAILABLE",
    );
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
    await assert.rejects(
      runtime.start(),
      (error) => error.code === "DWS_SIDECAR_TARGETS_UNAVAILABLE",
    );
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
  assert.equal(state.lastUsers["trusted-user"], "2026-08-18T06:01:00.000Z");
  assert.equal(state.lastFullSuccessAt, "2026-08-18T06:01:00.000Z");
  assert.equal(state.lastErrorCount, 0);
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
  await runtime.stop();
  const second = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(second.lastUsers["good-user"], "2026-08-18T06:02:00.000Z");
  assert.equal(second.lastUsers["bad-user"], "2026-08-18T06:01:00.000Z");
  assert.equal(second.lastFullSuccessAt, "2026-08-18T06:01:00.000Z");
  assert.equal(second.lastErrorCount, 1);
});

test("Hermes DWS sidecar keeps real sending disabled unless explicitly enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-send-"));
  const dws = new FakeDws();
  const base = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: null,
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
  }), { success: false, error: "DWS personal send is disabled" });
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
      selfUserId: null,
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
  assert.equal(dws.sent.length, 1);
});

test("Hermes DWS sidecar reuses a completed send receipt after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "foursday-dws-send-ledger-"));
  const stateFile = join(root, "state.json");
  const config = {
    dwsPath: process.execPath,
    dingtalkRoot: "",
    userIds: ["trusted-user"],
    groupIds: [],
    selfUserId: null,
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
    selfUserId: null,
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
      selfUserId: null,
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
