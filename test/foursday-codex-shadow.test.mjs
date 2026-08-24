import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runFoursdayCodexShadow,
  shadowNotificationBelongsToTurn,
  shadowServerDecision,
  shadowVerificationPrompt,
} from "../src/foursday-codex-shadow.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-shadow-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileDirectory = join(root, "profile");
  const codexHome = join(profileDirectory, "local", "foursday", "codex");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(codexHome, "config.toml"), "approval_policy = \"untrusted\"\n", { mode: 0o600 });
  const configPath = join(root, "production.json");
  await writeFile(configPath, `${JSON.stringify({
    FOURSDAY_CODEX_PATH: "/usr/bin/true",
    FOURSDAY_USER_HOME: root,
  })}\n`, { mode: 0o600 });
  return { layout: { profileDirectory, userHome: root }, configPath };
}

test("shadow verification previews without a model call", async (t) => {
  const options = await fixture(t);
  let called = false;
  const result = await runFoursdayCodexShadow({
    ...options,
    execute: async () => { called = true; },
  });
  assert.equal(result.apply, false);
  assert.equal(result.loginRequiredBeforeApply, true);
  assert.equal(result.productionWrite, false);
  assert.equal(result.messageSent, false);
  assert.equal(called, false);
});

test("shadow prompt requires a real file read and never leaks the random token", () => {
  const prompt = shadowVerificationPrompt();
  assert.match(prompt, /read FACT\.txt/u);
  assert.match(prompt, /not provided/u);
  assert.doesNotMatch(prompt, /FOURSDAY-SHADOW-[A-F0-9]+/u);
});

test("shadow collector ignores child-thread completion while waiting for the parent", () => {
  assert.equal(shadowNotificationBelongsToTurn({
    method: "turn/completed",
    params: { threadId: "child", turn: { id: "child-turn" } },
  }, { threadId: "parent", turnId: "parent-turn" }), false);
  assert.equal(shadowNotificationBelongsToTurn({
    method: "item/completed",
    params: { threadId: "parent", turnId: "parent-turn", item: { type: "agentMessage" } },
  }, { threadId: "parent", turnId: "parent-turn" }), true);
});

test("shadow client approves terminal reads but refuses all file changes", () => {
  assert.deepEqual(shadowServerDecision({
    method: "item/commandExecution/requestApproval",
  }), { decision: "accept" });
  assert.deepEqual(shadowServerDecision({
    method: "item/fileChange/requestApproval",
  }), { decision: "decline" });
  assert.equal(shadowServerDecision({ method: "unknown" }), null);
});

test("shadow verification proves evidence use and an unchanged ephemeral workspace", async (t) => {
  const options = await fixture(t);
  const result = await runFoursdayCodexShadow({
    ...options,
    apply: true,
    execute: async ({ workspace, expectedFact, environment }) => {
      assert.equal(await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(workspace, "FACT.txt"), "utf8")), `${expectedFact}\n`);
      assert.equal(environment.FOURSDAY_PROJECT_REGISTRY.endsWith("projects.json"), true);
      return {
        finalText: `Verified from FACT.txt: ${expectedFact}`,
        turnStatus: "completed",
        completedItems: [{ type: "commandExecution", command: "sed -n 1p FACT.txt" }],
      };
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.workspaceUnchanged, true);
  assert.equal(result.workspaceDigestBefore, result.workspaceDigestAfter);
  assert.equal(result.toolEvidenceCount, 1);
  assert.equal(result.productionWrite, false);
  assert.equal(result.deploymentPerformed, false);
});

test("shadow verification rejects a model answer without project evidence", async (t) => {
  const options = await fixture(t);
  await assert.rejects(runFoursdayCodexShadow({
    ...options,
    apply: true,
    execute: async () => ({
      finalText: "I guessed the answer",
      turnStatus: "completed",
      completedItems: [{ type: "commandExecution" }],
    }),
  }), /did not contain verified project evidence/u);
});
