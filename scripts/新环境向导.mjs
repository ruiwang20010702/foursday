#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  foursdayNativeHermesLayout,
  inspectFoursdaySourceCommit,
  runFoursdayNativeHermesInstall,
} from "../src/foursday-hermes-native-install.mjs";
import { validateHermesUpstreamLock } from "../src/hermes-upstream.mjs";
import { runFoursdayCodexLogin } from "../src/foursday-codex-auth.mjs";
import { runFoursdayCodexShadow } from "../src/foursday-codex-shadow.mjs";
import { runFoursdayControlMcp } from "../src/foursday-control-mcp.mjs";
import { runFoursdayControlSite } from "../src/foursday-control-site.mjs";
import { defaultProductionConfigPath } from "../src/production-config-file.mjs";
import { isMainModule } from "../src/main-module.mjs";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export const foursdayHelp = Object.freeze({
  usage: [
    "foursday install [--apply]",
    "foursday configure [--apply] [--replace] [--cron] --registry /absolute/private/projects.json",
    "foursday login [--apply]",
    "foursday verify [--apply]",
    "foursday accept --release-sha SHA --ledger FILE --restart-evidence FILE --code-evidence FILE --output FILE [--apply]",
    "foursday gateway <status|install-shadow|start-shadow|activate|stop|restart|uninstall|remove-profile> [options]",
    "foursday status",
    "foursday control <status|tasks|schedules|memory|evidence|ACTION> [options]",
    "foursday control-mcp",
    "foursday dashboard [--port PORT]",
  ],
  architecture: "Foursday Gateway + Codex work loop + personal memory",
  defaultSafety: "install and configure preview changes; Gateway starts send-disabled; activation requires exact shadow evidence",
});

async function install({ apply }) {
  const [lock, packageDocument, foursdayCommit] = await Promise.all([
    readFile(new URL("../distribution/upstream.lock.json", import.meta.url), "utf8")
      .then(JSON.parse)
      .then(validateHermesUpstreamLock),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    inspectFoursdaySourceCommit(packageRoot),
  ]);
  return runFoursdayNativeHermesInstall({
    apply,
    installGateway: false,
    profileOnly: false,
    lock,
    layout: foursdayNativeHermesLayout({ projectRoot: packageRoot }),
    foursdayVersion: packageDocument.version,
    foursdayCommit,
  });
}

export function publicFoursdayStatus(status) {
  if (status?.schema !== "foursday-native-gateway-status/v1") return status;
  const {
    label: _label,
    runtime: _runtime,
    profile: _profile,
    ...publicStatus
  } = status;
  return {
    ...publicStatus,
    schema: "foursday-status/v1",
    product: "Foursday",
    controlPlane: "embedded",
  };
}

export function publicFoursdayInstall(result) {
  return {
    schema: "foursday-install/v1",
    apply: result.apply === true,
    installed: result.installed === true,
    profile: "foursday",
    runtimeVersion: result.upstream?.version ?? null,
    pinnedRuntimeVerified: Boolean(result.upstream?.commit && result.upstream?.installerSha256),
    components: [
      "dws-personal-dingtalk",
      "project-router",
      "personal-gbrain",
      "codex-policy-bridge",
      "foursday-mcp",
      "session-gateway",
    ],
    optionalDependenciesPruned: result.optionalNodeDependenciesPruned === true,
    gatewayStarted: result.gatewayStarted === true,
    messagesSent: Number(result.messagesSent ?? 0),
    productionWrite: result.productionWrite === true,
  };
}

async function runBundledScript(script, args, { transform = (value) => value } = {}) {
  const options = {
    cwd: packageRoot,
    env: process.env,
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  };
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      fileURLToPath(new URL(script, import.meta.url)),
      ...args,
    ], options);
    return stdout.trim() ? transform(JSON.parse(stdout)) : null;
  } catch (error) {
    const stdout = String(error?.stdout ?? "").trim();
    if (stdout) {
      try { error.stdout = `${JSON.stringify(transform(JSON.parse(stdout)), null, 2)}\n`; } catch {}
    }
    throw error;
  }
}

export async function runFoursdayCli(args = process.argv.slice(2), {
  codexLogin = runFoursdayCodexLogin,
  codexShadow = runFoursdayCodexShadow,
  controlMcp = runFoursdayControlMcp,
  controlSite = runFoursdayControlSite,
} = {}) {
  const [command = "help", ...rest] = args;
  if (["help", "--help", "-h"].includes(command)) return foursdayHelp;
  if (command === "install") {
    if (rest.some((value) => value !== "--apply")) {
      throw new Error("Usage: foursday install [--apply]");
    }
    return publicFoursdayInstall(await install({ apply: rest.includes("--apply") }));
  }
  if (command === "configure") {
    return runBundledScript("./配置Foursday运行时.mjs", rest);
  }
  if (command === "login") {
    if (rest.some((value) => value !== "--apply")) {
      throw new Error("Usage: foursday login [--apply]");
    }
    return codexLogin({
      layout: foursdayNativeHermesLayout({ projectRoot: packageRoot }),
      configPath: process.env.FOURSDAY_CONFIG_FILE ?? defaultProductionConfigPath(),
      apply: rest.includes("--apply"),
    });
  }
  if (command === "verify") {
    if (rest.some((value) => value !== "--apply")) {
      throw new Error("Usage: foursday verify [--apply]");
    }
    return codexShadow({
      layout: foursdayNativeHermesLayout({ projectRoot: packageRoot }),
      configPath: process.env.FOURSDAY_CONFIG_FILE ?? defaultProductionConfigPath(),
      apply: rest.includes("--apply"),
    });
  }
  if (command === "accept") {
    return runBundledScript("./生成Foursday影子验收.mjs", rest);
  }
  if (command === "control") {
    return runBundledScript("./控制Foursday.mjs", rest);
  }
  if (command === "control-mcp") {
    if (rest.length > 0) throw new Error("Usage: foursday control-mcp");
    await controlMcp({ projectRoot: packageRoot });
    return null;
  }
  if (command === "dashboard") {
    if (rest.length > 2 || (rest.length > 0 && rest[0] !== "--port")) {
      throw new Error("Usage: foursday dashboard [--port PORT]");
    }
    const port = rest.length === 2 ? Number(rest[1]) : 9466;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      throw new Error("Dashboard port is invalid");
    }
    return controlSite({ projectRoot: packageRoot, port });
  }
  if (command === "gateway") {
    return runBundledScript("./管理FoursdayGateway.mjs", rest, {
      transform: rest[0] === "status" ? publicFoursdayStatus : undefined,
    });
  }
  if (command === "status") {
    if (rest.length > 0) throw new Error("Usage: foursday status");
    return runBundledScript("./管理FoursdayGateway.mjs", ["status"], {
      transform: publicFoursdayStatus,
    });
  }
  throw new Error(`Unknown command: ${command}`);
}

if (isMainModule(import.meta.url)) {
  try {
    const result = await runFoursdayCli();
    if (result != null) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error?.stdout) {
      const output = String(error.stdout).trim();
      try {
        console.log(JSON.stringify(JSON.parse(output), null, 2));
        process.exitCode = Number(error.code) || 1;
      } catch {
        throw error;
      }
    } else {
      throw error;
    }
  }
}
