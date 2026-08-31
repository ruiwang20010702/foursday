import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("macOS pet build is preview-first and remains an optional local companion", async () => {
  const { stdout } = await run(process.execPath, ["scripts/构建Foursday桌宠.mjs"], {
    cwd: new URL("../", import.meta.url),
  });
  const result = JSON.parse(stdout);
  assert.equal(result.apply, false);
  assert.equal(result.installed, false);
  assert.equal(result.productionWrite, false);
  assert.equal(result.messagesSent, 0);
  assert.match(result.output, /\.runtime\/foursday-pet\/Foursday Pet\.app$/u);
});

test("pet build refuses arbitrary output paths", async () => {
  await assert.rejects(
    run(process.execPath, ["scripts/构建Foursday桌宠.mjs", "--output", "/Applications/Other.app"], {
      cwd: new URL("../", import.meta.url),
    }),
    /Usage: 构建Foursday桌宠/u,
  );
});

test("pet reads only the loopback task projection and reuses Codex pet assets", async () => {
  const source = await readFile(new URL("../distribution/pet/macos/FoursdayPet.swift", import.meta.url), "utf8");
  assert.match(source, /127\.0\.0\.1:9466\/api\/status/u);
  assert.match(source, /\.codex\/pets/u);
  assert.match(source, /FOURSDAY_PET_ID/u);
  assert.match(source, /\.codex\/config\.toml/u);
  assert.match(source, /selected-avatar-id/u);
  assert.match(source, /value\.hasPrefix\("custom:"\)/u);
  for (const state of [
    "idle",
    "runningRight",
    "runningLeft",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "working",
    "review",
  ]) {
    assert.match(source, new RegExp(`case ${state}\\b`, "u"));
  }
  assert.match(source, /\.onHover \{ model\.setHovering\(\$0\) \}/u);
  assert.match(source, /\.onTapGesture \{ model\.petTapped\(\) \}/u);
  assert.match(source, /DragGesture\(minimumDistance: 4/u);
  assert.match(source, /translation\.width < 0 \? \.runningLeft : \.runningRight/u);
  assert.match(source, /lifecycle == "accepted"/u);
  assert.doesNotMatch(source, /guard status\?\.ready == true/u);
  assert.match(source, /status\.gateway\.mode != "active" \|\| !status\.gateway\.sendEnabled/u);
  assert.match(source, /item\.state != "taken_over"/u);
  assert.match(source, /status\.gateway\.sendBlocked == true \|\| status\.gateway\.modeConsistent == false/u);
  assert.match(source, /case \.idle: 1/u);
  assert.match(source, /case \.waving: 4/u);
  assert.match(source, /case \.jumping: 5/u);
  assert.match(source, /case \.waiting, \.working, \.review: 6/u);
  assert.match(source, /reduceMotion \|\| state == \.idle/u);
  assert.match(source, /scanPopulatedColumns\(in: cgImage, rows: rows\)/u);
  assert.match(source, /CGImageAlphaInfo\.premultipliedLast/u);
  assert.match(source, /stride\(from: 3, to: rgba\.count, by: 4\)/u);
  assert.match(source, /populatedColumns\[state\.row\]\.filter \{ \$0 < state\.frameLimit \}/u);
  assert.match(source, /% animationColumns\.count/u);
  assert.match(source, /frame\(column: animationColumns\[index\]\)/u);
  assert.match(source, /let entered = hovering && !isHovering/u);
  assert.match(source, /trigger\(\.waving, for: \.milliseconds\(840\)\)/u);
  assert.doesNotMatch(source, /interactionState = isHovering \? \.waving : nil/u);
  assert.doesNotMatch(source, /https:\/\//u);
  assert.doesNotMatch(source, /DWS|token|password|DATABASE_URL/u);
});
