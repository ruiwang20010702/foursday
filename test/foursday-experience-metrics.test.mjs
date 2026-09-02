import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { analyzeFoursdayExperience } from "../src/foursday-experience-metrics.mjs";
import {
  foursdayExperienceObservationEvents,
  foursdayExperienceTaskHash,
} from "../src/foursday-experience-observation.mjs";

const execFileAsync = promisify(execFile);

test("experience report computes targets but refuses to call a small sample sufficient", () => {
  const taskHash = "a".repeat(16);
  const report = analyzeFoursdayExperience([
    { type: "setup_completed", success: true, durationMs: 540_000, inputCount: 2, taskHash },
    { type: "message_detected", durationMs: 8_000, wakeSource: "dws_event", taskHash },
    { type: "ack_sent", durationMs: 12_000, taskHash },
    { type: "first_effective_reply", taskClass: "instant", durationMs: 25_000, taskHash },
    { type: "responsibility_check", correct: true, taskHash },
    { type: "duplicate_send_check", duplicated: false, taskHash },
    { type: "takeover_reply_check", repliedAfterTakeover: false, taskHash },
    { type: "task_result", completed: true, taskHash },
  ]);
  assert.equal(report.sample.taskCount, 1);
  assert.equal(report.sample.sufficient, false);
  assert.equal(report.metrics.detectionP95Ms.passed, true);
  assert.equal(report.metrics.realtimeDetectionP95Ms.passed, true);
  assert.equal(report.metrics.fallbackDetectionP95Ms.passed, null);
});

test("experience report represents missing evidence as unknown instead of passed", () => {
  const report = analyzeFoursdayExperience([]);
  assert.equal(report.sample.sufficient, false);
  for (const value of Object.values(report.metrics)) {
    assert.equal(value.value, null);
    assert.equal(value.sampleSize, 0);
    assert.equal(value.passed, null);
  }
});

test("experience report consumes existing reply evidence without private content", () => {
  const report = analyzeFoursdayExperience([{
    type: "reply_attempt",
    detectionLatencyMs: 7_500,
    wakeSource: "dws_event",
    agentDurationMs: 11_000,
    deliveryKind: "interim_ack",
    conversationHash: "c".repeat(16),
    contentHash: "b".repeat(64),
  }]);
  assert.equal(report.sample.taskCount, 0);
  assert.equal(report.sample.taskIdentity, "none");
  assert.equal(report.sample.legacyConversationCount, 1);
  assert.equal(report.metrics.detectionP95Ms.value, 7_500);
  assert.equal(report.metrics.realtimeDetectionP95Ms.value, 7_500);
  assert.equal(report.metrics.fallbackDetectionP95Ms.value, null);
  assert.equal(report.metrics.acknowledgmentP95Ms.value, 11_000);
  assert.doesNotMatch(JSON.stringify(report), /contentHash/u);
});

test("experience report keeps fallback latency visible without calling it realtime", () => {
  const report = analyzeFoursdayExperience([
    {
      type: "inbound", conversationHash: "d".repeat(16), workItemHash: "1".repeat(64), checkToDetectionMs: 8_000,
      detectionLatencyMs: 61_000, wakeSource: "fallback",
    },
    {
      type: "reply_attempt", conversationHash: "d".repeat(16),
      detectionLatencyMs: 61_000, wakeSource: "fallback",
    },
    {
      type: "inbound", conversationHash: "e".repeat(16), workItemHash: "2".repeat(64), checkToDetectionMs: 900,
      detectionLatencyMs: 1_200, wakeSource: "filesystem",
    },
  ]);
  assert.equal(report.sample.taskCount, 0);
  assert.equal(report.sample.observedWorkItemCount, 2);
  assert.equal(report.sample.legacyConversationCount, 2);
  assert.equal(report.metrics.detectionP95Ms.value, 61_000);
  assert.equal(report.metrics.detectionP95Ms.passed, false);
  assert.equal(report.metrics.realtimeDetectionP95Ms.value, 1_200);
  assert.equal(report.metrics.realtimeDetectionP95Ms.passed, true);
  assert.equal(report.metrics.fallbackDetectionP95Ms.value, 61_000);
  assert.equal(report.metrics.fallbackDetectionP95Ms.passed, null);
  assert.equal(report.metrics.internalDetectionP95Ms.value, 8_000);
  assert.equal(report.metrics.internalDetectionP95Ms.passed, true);
});

test("experience report counts only terminally reviewed tasks as sufficient", () => {
  const events = Array.from({ length: 30 }, (_value, index) => ({
    type: index === 29 ? "task_result" : "message_detected",
    taskHash: index.toString(16).padStart(16, "0"),
    ...(index === 29 ? { completed: true } : { durationMs: 1_000 }),
  }));
  const report = analyzeFoursdayExperience(events);
  assert.equal(report.sample.taskCount, 1);
  assert.equal(report.sample.sufficient, false);
  assert.equal(report.sample.taskIdentity, "reviewed_task_hash");
});

