import assert from "node:assert/strict";
import test from "node:test";
import { activityForCodexNotification } from "../src/foursday-codex-activity.mjs";

const now = new Date("2026-08-31T12:00:00.000Z");

test("Codex notifications become bounded user-facing activities", () => {
  const cases = [
    [{ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } }, "analyze"],
    [{ method: "item/started", params: { threadId: "thread", item: { id: "1", type: "commandExecution", command: "sed -n '1p' docs/产品需求文档.md" } } }, "read"],
    [{ method: "item/started", params: { threadId: "thread", item: { id: "2", type: "commandExecution", command: "npm test" } } }, "test"],
    [{ method: "item/completed", params: { threadId: "thread", item: { id: "3", type: "fileChange", changes: [{ path: "/private/project/src/main.mjs" }] } } }, "edit"],
    [{ method: "item/started", params: { threadId: "thread", item: { id: "4", type: "webSearch" } } }, "search"],
    [{ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } }, "complete"],
  ];
  for (const [message, expected] of cases) {
    const activity = activityForCodexNotification(message, now);
    assert.equal(activity.kind, expected);
    assert.match(activity.eventId, /^[a-f0-9]{64}$/u);
    assert.equal(activity.occurredAt, now.toISOString());
    assert.ok(activity.summary.length <= 140);
    assert.ok(activity.detail.length <= 160);
  }
});

test("activity projection never stores raw reasoning, commands, paths, arguments or secrets", () => {
  assert.equal(activityForCodexNotification({
    method: "item/completed",
    params: { threadId: "thread", item: { type: "agentMessage", text: "private answer" } },
  }, now), null);
  const command = activityForCodexNotification({
    method: "item/started",
    params: {
      threadId: "thread",
      item: {
        id: "secret-command",
        type: "commandExecution",
        command: "cat /private/customer/plan.md && curl -H authorization=Bearer-secret",
      },
    },
  }, now);
  const serialized = JSON.stringify(command);
  assert.match(command.detail, /plan\.md/u);
  assert.doesNotMatch(serialized, /\/private\/customer|curl|authorization|Bearer-secret/u);
  assert.equal(activityForCodexNotification({
    method: "item/started",
    params: { threadId: "thread", item: { type: "reasoning", text: "hidden chain of thought" } },
  }, now).detail, "基于当前任务上下文");
});
