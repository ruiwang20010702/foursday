#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { foursdayNativeHermesLayout } from "../src/foursday-hermes-native-install.mjs";
import {
  configureFoursdayNativeProfile,
  ensureFoursdayMemoryPromoterCron,
} from "../src/foursday-native-profile-config.mjs";
import { defaultProductionConfigPath } from "../src/production-config-file.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const registryIndex = args.indexOf("--registry");
if (args.some((argument, index) =>
  !["--apply", "--replace", "--cron", "--registry"].includes(argument) &&
  index !== registryIndex + 1)) {
  throw new Error("Usage: 配置Foursday运行时.mjs [--apply] [--replace] [--cron] [--registry /absolute/path.json]");
}
if (args.includes("--replace") && !args.includes("--apply")) {
  throw new Error("--replace requires --apply");
}
const layout = foursdayNativeHermesLayout({ projectRoot });
const releaseDocument = JSON.parse(await readFile(join(
  layout.profileDirectory,
  "foursday-release.json",
), "utf8"));
const releaseSha = String(releaseDocument.foursdayCommit ?? "");
const productionConfigPath = process.env.FOURSDAY_CONFIG_FILE ?? defaultProductionConfigPath();
const productionValues = JSON.parse(await readFile(productionConfigPath, "utf8"));
const rawDwsPath = String(productionValues.FOURSDAY_DWS_PATH ?? "dws");
const rawCodexPath = String(productionValues.FOURSDAY_CODEX_PATH ?? "codex");
const execFileAsync = promisify(execFile);
const dwsPath = isAbsolute(rawDwsPath)
  ? await realpath(rawDwsPath)
  : String((await execFileAsync("/usr/bin/which", [rawDwsPath], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
    })).stdout).trim();
const codexPath = isAbsolute(rawCodexPath)
  ? await realpath(rawCodexPath)
  : String((await execFileAsync("/usr/bin/which", [rawCodexPath], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
    })).stdout).trim();
const projectRegistryPath = registryIndex === -1
  ? process.env.FOURSDAY_PROJECT_REGISTRY ?? null
  : args[registryIndex + 1];
if (args.includes("--apply") && !projectRegistryPath) {
  throw new Error("--apply requires --registry or FOURSDAY_PROJECT_REGISTRY");
}
const result = await configureFoursdayNativeProfile({
  layout,
  productionConfigPath,
  projectRegistryPath: projectRegistryPath ?? fileURLToPath(
    new URL("../distribution/projects.example.json", import.meta.url),
  ),
  nodePath: join(layout.hermesHome, "node", "bin", "node"),
  dwsPath,
  codexPath,
  releaseSha,
  apply: args.includes("--apply"),
  replace: args.includes("--replace"),
});
const cron = args.includes("--cron")
  ? await ensureFoursdayMemoryPromoterCron({
      layout,
      apply: args.includes("--apply"),
    })
  : null;
console.log(JSON.stringify({
  schema: result.schema,
  apply: result.apply,
  changed: result.changed,
  backupsCreated: result.backupsCreated ?? 0,
  mode: result.mode,
  sendEnabled: result.sendEnabled,
  secretsCopied: result.secretsCopied,
  environmentKeyCount: Object.keys(result.environment ?? {}).length,
  profileConfigured: true,
  cron,
}, null, 2));