test("experience report requires thirty distinct terminal reviews", () => {
  const report = analyzeFoursdayExperience(Array.from({ length: 30 }, (_value, index) => ({
    type: "task_result",
    taskHash: index.toString(16).padStart(16, "0"),
    completed: index !== 29,
  })));
  assert.equal(report.sample.taskCount, 30);
  assert.equal(report.sample.sufficient, true);
  assert.equal(report.metrics.taskCompletionRate.sampleSize, 30);
  assert.equal(report.metrics.taskCompletionRate.passed, true);
});

test("privacy-safe observations become one deterministic reviewed task", () => {
  const sourceHash = "d".repeat(64);
  const observation = {
    schema: "foursday-experience-observation/v1",
    sourceHash,
    taskClass: "normal",
    wakeSource: "filesystem",
    detectionMs: 4_000,
    internalDetectionMs: 600,
    acknowledgmentMs: null,
    firstEffectiveReplyMs: 20_000,
    responsibilityCorrect: true,
    duplicated: false,
    takeoverObserved: true,
    repliedAfterTakeover: false,
    completed: true,
  };
  const first = foursdayExperienceObservationEvents(observation, {
    recordedAt: "2026-09-02T00:00:00.000Z",
  });
  const second = foursdayExperienceObservationEvents(observation, {
    recordedAt: "2026-09-02T00:01:00.000Z",
  });
  assert.equal(first.taskHash, foursdayExperienceTaskHash(sourceHash));
  assert.equal(first.taskHash, second.taskHash);
  assert.equal(analyzeFoursdayExperience(first.events).sample.taskCount, 1);
  assert.doesNotMatch(JSON.stringify(first), /sourceHash/u);
});

test("experience observations reject private or ambiguous extra fields", () => {
  assert.throws(() => foursdayExperienceObservationEvents({
    schema: "foursday-experience-observation/v1",
    sourceHash: "e".repeat(64),
    taskClass: "instant",
    wakeSource: "dws_event",
    detectionMs: 1_000,
    responsibilityCorrect: true,
    duplicated: false,
    takeoverObserved: false,
    completed: true,
    messageText: "private",
  }), /unknown fields/u);
});

test("experience CLI reads and writes only private files", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-experience-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const evidence = join(root, "events.jsonl");
  const output = join(root, "report.json");
  await writeFile(evidence, `${JSON.stringify({
    type: "message_detected", taskHash: "c".repeat(16), durationMs: 4_000,
  })}\n`, { mode: 0o600 });
  await execFileAsync(process.execPath, [
    fileURLToPath(new URL("../scripts/验证Foursday真实任务体验.mjs", import.meta.url)),
    "--evidence", evidence, "--output", output,
  ]);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.metrics.detectionP95Ms.value, 4_000);
  assert.equal((await stat(output)).mode & 0o077, 0);
});

test("experience recorder appends one private reviewed task and rejects duplicates", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-experience-record-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const observation = join(root, "observation.json");
  const evidence = join(root, "events.jsonl");
  await writeFile(observation, `${JSON.stringify({
    schema: "foursday-experience-observation/v1",
    sourceHash: "f".repeat(64),
    taskClass: "long",
    wakeSource: "dws_event",
    detectionMs: 2_000,
    internalDetectionMs: 500,
    acknowledgmentMs: null,
    firstEffectiveReplyMs: 45_000,
    responsibilityCorrect: true,
    duplicated: false,
    takeoverObserved: false,
    completed: true,
  })}\n`, { mode: 0o600 });
  const script = fileURLToPath(new URL("../scripts/记录Foursday真实任务体验.mjs", import.meta.url));
  const result = await execFileAsync(process.execPath, [
    script, "--observation", observation, "--evidence", evidence,
  ]);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.recorded, true);
  assert.equal(receipt.messagesSent, 0);
  const text = await readFile(evidence, "utf8");
  assert.doesNotMatch(text, /sourceHash/u);
  assert.equal(analyzeFoursdayExperience(
    text.split("\n").filter(Boolean).map(JSON.parse),
  ).sample.taskCount, 1);
  await assert.rejects(execFileAsync(process.execPath, [
    script, "--observation", observation, "--evidence", evidence,
  ]), /already recorded/u);
  assert.equal((await stat(evidence)).mode & 0o077, 0);
});

test("experience recorder rejects a symlinked evidence directory", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-experience-symlink-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const privateDirectory = join(root, "private");
  const linkedDirectory = join(root, "linked");
  await mkdir(privateDirectory, { mode: 0o700 });
  await symlink(privateDirectory, linkedDirectory);
  const observation = join(root, "observation.json");
  await writeFile(observation, `${JSON.stringify({
    schema: "foursday-experience-observation/v1",
    sourceHash: "a".repeat(64),
    taskClass: "instant",
    wakeSource: "filesystem",
    detectionMs: 500,
    responsibilityCorrect: true,
    duplicated: false,
    takeoverObserved: false,
    completed: true,
  })}\n`, { mode: 0o600 });
  const script = fileURLToPath(new URL("../scripts/记录Foursday真实任务体验.mjs", import.meta.url));
  await assert.rejects(execFileAsync(process.execPath, [
    script,
    "--observation", observation,
    "--evidence", join(linkedDirectory, "events.jsonl"),
  ]), /directory is unsafe/u);
});
