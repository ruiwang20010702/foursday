import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSecretReference,
  resolveSecretReference,
  secretConfigKeys,
} from "./secret-provider.mjs";

export const productionConfigKeys = new Set([
  "FOURSDAY_DATABASE_URL",
  "FOURSDAY_DATABASE_SSL",
  "FOURSDAY_DATABASE_POOL_MAX",
  "FOURSDAY_DATA_KEY",
  "FOURSDAY_TENANT_ID",
  "FOURSDAY_DWS_PATH",
  "FOURSDAY_CODEX_PATH",
  "FOURSDAY_DINGTALK_USERS",
  "FOURSDAY_DINGTALK_GROUPS",
  "FOURSDAY_DINGTALK_SELF_USER",
  "FOURSDAY_DINGTALK_FALLBACK_MS",
  "FOURSDAY_DINGTALK_HISTORY_SETTLE_MS",
  "FOURSDAY_DINGTALK_QUIET_MS",
  "FOURSDAY_DINGTALK_MAX_WAIT_MS",
  "FOURSDAY_DINGTALK_EVENT_WAKE_ENABLED",
  "FOURSDAY_DINGTALK_OUTBOUND_QUIET_MS",
  "FOURSDAY_DINGTALK_OUTBOUND_MAX_QUIET_MS",
  "FOURSDAY_GBRAIN_ENABLED",
  "FOURSDAY_GBRAIN_MCP_URL",
  "FOURSDAY_GBRAIN_ISSUER_URL",
  "FOURSDAY_GBRAIN_CLIENT_ID",
  "FOURSDAY_GBRAIN_CLIENT_SECRET",
  "FOURSDAY_GBRAIN_TIMEOUT_MS",
  "FOURSDAY_GBRAIN_MAX_RESULTS",
  "FOURSDAY_GBRAIN_WRITE_ENABLED",
  "FOURSDAY_GBRAIN_GIT_REMOTE",
  "FOURSDAY_GBRAIN_GIT_BRANCH",
  "FOURSDAY_GBRAIN_WRITER_ROOT",
  "FOURSDAY_GBRAIN_PATH",
  "FOURSDAY_GH_PATH",
]);

export function defaultProductionConfigPath() {
  return fileURLToPath(
    new URL("../.runtime/production.json", import.meta.url),
  );
}

export async function applyProductionConfigFile({
  path = process.env.FOURSDAY_CONFIG_FILE ??
    defaultProductionConfigPath(),
  environment = process.env,
  secretResolverOptions = {},
  resolveSecrets = true,
} = {}) {
  const configPath = resolve(path);
  const metadata = await stat(configPath);
  if (!metadata.isFile()) {
    throw new Error("Production config must be a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Production config must not be readable by group or others");
  }
  const values = JSON.parse(await readFile(configPath, "utf8"));
  if (!values || Array.isArray(values) || typeof values !== "object") {
    throw new Error("Production config must be a JSON object");
  }
  const sourceEnvironment = { ...environment };
  const stagedEnvironment = {};
  const resolvedSecretKeys = [];
  for (const [key, value] of Object.entries(values)) {
    if (!productionConfigKeys.has(key)) {
      throw new Error(`Unsupported config key: ${key}`);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Config value must be scalar: ${key}`);
    }
    if (isSecretReference(value) && !secretConfigKeys.has(key)) {
      throw new Error(`Secret references are not allowed for config key: ${key}`);
    }
    if (
      secretConfigKeys.has(key) &&
      resolveSecrets &&
      !isSecretReference(value)
    ) {
      throw new Error(`Production secret must use an external reference: ${key}`);
    }
    if (secretConfigKeys.has(key) && resolveSecrets) {
      const resolved = await resolveSecretReference(String(value), {
        environment: sourceEnvironment,
        ...secretResolverOptions,
      });
      stagedEnvironment[key] = resolved.value;
      if (resolved.source !== "inline") resolvedSecretKeys.push(key);
    } else {
      stagedEnvironment[key] = String(value);
    }
  }
  Object.assign(environment, stagedEnvironment);
  return { configPath, values, resolvedSecretKeys };
}
