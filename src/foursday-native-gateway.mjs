import { execFile } from "node:child_process";
import {
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { authorizeFoursdayNativeGatewayAction } from "./foursday-native-cutover.mjs";
import { assertFoursdayEmbeddedRuntimeIdentity } from "./foursday-hermes-native-install.mjs";
import { evaluateDwsCheckpointHealth } from "./dws-checkpoint-health.mjs";

const execFileAsync = promisify(execFile);
// The embedded runtime owns this macOS-internal label. Public Foursday status
// deliberately does not expose it, and changing it would require a core fork.
export const nativeFoursdayGatewayLabel = "ai.hermes.gateway-foursday";
export const conflictingFoursdayGatewayLabel = "com.foursday.hermes-gateway";

async function setNativeGatewayServiceEnabled(enabled, { run = execFileAsync } = {}) {
  await run("/bin/launchctl", [
    enabled ? "enable" : "disable",
    `gui/${process.getuid()}/${nativeFoursdayGatewayLabel}`,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  return enabled;
}

async function assertInstalledProfileRelease(profileDirectory, releaseSha) {
  const path = join(profileDirectory, "foursday-release.json");
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 16 ||
    metadata.size > 1024 * 1024
  ) throw new Error("Foursday profile release identity is unsafe");
  let document;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Foursday profile release identity is invalid");
  }
  const installed = document?.schema === "foursday-profile-release/v1"
    ? document.foursdayCommit
    : null;
  if (!installed || installed !== releaseSha) {
    throw new Error("Installed Foursday profile does not match the accepted release SHA");
  }
  if (
    !/^[a-f0-9]{40}$/u.test(String(document.hermesCommit ?? "")) ||
    document.hermesRepository !== "https://github.com/NousResearch/hermes-agent.git"
  ) throw new Error("Installed Foursday profile has an invalid embedded runtime identity");
  return document;
}

async function assertInstalledHermesRuntime(layout, release, run) {
  const result = await assertFoursdayEmbeddedRuntimeIdentity(layout, {
    expectedCommit: release.hermesCommit,
    expectedRepository: release.hermesRepository,
    run,
  });
  return result.commit;
}

function parseEnv(text) {
  const output = new Map();
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) throw new Error("Foursday profile environment is invalid");
    const key = line.slice(0, index);
    const raw = line.slice(index + 1);
    let value = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error("Foursday profile environment contains invalid quoting");
      }
    }
    output.set(key, String(value));
  }
  return output;
}

function serializeEnv(values) {
  return `${[...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n")}\n`;
}

async function privateEnv(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Foursday profile environment must be a private regular file");
  }
  return { metadata, values: parseEnv(await readFile(path, "utf8")) };
}

