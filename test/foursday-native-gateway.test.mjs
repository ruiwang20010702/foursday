import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectFoursdayNativeGateway,
  runFoursdayNativeGatewayAction,
} from "../src/foursday-native-gateway.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-native-gateway-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profileDirectory = join(root, ".hermes", "profiles", "foursday");
  await mkdir(profileDirectory, { recursive: true });
  const checkpoint = join(root, "dws.json");
  const now = Date.now();
  await writeFile(checkpoint, JSON.stringify({
    lastFullSuccessAt: new Date(now).toISOString(),
    lastErrorCount: 0,
    manualReplyProbe: { ready: true, errorCode: null },
    eventWake: { enabled: true, ready: true, errorCode: null },
    lastWakeSource: "dws_event",
    lastDetection: { latencyMs: 250 },
  }), { mode: 0o600 });
  await writeFile(join(profileDirectory, ".env"), [
    'DWS_PERSONAL_SEND_ENABLED="false"',
    `DWS_PERSONAL_STATE_FILE=${JSON.stringify(checkpoint)}`,
    'DWS_PERSONAL_FALLBACK_MS="300000"',
    'DWS_PERSONAL_ENTERPRISE_USERS_ENABLED="true"',
    'FOURSDAY_MODE="shadow"',
    "",
  ].join("\n"), { mode: 0o600 });
  await writeFile(join(profileDirectory, "foursday-release.json"), JSON.stringify({
    schema: "foursday-profile-release/v1",
    foursdayVersion: "0.6.0",
    foursdayCommit: "b".repeat(40),
    hermesVersion: "0.20.4",
    hermesCommit: "e".repeat(40),
    hermesRepository: "https://github.com/NousResearch/hermes-agent.git",
  }), { mode: 0o600 });
  return {
    root,
    profileDirectory,
    layout: {
      userHome: root,
      hermesCommand: join(root, ".local", "bin", "hermes"),
      profileDirectory,
      profileAlias: join(root, ".local", "bin", "foursday-runtime"),
      installDirectory: join(root, ".hermes", "hermes-agent"),
    },
  };
}

async function nativeRuntimeIdentity(path, args) {
  if (path === "/usr/bin/git" && args.includes("rev-parse")) {
    return { stdout: `${"e".repeat(40)}\n` };
  }
  if (path === "/usr/bin/git" && args.includes("get-url")) {
    return { stdout: "https://github.com/NousResearch/hermes-agent.git\n" };
  }
  if (path === "/usr/bin/git" && args.includes("status")) {
    return { stdout: " M contributors/emails/agent@fixture.local\n" };
  }
  if (path === "/usr/bin/git" && args.includes("ls-files")) {
    return { stdout: "H agent/conversation_loop.py\n" };
  }
  return null;
}

function activationEvidence() {
  const releaseSha = "b".repeat(40);
  return {
    releaseSha,
    acceptance: {
      schema: "foursday-shadow-acceptance/v1",
      releaseSha,
      evidenceDigest: "a".repeat(64),
      createdAt: "2026-08-20T00:00:00.000Z",
      scenarios: Object.fromEntries([
        "allowlistedMessage", "projectRoute", "personalMemory", "naturalReply", "followup",
        "codeWork", "ownerIntervention", "restartRecovery", "sendDisabled", "noDuplicate",
      ].map((name) => [name, true])),
    },
    confirmation: `ACTIVATE-FOURSDAY:${releaseSha}:${"a".repeat(16)}`,
    now: new Date("2026-08-20T01:00:00.000Z"),
  };
}

test("native Gateway status is derived from the official profile and send mode", async (t) => {
  const value = await fixture(t);
  const status = await inspectFoursdayNativeGateway({
    layout: value.layout,
    run: async () => ({ stdout: "Gateway is running\n" }),
    now: Date.now() + 1_000,
  });
  assert.equal(status.ready, true);
  assert.equal(status.installed, true);
  assert.equal(status.serviceEnabled, true);
  assert.equal(status.mode, "shadow");
  assert.equal(status.accessPolicy, "enterprise");
  assert.equal(status.enterpriseUsersEnabled, true);
  assert.equal(status.sendEnabled, false);
  assert.equal(status.sendBlocked, false);
  assert.equal(status.checkpointState, "healthy");
  assert.equal(status.checkpointBusy, false);
  assert.equal(status.manualReplyProbeReady, true);
  assert.equal(status.manualReplyProbeDegraded, false);
  assert.equal(status.deferredReplyWaiting, false);
  assert.equal(status.deferredReplyAttemptCount, 0);
  assert.equal(status.eventWakeReady, true);
  assert.equal(status.eventWakeDegraded, false);
  assert.equal(status.lastWakeSource, "dws_event");
  assert.equal(status.lastDetectionLatencyMs, 250);
  const stopped = await inspectFoursdayNativeGateway({
    layout: value.layout,
    run: async () => ({ stdout: "Gateway is not running\n" }),
    now: Date.now() + 1_000,
  });
  assert.equal(stopped.ready, false);
  assert.equal(stopped.safeStopped, false);
});

