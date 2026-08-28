import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replayDwsMessages } from "../src/dws-state-replay.mjs";

test("DWS replay is preview-first, exact and recoverable", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-replay-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = join(root, "dws.json");
  const original = {
    recentMessageIds: ["older", "replay-1", "replay-2", "newer"],
    lastEnterpriseAt: "2026-08-28T07:20:00.000Z",
  };
  await writeFile(stateFile, `${JSON.stringify(original)}\n`, { mode: 0o600 });
  const input = {
    stateFile,
    messageIds: ["replay-1", "replay-2"],
    before: "2026-08-28T07:18:27.000Z",
    now: new Date("2026-08-28T08:00:00.000Z"),
  };
  const preview = await replayDwsMessages(input);
  assert.equal(preview.apply, false);
  assert.equal(preview.messagesFound, 2);
  assert.equal(await readFile(stateFile, "utf8"), `${JSON.stringify(original)}\n`);

  const applied = await replayDwsMessages({ ...input, apply: true });
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.deepEqual(state.recentMessageIds, ["older", "newer"]);
  assert.equal(state.lastEnterpriseAt, "2026-08-28T07:18:22.000Z");
  assert.deepEqual(JSON.parse(await readFile(applied.backupPath, "utf8")), original);
  await assert.rejects(replayDwsMessages({ ...input, apply: true }), /not in the processed ledger/u);
});

test("DWS replay clamps the checkpoint at the Unix epoch", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-replay-epoch-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = join(root, "dws.json");
  await writeFile(stateFile, JSON.stringify({
    recentMessageIds: ["replay-epoch"],
    lastEnterpriseAt: "1970-01-01T00:00:10.000Z",
  }), { mode: 0o600 });
  await replayDwsMessages({
    stateFile,
    messageIds: ["replay-epoch"],
    before: "1970-01-01T00:00:01.000Z",
    apply: true,
    now: new Date("2026-08-28T08:00:00.000Z"),
  });
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(state.lastEnterpriseAt, "1970-01-01T00:00:00.000Z");
});