async function setFoursdayGatewayMode(profileDirectory, mode, {
  apply = false,
} = {}) {
  if (!new Set(["shadow", "active"]).has(mode)) {
    throw new Error("Foursday native Gateway mode is invalid");
  }
  const path = join(profileDirectory, ".env");
  const { values } = await privateEnv(path);
  values.set("FOURSDAY_MODE", mode);
  values.set("DWS_PERSONAL_SEND_ENABLED", mode === "active" ? "true" : "false");
  const content = serializeEnv(values);
  if (!apply) {
    return {
      mode,
      sendEnabled: mode === "active",
      apply: false,
      path,
      productionWrite: false,
    };
  }
  const temporary = `${path}.mode-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return {
    mode,
    sendEnabled: mode === "active",
    apply: true,
    path,
    productionWrite: true,
  };
}

function nativeEnvironment(layout) {
  return {
    HOME: layout.userHome,
    HERMES_HOME: layout.profileDirectory,
    PATH: `${join(layout.userHome, ".local", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
  };
}

export async function inspectFoursdayNativeGateway({
  layout,
  run = execFileAsync,
  now = Date.now(),
  uid = process.getuid?.(),
} = {}) {
  const envDocument = await privateEnv(join(layout.profileDirectory, ".env"));
  const mode = envDocument.values.get("FOURSDAY_MODE") ?? "unknown";
  const configuredSendEnabled = envDocument.values.get("DWS_PERSONAL_SEND_ENABLED") === "true";
  const enterpriseUsersEnabled =
    envDocument.values.get("DWS_PERSONAL_ENTERPRISE_USERS_ENABLED") === "true";
  let stdout = "";
  let running = false;
  let serviceEnabled = null;
  try {
    ({ stdout } = await run(layout.profileAlias, ["gateway", "status"], {
      cwd: layout.profileDirectory,
      env: nativeEnvironment(layout),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }));
    running = /(?:gateway is running|state\s*[:=]\s*running|supervised by launchd\s*\(PID\s+\d+\))/iu
      .test(String(stdout));
  } catch {
    running = false;
  }
  try {
    const { stdout: disabled } = await run("/bin/launchctl", [
      "print-disabled", `gui/${uid}`,
    ], { timeout: 10_000, maxBuffer: 512 * 1024 });
    const escaped = nativeFoursdayGatewayLabel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    serviceEnabled = !new RegExp(`"${escaped}"\\s*=>\\s*disabled`, "u")
      .test(String(disabled));
  } catch {
    serviceEnabled = null;
  }
  const checkpointPath = envDocument.values.get("DWS_PERSONAL_STATE_FILE") ?? "";
  const fallbackMs = Number(envDocument.values.get("DWS_PERSONAL_FALLBACK_MS") ?? 300_000);
  let checkpointHealthy = false;
  let checkpointState = "stale";
  let checkpointBusy = false;
  let checkpointGeneration = 0;
  let checkpointOperation = null;
  let manualReplyProbeReady = null;
  let manualReplyProbeDegraded = false;
  let manualReplyProbeErrorCode = null;
  let deferredReplyWaiting = false;
  let deferredReplyAttemptCount = 0;
  let deferredReplyErrorCode = null;
  let deferredReplyExpiresAt = null;
  let eventWakeEnabled = false;
  let eventWakeReady = false;
  let eventWakeDegraded = false;
  let lastWakeSource = null;
  let lastDetectionLatencyMs = null;
  let sendBlocked = false;
  if (checkpointPath) {
    try {
      const metadata = await lstat(checkpointPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw new Error("unsafe checkpoint");
      }
      const state = JSON.parse(await readFile(checkpointPath, "utf8"));
      sendBlocked = state.sendBlocked === true;
      eventWakeEnabled = state.eventWake?.enabled === true;
      eventWakeReady = state.eventWake?.ready === true;
      eventWakeDegraded = eventWakeEnabled && !eventWakeReady;
      lastWakeSource = typeof state.lastWakeSource === "string"
        ? state.lastWakeSource.slice(0, 40)
        : null;
      lastDetectionLatencyMs = Number.isFinite(Number(state.lastDetection?.latencyMs))
        ? Math.max(0, Number(state.lastDetection.latencyMs))
        : null;
      manualReplyProbeReady = typeof state.manualReplyProbe?.ready === "boolean"
        ? state.manualReplyProbe.ready
        : null;
      manualReplyProbeDegraded = manualReplyProbeReady === false;
      manualReplyProbeErrorCode = typeof state.manualReplyProbe?.errorCode === "string"
        ? state.manualReplyProbe.errorCode.slice(0, 80)
        : null;
      deferredReplyWaiting = state.deferredReply?.waiting === true;
      deferredReplyAttemptCount = Number.isSafeInteger(state.deferredReply?.attemptCount) &&
          state.deferredReply.attemptCount >= 0
        ? state.deferredReply.attemptCount
        : 0;
      deferredReplyErrorCode = typeof state.deferredReply?.errorCode === "string"
        ? state.deferredReply.errorCode.slice(0, 80)
        : null;
      deferredReplyExpiresAt = typeof state.deferredReply?.expiresAt === "string"
        ? state.deferredReply.expiresAt
        : null;
      ({
        checkpointHealthy,
        checkpointState,
        checkpointBusy,
        checkpointGeneration,
        checkpointOperation,
      } =
        evaluateDwsCheckpointHealth({
          state,
          now,
          fallbackMs,
          modifiedAt: metadata.mtimeMs,
        }));
    } catch {
      checkpointHealthy = false;
      checkpointState = "failed";
      checkpointBusy = false;
      checkpointGeneration = 0;
      checkpointOperation = null;
    }
  }
  const sendEnabled = configuredSendEnabled && !sendBlocked;
  const modeConsistent =
    (mode === "shadow" && !configuredSendEnabled) ||
    (mode === "active" && configuredSendEnabled && !sendBlocked);
  const safeStopped = !running && serviceEnabled === false && mode === "shadow" && !configuredSendEnabled;
  return {
    schema: "foursday-native-gateway-status/v1",
    label: nativeFoursdayGatewayLabel,
    runtime: "foursday_profile",
    installed: true,
    profile: "foursday",
    mode,
    accessPolicy: enterpriseUsersEnabled ? "enterprise" : "explicit_users",
    enterpriseUsersEnabled,
    sendEnabled,
    sendBlocked,
    running,
    serviceEnabled,
    checkpointHealthy,
    checkpointState,
    checkpointBusy,
    checkpointGeneration,
    checkpointOperation,
    manualReplyProbeReady,
    manualReplyProbeDegraded,
    manualReplyProbeErrorCode,
    deferredReplyWaiting,
    deferredReplyAttemptCount,
    deferredReplyErrorCode,
    deferredReplyExpiresAt,
    eventWakeEnabled,
    eventWakeReady,
    eventWakeDegraded,
    lastWakeSource,
    lastDetectionLatencyMs,
    modeConsistent,
    safeStopped,
    ready: running && modeConsistent && checkpointHealthy,
  };
}

export async function conflictingGatewayRunning({
  uid = process.getuid?.(),
  run = execFileAsync,
} = {}) {
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("macOS user id is invalid");
  try {
    const { stdout } = await run("/bin/launchctl", [
      "print", `gui/${uid}/${conflictingFoursdayGatewayLabel}`,
    ], { timeout: 10_000, maxBuffer: 512 * 1024 });
    return /state\s*=\s*running/u.test(String(stdout));
  } catch {
    return false;
  }
}

export async function runFoursdayNativeGatewayAction(action, {
  layout,
  apply = false,
  run = execFileAsync,
  conflictingWriterRunning = conflictingGatewayRunning,
  inspect = inspectFoursdayNativeGateway,
  setServiceEnabled = (enabled) => setNativeGatewayServiceEnabled(enabled, { run }),
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  releaseSha = null,
  acceptance = null,
  confirmation = null,
  now = new Date(),
} = {}) {
  const allowed = new Set([
    "install-shadow", "start-shadow", "activate", "stop", "restart", "uninstall",
    "remove-profile",
  ]);
  if (!allowed.has(action)) throw new Error("Foursday native Gateway action is invalid");
  const gate = authorizeFoursdayNativeGatewayAction(action, {
    apply,
    releaseSha,
    acceptance,
    confirmation,
    now,
  });
  const profileRelease = action === "activate"
    ? await assertInstalledProfileRelease(layout.profileDirectory, gate.releaseSha)
    : null;
  const embeddedRuntimeSha = profileRelease
    ? await assertInstalledHermesRuntime(layout, profileRelease, run)
    : null;
  const plan = {
    schema: "foursday-native-gateway-action/v1",
    action,
    label: nativeFoursdayGatewayLabel,
    profile: "foursday",
    productionWrite: false,
    messagesSent: 0,
    gate,
    ...(profileRelease ? { profileReleaseSha: profileRelease.foursdayCommit } : {}),
    ...(embeddedRuntimeSha ? { embeddedRuntimeSha } : {}),
  };
  if (!apply) return { ...plan, apply: false };
  const env = nativeEnvironment(layout);
  if (action === "install-shadow") {
    await setFoursdayGatewayMode(layout.profileDirectory, "shadow", { apply: true });
    await run(layout.profileAlias, [
      "gateway", "install", "--force", "--no-start-now", "--start-on-login",
    ], { cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    await setServiceEnabled(false);
  } else if (action === "start-shadow") {
    await setFoursdayGatewayMode(layout.profileDirectory, "shadow", { apply: true });
    await setServiceEnabled(true);
    await run(layout.profileAlias, ["gateway", "restart"], {
      cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
  } else if (action === "activate") {
    if (await conflictingWriterRunning()) {
      throw new Error("Foursday native Gateway cannot become active while the prior writer is running");
    }
    await setFoursdayGatewayMode(layout.profileDirectory, "active", { apply: true });
    try {
      await setServiceEnabled(true);
      await run(layout.profileAlias, ["gateway", "restart"], {
        cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      await run(layout.profileAlias, ["gateway", "stop"], {
        cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      }).catch(() => {});
      await setFoursdayGatewayMode(layout.profileDirectory, "shadow", { apply: true });
      await setServiceEnabled(false).catch(() => {});
      await run(layout.profileAlias, [
        "gateway", "install", "--force", "--no-start-now", "--start-on-login",
      ], {
        cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      }).catch(() => {});
      throw error;
    }
  } else if (action === "stop") {
    await run(layout.profileAlias, ["gateway", "stop"], {
      cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    await setFoursdayGatewayMode(layout.profileDirectory, "shadow", { apply: true });
    await setServiceEnabled(false);
  } else if (action === "restart") {
    await setServiceEnabled(true);
    await run(layout.profileAlias, ["gateway", "restart"], {
      cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
  } else if (action === "uninstall") {
    await run(layout.profileAlias, ["gateway", "uninstall"], {
      cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    await setServiceEnabled(false);
  } else if (action === "remove-profile") {
    await run(layout.profileAlias, ["gateway", "uninstall"], {
      cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    await setServiceEnabled(false);
    await run(layout.hermesCommand, [
      "profile", "alias", "foursday", "--remove", "--name", "foursday-runtime",
    ], { cwd: layout.userHome, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    await run(layout.hermesCommand, [
      "profile", "alias", "foursday", "--remove", "--name", "hermes-foursday",
    ], { cwd: layout.userHome, env, timeout: 30_000, maxBuffer: 1024 * 1024 }).catch(() => {});
    await run(layout.hermesCommand, ["profile", "delete", "foursday", "--yes"], {
      cwd: layout.userHome, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    const [profile, alias] = await Promise.all([
      lstat(layout.profileDirectory).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
      lstat(layout.profileAlias).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    ]);
    if (profile || alias) throw new Error("Foursday native profile uninstall read-back failed");
  }
  if (["start-shadow", "activate", "restart"].includes(action)) {
    let status = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      status = await inspect({ layout, run });
      if (status.ready) break;
      await wait(1_000);
    }
    if (!status.ready) {
      if (action === "activate") {
        await run(layout.profileAlias, ["gateway", "stop"], {
          cwd: layout.profileDirectory, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
        }).catch(() => {});
        await setFoursdayGatewayMode(layout.profileDirectory, "shadow", { apply: true });
        await setServiceEnabled(false).catch(() => {});
      }
      throw new Error("Foursday native Gateway did not pass post-action read-back");
    }
  }
  return {
    ...plan,
    apply: true,
    productionWrite: true,
    ...(action === "remove-profile" ? {
      profileRemoved: true,
      embeddedRuntimePreserved: true,
      productionConfigPreserved: true,
      personalGbrainPreserved: true,
    } : {}),
  };
}