test("native Gateway exposes a degraded manual-reply probe without failing message intake", async (t) => {
  const value = await fixture(t);
  const checkpointPath = join(value.root, "dws.json");
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  checkpoint.manualReplyProbe = {
    ready: false,
    errorCode: "dws_manual_reply_temporary",
    updatedAt: new Date().toISOString(),
  };
  checkpoint.deferredReply = {
    waiting: true,
    attemptCount: 2,
    errorCode: "tls_timeout",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
  const status = await inspectFoursdayNativeGateway({
    layout: value.layout,
    run: async () => ({ stdout: "Gateway is running\n" }),
    now: Date.now() + 1_000,
  });
  assert.equal(status.ready, true);
  assert.equal(status.checkpointState, "healthy");
  assert.equal(status.manualReplyProbeReady, false);
  assert.equal(status.manualReplyProbeDegraded, true);
  assert.equal(status.manualReplyProbeErrorCode, "dws_manual_reply_temporary");
  assert.equal(status.deferredReplyWaiting, true);
  assert.equal(status.deferredReplyAttemptCount, 2);
  assert.equal(status.deferredReplyErrorCode, "tls_timeout");
  assert.match(status.deferredReplyExpiresAt, /^\d{4}-/u);
});

test("native Gateway distinguishes bounded queue work from a stale check", async (t) => {
  const value = await fixture(t);
  const checkpointPath = join(value.root, "dws.json");
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  const baseline = new Date(checkpoint.lastFullSuccessAt).getTime();
  checkpoint.checkLifecycle = {
    status: "running",
    generation: 3,
    operation: "history_check",
    wakeSource: "fallback",
    startedAt: new Date(baseline).toISOString(),
    completedAt: null,
    errorCount: 0,
  };
  await writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
  await writeFile(join(value.profileDirectory, ".env"), [
    'DWS_PERSONAL_SEND_ENABLED="false"',
    `DWS_PERSONAL_STATE_FILE=${JSON.stringify(checkpointPath)}`,
    'DWS_PERSONAL_FALLBACK_MS="30000"',
    'FOURSDAY_MODE="shadow"',
    "",
  ].join("\n"), { mode: 0o600 });
  const run = async () => ({ stdout: "Gateway is running\n" });
  const bounded = await inspectFoursdayNativeGateway({
    layout: value.layout,
    run,
    now: baseline + 70_000,
  });
  assert.equal(bounded.checkpointState, "busy_but_bounded");
  assert.equal(bounded.checkpointBusy, true);
  assert.equal(bounded.checkpointGeneration, 3);
  assert.equal(bounded.checkpointOperation, "history_check");
  assert.equal(bounded.ready, true);

  const stale = await inspectFoursdayNativeGateway({
    layout: value.layout,
    run,
    now: baseline + 121_000,
  });
  assert.equal(stale.checkpointState, "stale");
  assert.equal(stale.ready, false);
});

test("native Gateway reports an active unknown-send block as not ready", async (t) => {
  const value = await fixture(t);
  const checkpoint = JSON.parse(await readFile(join(value.root, "dws.json"), "utf8"));
  checkpoint.sendBlocked = true;
  await writeFile(join(value.root, "dws.json"), JSON.stringify(checkpoint), { mode: 0o600 });
  await writeFile(join(value.profileDirectory, ".env"), [
    'DWS_PERSONAL_SEND_ENABLED="true"',
    `DWS_PERSONAL_STATE_FILE=${JSON.stringify(join(value.root, "dws.json"))}`,
    'DWS_PERSONAL_FALLBACK_MS="300000"',
    'FOURSDAY_MODE="active"',
    "",
  ].join("\n"), { mode: 0o600 });
  const status = await inspectFoursdayNativeGateway({
    layout: value.layout,
    run: async () => ({ stdout: "Gateway is running\n" }),
    now: Date.now() + 1_000,
  });
  assert.equal(status.mode, "active");
  assert.equal(status.sendBlocked, true);
  assert.equal(status.sendEnabled, false);
  assert.equal(status.modeConsistent, false);
  assert.equal(status.ready, false);
});

test("native Gateway activation preview is zero-write and gated apply is atomic", async (t) => {
  const value = await fixture(t);
  const before = await readFile(join(value.profileDirectory, ".env"), "utf8");
  const preview = await runFoursdayNativeGatewayAction("activate", {
    layout: value.layout,
    ...activationEvidence(),
    run: async (path, args) => nativeRuntimeIdentity(path, args),
  });
  assert.equal(preview.apply, false);
  assert.equal(await readFile(join(value.profileDirectory, ".env"), "utf8"), before);
  await runFoursdayNativeGatewayAction("activate", {
    layout: value.layout,
    apply: true,
    conflictingWriterRunning: async () => false,
    ...activationEvidence(),
    run: async (path, args) =>
      await nativeRuntimeIdentity(path, args) ?? { stdout: "" },
    inspect: async () => ({ ready: true }),
    setServiceEnabled: async () => {},
  });
  const after = await readFile(join(value.profileDirectory, ".env"), "utf8");
  assert.match(after, /DWS_PERSONAL_SEND_ENABLED="true"/u);
  assert.match(after, /FOURSDAY_MODE="active"/u);
});

test("native Gateway refuses active while the previous writer is running", async (t) => {
  const value = await fixture(t);
  const calls = [];
  await assert.rejects(
    runFoursdayNativeGatewayAction("activate", {
      layout: value.layout,
      apply: true,
      conflictingWriterRunning: async () => true,
      ...activationEvidence(),
      run: async (path, args) => {
        calls.push([path, args]);
        return await nativeRuntimeIdentity(path, args) ?? { stdout: "" };
      },
    }),
    /prior writer/u,
  );
  assert.equal(calls.filter(([path]) => path !== "/usr/bin/git").length, 0);
  assert.match(
    await readFile(join(value.profileDirectory, ".env"), "utf8"),
    /FOURSDAY_MODE="shadow"/u,
  );
});

test("native Gateway core cannot activate without exact shadow evidence", async (t) => {
  const value = await fixture(t);
  let calls = 0;
  await assert.rejects(
    runFoursdayNativeGatewayAction("activate", {
      layout: value.layout,
      apply: true,
      conflictingWriterRunning: async () => false,
      run: async () => { calls += 1; return { stdout: "" }; },
    }),
    /shadow acceptance receipt|exact release SHA/u,
  );
  assert.equal(calls, 0);
});

test("native Gateway rejects shadow evidence for a different installed Profile", async (t) => {
  const value = await fixture(t);
  await writeFile(join(value.profileDirectory, "foursday-release.json"), JSON.stringify({
    schema: "foursday-profile-release/v1",
    foursdayVersion: "0.6.0",
    foursdayCommit: "c".repeat(40),
    hermesVersion: "0.20.4",
    hermesCommit: "e".repeat(40),
    hermesRepository: "https://github.com/NousResearch/hermes-agent.git",
  }), { mode: 0o600 });
  await assert.rejects(
    runFoursdayNativeGatewayAction("activate", {
      layout: value.layout,
      ...activationEvidence(),
    }),
    /does not match the accepted release SHA/u,
  );
});

test("native Gateway rejects a Hermes checkout that drifted from the Profile lock", async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    runFoursdayNativeGatewayAction("activate", {
      layout: value.layout,
      ...activationEvidence(),
      run: async (path, args) => {
        if (path === "/usr/bin/git" && args.includes("rev-parse")) {
          return { stdout: `${"d".repeat(40)}\n` };
        }
        if (path === "/usr/bin/git" && args.includes("get-url")) {
          return { stdout: "https://github.com/NousResearch/hermes-agent.git\n" };
        }
        return { stdout: "" };
      },
    }),
    /runtime does not match its immutable Foursday lock/u,
  );
});

