import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withDwsCommandLock } from "../src/dws-command-lock.mjs";

test("DWS command lock serializes callers that run in separate queues", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-lock-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "dws-command.lock");
  let active = 0;
  let maximumActive = 0;
  const order = [];
  const run = (name, milliseconds) => withDwsCommandLock(lock, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    order.push(`${name}:end`);
    active -= 1;
    return name;
  });
  const first = run("first", 30);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = run("second", 1);
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
});

test("DWS command lock reports bounded busy and recovers only stale lock directories", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-lock-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "dws-command.lock");
  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(
    withDwsCommandLock(lock, async () => "must-not-run", { timeoutMs: 0 }),
    (error) => error.code === "dws_command_busy",
  );
  const old = new Date(Date.now() - 121_000);
  await utimes(lock, old, old);
  const result = await withDwsCommandLock(lock, async () => "recovered", {
    timeoutMs: 100,
    staleMs: 120_000,
  });
  assert.equal(result, "recovered");
});

test("a stale lock owner cannot remove the replacement owner's lock", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dws-lock-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, "dws-command.lock");
  let releaseFirst;
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const firstReady = new Promise((resolve) => { firstStarted = resolve; });
  const first = withDwsCommandLock(lock, async () => {
    firstStarted();
    await firstRelease;
    return "first";
  });
  await firstReady;
  const old = new Date(Date.now() - 61_000);
  await utimes(lock, old, old);
  let releaseSecond;
  const secondRelease = new Promise((resolve) => { releaseSecond = resolve; });
  let secondStarted;
  const secondReady = new Promise((resolve) => { secondStarted = resolve; });
  const second = withDwsCommandLock(lock, async () => {
    secondStarted();
    await secondRelease;
    return "second";
  }, { timeoutMs: 100, staleMs: 60_000 });
  await secondReady;
  releaseFirst();
  assert.equal(await first, "first");
  await access(lock);
  releaseSecond();
  assert.equal(await second, "second");
  await assert.rejects(access(lock), (error) => error.code === "ENOENT");
});
