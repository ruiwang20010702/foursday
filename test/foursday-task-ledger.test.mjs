import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FoursdayTaskLedgerStore } from "../src/foursday-task-ledger.mjs";

const taskId = "a".repeat(64);

test("task ledger persists a private semantic contract and evidence manifest", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-ledger-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const path = join(root, "task-ledger.json");
  const store = await new FoursdayTaskLedgerStore({ path }).open({ createParent: true });
  const created = await store.upsertFromAgent({
    taskId,
    projectId: "foursday",
    title: "整理本周交付证据",
    goal: "把真实项目状态整理成可验收结论。",
    deliverables: ["交付清单", "风险与下一步"],
    acceptanceCriteria: ["结论均有真实证据", "缺失信息明确标注"],
    lifecycleState: "working",
    confidence: 0.96,
    evidence: [{ kind: "message", status: "observed", summary: "当前请求已进入任务上下文" }],
    ownerRevision: 2,
    sendGeneration: 3,
  });
  assert.equal(created.result.task.lifecycleState, "working");
  const waiting = await store.upsertFromAgent({
    ...created.result.task,
    lifecycleState: "waiting_acceptance",
    evidence: [{ kind: "test", status: "verified", summary: "相关回归测试已通过" }],
    ownerRevision: 2,
    sendGeneration: 3,
  });
  assert.equal(waiting.result.task.lifecycleState, "waiting_acceptance");
  const metadata = await import("node:fs/promises").then(({ lstat }) => lstat(path));
  assert.equal(metadata.mode & 0o077, 0);
  assert.doesNotMatch(await readFile(path, "utf8"), /token\s*[:=]/iu);
});

test("task ledger rejects self-acceptance, stale generations, missing proof and secrets", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-task-ledger-negative-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const store = await new FoursdayTaskLedgerStore({ path: join(root, "ledger.json") })
    .open({ createParent: true });
  const base = {
    taskId,
    projectId: "foursday",
    title: "验证任务",
    goal: "证明任务状态可靠。",
    deliverables: [],
    acceptanceCriteria: ["有验证证据"],
    lifecycleState: "working",
    confidence: 0.9,
    evidence: [],
    ownerRevision: 4,
    sendGeneration: 8,
  };
  await store.upsertFromAgent(base);
  await assert.rejects(
    store.upsertFromAgent({ ...base, lifecycleState: "accepted" }),
    /update is invalid/u,
  );
  await assert.rejects(
    store.upsertFromAgent({ ...base, lifecycleState: "waiting_acceptance" }),
    /requires verified evidence/u,
  );
  await assert.rejects(
    store.upsertFromAgent({ ...base, ownerRevision: 3, sendGeneration: 9 }),
    /revision_conflict/u,
  );
  await assert.rejects(
    store.upsertFromAgent({ ...base, goal: "token=do-not-store-this" }),
    /goal is invalid/u,
  );
});
