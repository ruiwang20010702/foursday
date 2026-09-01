import assert from "node:assert/strict";
import test from "node:test";
import { goldenPaths } from "../scripts/验证Foursday黄金路径.mjs";

test("维护性重构由五条明确且互斥的黄金路径保护", () => {
  assert.deepEqual(
    goldenPaths.map((path) => path.id),
    [
      "ordinary_reply",
      "fragmented_message",
      "owner_takeover",
      "durable_task",
      "restart_recovery",
    ],
  );
  assert.equal(new Set(goldenPaths.map((path) => path.pattern)).size, 5);
  for (const path of goldenPaths) {
    assert.match(path.label, /\S/u);
    assert.match(path.pattern, /\S/u);
  }
});