test("native Gateway install uses the official service command with send-disabled shadow config", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const enabled = [];
  const result = await runFoursdayNativeGatewayAction("install-shadow", {
    layout: value.layout,
    apply: true,
    run: async (path, args) => { calls.push([path, args]); return { stdout: "" }; },
    setServiceEnabled: async (value) => enabled.push(value),
  });
  assert.equal(result.productionWrite, true);
  assert.deepEqual(calls[0][1], [
    "gateway", "install", "--force", "--no-start-now", "--start-on-login",
  ]);
  assert.deepEqual(enabled, [false]);
});

test("failed active restart stops the process and restores send-disabled shadow", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const enabled = [];
  await assert.rejects(
    runFoursdayNativeGatewayAction("activate", {
      layout: value.layout,
      apply: true,
      conflictingWriterRunning: async () => false,
      ...activationEvidence(),
      run: async (_path, args) => {
        const identity = await nativeRuntimeIdentity(_path, args);
        if (identity) return identity;
        calls.push(args);
        if (args[1] === "restart") throw new Error("restart failed");
        return { stdout: "" };
      },
      setServiceEnabled: async (value) => enabled.push(value),
    }),
    /restart failed/u,
  );
  assert.equal(calls.some((args) => args[1] === "stop"), true);
  assert.match(
    await readFile(join(value.profileDirectory, ".env"), "utf8"),
    /DWS_PERSONAL_SEND_ENABLED="false"/u,
  );
  assert.deepEqual(enabled, [true, false]);
  assert.match(
    await readFile(join(value.profileDirectory, ".env"), "utf8"),
    /FOURSDAY_MODE="shadow"/u,
  );
});

