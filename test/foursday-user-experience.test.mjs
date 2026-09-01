import assert from "node:assert/strict";
import test from "node:test";
import {
  taskWaitPolicy,
  userFacingRuntimeState,
  userFacingTaskState,
} from "../src/foursday-user-experience.mjs";

const baseGateway = {
  installed: true, running: true, mode: "active", sendEnabled: true,
  sendBlocked: false, modeConsistent: true, checkpointState: "healthy", checkpointBusy: false,
};

test("runtime translation hides engineering states behind one user action", () => {
  const active = userFacingRuntimeState({
    gateway: baseGateway, control: { state: "running" }, ready: true,
    tasks: [{ worksiteGroup: "working" }],
  });
  assert.equal(active.title, "已上岗");
  assert.equal(active.responsibility.owner, "ai");
  assert.equal(active.recommendation.code, "none");
  const blocked = userFacingRuntimeState({
    gateway: { ...baseGateway, sendBlocked: true }, control: { state: "running" }, ready: false,
  });
  assert.equal(blocked.title, "自动回复已暂停");
  assert.deepEqual(blocked.recommendation, {
    code: "check_dingtalk", label: "检查钉钉中的实际发送结果",
  });
  assert.doesNotMatch(JSON.stringify(blocked), /checkpoint|generation|acceptance|profile|registry/iu);
});

test("task translation distinguishes AI work, human need, takeover and background", () => {
  assert.equal(userFacingTaskState({ worksiteGroup: "working" }).waitTier, "normal");
  assert.equal(userFacingTaskState({
    worksiteGroup: "working",
    execution: { mode: "background", state: "running" },
  }).title, "正在后台处理");
  assert.equal(userFacingTaskState({
    taskContract: { lifecycleState: "escalated" },
  }).owner, "you");
  assert.equal(userFacingTaskState({ state: "taken_over" }).title, "任务已由你接管");
});

test("wait policy uses a 15 second boundary without turning normal work into durable work", () => {
  assert.deepEqual(taskWaitPolicy({ expectedClass: "instant", elapsedMs: 14_999, activityCount: 1 }), {
    tier: "instant", acknowledgment: "none", durable: false,
  });
  assert.deepEqual(taskWaitPolicy({ expectedClass: "foreground", elapsedMs: 15_000, activityCount: 1 }), {
    tier: "normal", acknowledgment: "once", durable: false,
  });
  assert.deepEqual(taskWaitPolicy({ expectedClass: "foreground", stepCount: 4 }), {
    tier: "long", acknowledgment: "once", durable: true,
  });
});
