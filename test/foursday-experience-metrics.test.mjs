import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { analyzeFoursdayExperience } from "../src/foursday-experience-metrics.mjs";

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
  assert.equal(report.sample.taskCount, 1);
  assert.equal(report.sample.taskIdentity, "conversation_hash");
  assert.equal(report.metrics.detectionP95Ms.value, 7_500);
  assert.equal(report.metrics.realtimeDetectionP95Ms.value, 7_500);
  assert.equal(report.metrics.fallbackDetectionP95Ms.value, null);
  assert.equal(report.metrics.acknowledgmentP95Ms.value, 11_000);
  assert.doesNotMatch(JSON.stringify(report), /contentHash/u);
});

test("experience report keeps fallback latency visible without calling it realtime", () => {
  const report = analyzeFoursdayExperience([
    {
      type: "inbound", conversationHash: "d".repeat(16), checkToDetectionMs: 8_000,
      detectionLatencyMs: 61_000, wakeSource: "fallback",
    },
    {
      type: "reply_attempt", conversationHash: "d".repeat(16),
      detectionLatencyMs: 61_000, wakeSource: "fallback",
    },
    {
      type: "inbound", conversationHash: "e".repeat(16), checkToDetectionMs: 900,
      detectionLatencyMs: 1_200, wakeSource: "filesystem",
    },
  ]);
  assert.equal(report.sample.taskCount, 2);
  assert.equal(report.metrics.detectionP95Ms.value, 61_000);
  assert.equal(report.metrics.detectionP95Ms.passed, false);
  assert.equal(report.metrics.realtimeDetectionP95Ms.value, 1_200);
  assert.equal(report.metrics.realtimeDetectionP95Ms.passed, true);
  assert.equal(report.metrics.fallbackDetectionP95Ms.value, 61_000);
  assert.equal(report.metrics.fallbackDetectionP95Ms.passed, null);
  assert.equal(report.metrics.internalDetectionP95Ms.value, 8_000);
  assert.equal(report.metrics.internalDetectionP95Ms.passed, true);
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