test("shadow start waits for the first healthy DWS checkpoint", async (t) => {
  const value = await fixture(t);
  let inspections = 0;
  const result = await runFoursdayNativeGatewayAction("start-shadow", {
    layout: value.layout,
    apply: true,
    run: async () => ({ stdout: "" }),
    inspect: async () => ({ ready: ++inspections >= 3 }),
    wait: async () => {},
    setServiceEnabled: async () => {},
  });
  assert.equal(result.apply, true);
  assert.equal(inspections, 3);
});

test("stopping native active mode restores persistent shadow and disables launchd", async (t) => {
  const value = await fixture(t);
  const path = join(value.profileDirectory, ".env");
  const active = (await readFile(path, "utf8"))
    .replace('DWS_PERSONAL_SEND_ENABLED="false"', 'DWS_PERSONAL_SEND_ENABLED="true"')
    .replace('FOURSDAY_MODE="shadow"', 'FOURSDAY_MODE="active"');
  await writeFile(path, active, { mode: 0o600 });
  const enabled = [];
  await runFoursdayNativeGatewayAction("stop", {
    layout: value.layout,
    apply: true,
    run: async () => ({ stdout: "" }),
    setServiceEnabled: async (state) => enabled.push(state),
  });
  const environment = await readFile(join(value.profileDirectory, ".env"), "utf8");
  assert.match(environment, /FOURSDAY_MODE="shadow"/u);
  assert.match(environment, /DWS_PERSONAL_SEND_ENABLED="false"/u);
  assert.deepEqual(enabled, [false]);
});

test("profile removal uses official Hermes commands and preserves the native runtime", async (t) => {
  const value = await fixture(t);
  await mkdir(join(value.root, ".local", "bin"), { recursive: true });
  await writeFile(value.layout.hermesCommand, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(value.layout.profileAlias, "#!/bin/sh\n", { mode: 0o700 });
  const calls = [];
  const enabled = [];
  const result = await runFoursdayNativeGatewayAction("remove-profile", {
    layout: value.layout,
    apply: true,
    run: async (path, args) => {
      calls.push([path, args]);
      if (args[0] === "profile" && args[1] === "alias") {
        await rm(value.layout.profileAlias);
      }
      if (args[0] === "profile" && args[1] === "delete") {
        await rm(value.layout.profileDirectory, { recursive: true });
      }
      return { stdout: "" };
    },
    setServiceEnabled: async (value) => enabled.push(value),
    confirmation: "REMOVE-FOURSDAY-PROFILE",
  });
  assert.deepEqual(calls.map(([, args]) => args.slice(0, 2)), [
    ["gateway", "uninstall"],
    ["profile", "alias"],
    ["profile", "alias"],
    ["profile", "delete"],
  ]);
  assert.equal(result.profileRemoved, true);
  assert.equal(result.embeddedRuntimePreserved, true);
  assert.equal(result.productionConfigPreserved, true);
  assert.equal(result.personalGbrainPreserved, true);
  assert.deepEqual(enabled, [false]);
});
