#!/usr/bin/env node
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DwsAdapter } from "../src/dws.mjs";
import { createSidecarRuntime } from "../src/hermes-dws-sidecar.mjs";

function envFile(content) {
  return new Map(String(content).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Foursday Profile environment is invalid");
    let value = line.slice(separator + 1);
    try { value = JSON.parse(value); } catch {}
    return [line.slice(0, separator), String(value)];
  }));
}

function identifiers(value) {
  return [...new Set(String(value ?? "").split(/[\s,;]+/u).map((item) => item.trim()).filter(Boolean))];
}

const profile = join(homedir(), ".hermes", "profiles", "foursday");
const values = envFile(await readFile(join(profile, ".env"), "utf8"));
if (values.get("FOURSDAY_MODE") !== "shadow" || values.get("DWS_PERSONAL_SEND_ENABLED") !== "false") {
  throw new Error("Enterprise Sidecar diagnosis requires Shadow with sending disabled");
}
const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-enterprise-diagnostic-")));
const stateFile = join(root, "dws.json");
const diagnostics = [];
const failureTrace = [];
let runtime = null;
try {
  await copyFile(values.get("DWS_PERSONAL_STATE_FILE"), stateFile);
  await mkdir(join(root, "media"), { mode: 0o700 });
  const dws = new DwsAdapter({
    dwsPath: values.get("DWS_PATH"),
    environment: {
      HOME: values.get("FOURSDAY_DWS_HOME") || homedir(),
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      DWS_PERSONAL_COMMAND_LOCK: join(root, "dws-command.lock"),
    },
  });
  const runDws = dws.run.bind(dws);
  dws.run = async (args, options) => {
    try {
      return await runDws(args, options);
    } catch (error) {
      const marker = `${String(error?.stderr ?? "")} ${String(error?.message ?? "")}`;
      failureTrace.push({
        stage: `dws:${args.slice(0, 3).join(":")}`,
        code: String(error?.code ?? error?.name ?? "error").slice(0, 80),
        signals: {
          authentication: /auth|unauthorized|forbidden/iu.test(marker),
          ciphertextMismatch: /ciphertext_key_mismatch/iu.test(marker),
          timeout: /timeout|timed out|ETIMEDOUT/iu.test(marker),
          unknownCommand: /unknown command|unknown flag/iu.test(marker),
        },
        frames: [],
      });
      throw error;
    }
  };
  const fetchEnterpriseDirectScan = dws.fetchEnterpriseDirectScan.bind(dws);
  dws.fetchEnterpriseDirectScan = async (input) => {
    try {
      return await fetchEnterpriseDirectScan(input);
    } catch (error) {
      failureTrace.push({
        stage: "fetchEnterpriseDirectScan",
        code: String(error?.code ?? error?.name ?? "error").slice(0, 80),
        frames: String(error?.stack ?? "").split(/\r?\n/u).slice(1, 8)
          .map((line) => line.trim().replace(homedir(), "<home>"))
          .filter((line) => /^at\s/u.test(line)),
      });
      throw error;
    }
  };
  for (const stage of [
    "verifyEnterpriseMessage",
    "verifyEnterpriseUser",
    "resolveEnterpriseOpenDingTalkId",
    "enrichMessageResources",
  ]) {
    const operation = dws[stage]?.bind(dws);
    if (!operation) continue;
    dws[stage] = async (...input) => {
      try {
        return await operation(...input);
      } catch (error) {
        failureTrace.push({
          stage,
          code: String(error?.code ?? error?.name ?? "error").slice(0, 80),
          frames: String(error?.stack ?? "").split(/\r?\n/u).slice(1, 8)
            .map((line) => line.trim().replace(homedir(), "<home>"))
            .filter((line) => /^at\s/u.test(line)),
        });
        throw error;
      }
    };
  }
  const initialLookbackMs = Number(values.get("DWS_PERSONAL_INITIAL_LOOKBACK_MS") || 600_000);
  runtime = await createSidecarRuntime({
    config: {
      dwsPath: values.get("DWS_PATH"),
      dingtalkRoot: "",
      userIds: identifiers(values.get("DWS_PERSONAL_FETCH_USERS")),
      groupIds: identifiers(values.get("DWS_PERSONAL_ALLOWED_GROUPS")),
      enterpriseUsersEnabled: values.get("DWS_PERSONAL_ENTERPRISE_USERS_ENABLED") === "true",
      selfUserId: values.get("DINGTALK_SELF_USER_ID") || null,
      stateFile,
      mediaRoot: join(root, "media"),
      controlFile: null,
      initialLookbackMs,
      fallbackMs: 60 * 60 * 1_000,
      historySettleMs: Number(values.get("DWS_PERSONAL_HISTORY_SETTLE_MS") || 120_000),
      eventWakeEnabled: false,
      outboundQuietMs: Number(values.get("DWS_PERSONAL_OUTBOUND_QUIET_MS") || 8_000),
      outboundMaxQuietMs: Number(values.get("DWS_PERSONAL_OUTBOUND_MAX_QUIET_MS") || 20_000),
      sendEnabled: false,
    },
    dws,
    emit: () => {},
    diagnose: (code) => diagnostics.push(String(code).slice(0, 200)),
  });
  let errorCode = null;
  try {
    await runtime.check({
      deferEmit: true,
      wakeSource: "diagnostic",
      reconcileLookbackMs: initialLookbackMs,
    });
  } catch (error) {
    errorCode = String(error?.code ?? error?.name ?? "error").slice(0, 80);
  }
  await runtime.stop();
  runtime = null;
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  console.log(JSON.stringify({
    success: errorCode == null,
    errorCode,
    diagnostics,
    failureTrace,
    lastErrorCount: Number(state.lastErrorCount ?? 0),
    lifecycleStatus: state.checkLifecycle?.status ?? null,
    lifecycleOperation: state.checkLifecycle?.operation ?? null,
    enterpriseCheckpointAdvanced: typeof state.lastEnterpriseAt === "string",
    messagesSent: 0,
    productionStateWritten: false,
  }, null, 2));
} finally {
  await runtime?.stop().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
