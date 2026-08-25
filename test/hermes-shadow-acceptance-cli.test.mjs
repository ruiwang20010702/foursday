import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const releaseSha = "a".repeat(40);
const evidenceDigest = "b".repeat(64);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "foursday-shadow-acceptance-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const ledger = join(root, "ledger.jsonl");
  const restart = join(root, "restart.json");
  const code = join(root, "code.json");
  const output = join(root, "acceptance.json");
  const events = [
    { type: "inbound", conversationHash: "c", participantHash: "p", messageHashes: ["m1"], projectId: "p1", routeStatus: "matched", memoryStatus: "available" },
    { type: "reply_attempt", conversationHash: "c", contentHash: "c".repeat(64), contentBytes: 8, mode: "shadow", bridgeSuccess: false, outcomeUnknown: false },
    { type: "inbound", conversationHash: "c", participantHash: "p", messageHashes: ["m2"], projectId: "p1", routeStatus: "bound", memoryStatus: "available" },
    { type: "communication_takeover", conversationHash: "c", participantHash: "p" },
  ].map((event) => ({ ...event, releaseSha, recordedAt: "2026-08-18T11:59:00.000Z" }));
  await writeFile(ledger, `${events.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  for (const path of [restart, code]) {
    await writeFile(path, `${JSON.stringify({
      passed: true,
      releaseSha,
      evidenceDigest,
    })}\n`, { mode: 0o600 });
  }
  return { ledger, restart, code, output };
}

function args(paths, apply = false) {
  return [
    "scripts/生成Foursday影子验收.mjs",
    "--release-sha",
    releaseSha,
    "--ledger",
    paths.ledger,
    "--restart-evidence",
    paths.restart,
    "--code-evidence",
    paths.code,
    "--output",
    paths.output,
    ...(apply ? ["--apply"] : []),
  ];
}

test("Foursday shadow 验收默认零写，显式应用才生成私有凭据", async (t) => {
  const paths = await fixture(t);
  const preview = JSON.parse((await execFileAsync(process.execPath, args(paths), {
    cwd: new URL("../", import.meta.url),
  })).stdout);
  assert.equal(preview.valid, true);
  assert.equal(preview.receiptReady, true);
  assert.equal(preview.productionWrite, false);
  await assert.rejects(access(paths.output), { code: "ENOENT" });

  const applied = JSON.parse((await execFileAsync(process.execPath, args(paths, true), {
    cwd: new URL("../", import.meta.url),
  })).stdout);
  assert.equal(applied.applied, true);
  assert.equal(applied.scenarioCount, 10);
  const receipt = JSON.parse(await readFile(paths.output, "utf8"));
  assert.equal(receipt.releaseSha, releaseSha);
  assert.equal((await stat(paths.output)).mode & 0o077, 0);
});
