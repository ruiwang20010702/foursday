import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function boolean(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function positiveInteger(name, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function commaSeparated(name) {
  return [...new Set(String(process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean))];
}

function required(name, { production }) {
  const value = process.env[name]?.trim() || null;
  if (production && !value) throw new Error(`${name} is required in production mode`);
  return value;
}

function credentialFreeHttps(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return url;
}

export function loadConfig({ production = false } = {}) {
  const databaseUrl = required("FOURSDAY_DATABASE_URL", { production });
  const dataKey = required("FOURSDAY_DATA_KEY", { production });
  const tenantId = required("FOURSDAY_TENANT_ID", { production });
  if (databaseUrl) {
    let url;
    try {
      url = new URL(databaseUrl);
    } catch {
      throw new Error("FOURSDAY_DATABASE_URL is invalid");
    }
    if (!/^postgres(?:ql)?:$/u.test(url.protocol)) {
      throw new Error("FOURSDAY_DATABASE_URL must be PostgreSQL");
    }
  }
  if (tenantId && !/^[A-Za-z0-9._:-]{1,200}$/u.test(tenantId)) {
    throw new Error("FOURSDAY_TENANT_ID is invalid");
  }

  const personalMemoryEnabled = boolean("FOURSDAY_GBRAIN_ENABLED", false);
  const personalMemoryMcpUrl = process.env.FOURSDAY_GBRAIN_MCP_URL?.trim() || null;
  const personalMemoryIssuerUrl = process.env.FOURSDAY_GBRAIN_ISSUER_URL?.trim() || null;
  const personalMemoryClientId = process.env.FOURSDAY_GBRAIN_CLIENT_ID?.trim() || null;
  const personalMemoryClientSecret = process.env.FOURSDAY_GBRAIN_CLIENT_SECRET?.trim() || null;
  const personalMemoryTimeoutMs = positiveInteger(
    "FOURSDAY_GBRAIN_TIMEOUT_MS", 10_000, { minimum: 1_000, maximum: 60_000 },
  );
  const personalMemoryMaxResults = positiveInteger(
    "FOURSDAY_GBRAIN_MAX_RESULTS", 8, { maximum: 10 },
  );
  const personalMemoryWriteEnabled = boolean("FOURSDAY_GBRAIN_WRITE_ENABLED", false);
  const personalMemoryGitRemote = process.env.FOURSDAY_GBRAIN_GIT_REMOTE?.trim() || null;
  const personalMemoryGitBranch = process.env.FOURSDAY_GBRAIN_GIT_BRANCH?.trim() || "main";
  const personalMemoryWriterRoot = process.env.FOURSDAY_GBRAIN_WRITER_ROOT?.trim() || null;
  const personalMemoryGbrainPath = process.env.FOURSDAY_GBRAIN_PATH?.trim() || null;

  if (personalMemoryEnabled) {
    if (!personalMemoryMcpUrl || !personalMemoryIssuerUrl || !personalMemoryClientId || !personalMemoryClientSecret) {
      throw new Error("Personal gbrain requires MCP URL, issuer, client id and client secret");
    }
    const mcp = credentialFreeHttps(personalMemoryMcpUrl, "FOURSDAY_GBRAIN_MCP_URL");
    const issuer = credentialFreeHttps(personalMemoryIssuerUrl, "FOURSDAY_GBRAIN_ISSUER_URL");
    if (mcp.origin !== issuer.origin) {
      throw new Error("Personal gbrain MCP and issuer must share one HTTPS origin");
    }
    if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(personalMemoryClientId)) {
      throw new Error("FOURSDAY_GBRAIN_CLIENT_ID is invalid");
    }
    if (personalMemoryClientSecret.length < 24) {
      throw new Error("FOURSDAY_GBRAIN_CLIENT_SECRET is invalid");
    }
  }
  if (personalMemoryWriteEnabled) {
    if (!personalMemoryEnabled) throw new Error("gbrain writes require gbrain reads");
    const remote = credentialFreeHttps(personalMemoryGitRemote, "FOURSDAY_GBRAIN_GIT_REMOTE");
    if (remote.hostname !== "github.com") {
      throw new Error("FOURSDAY_GBRAIN_GIT_REMOTE must use GitHub");
    }
    if (!/^[A-Za-z0-9._/-]{1,120}$/u.test(personalMemoryGitBranch) || personalMemoryGitBranch.includes("..")) {
      throw new Error("FOURSDAY_GBRAIN_GIT_BRANCH is invalid");
    }
    if (!personalMemoryWriterRoot || !isAbsolute(personalMemoryWriterRoot)) {
      throw new Error("FOURSDAY_GBRAIN_WRITER_ROOT must be absolute");
    }
    if (!personalMemoryGbrainPath || !isAbsolute(personalMemoryGbrainPath)) {
      throw new Error("FOURSDAY_GBRAIN_PATH must be absolute");
    }
  }

  return {
    databaseUrl,
    dataKey,
    tenantId,
    databaseSsl: boolean("FOURSDAY_DATABASE_SSL", false),
    databasePoolMax: positiveInteger("FOURSDAY_DATABASE_POOL_MAX", 10, { maximum: 50 }),
    targetUserIds: commaSeparated("FOURSDAY_DINGTALK_USERS"),
    enterpriseUsersEnabled: boolean("FOURSDAY_DINGTALK_ENTERPRISE_USERS", true),
    targetGroupIds: commaSeparated("FOURSDAY_DINGTALK_GROUPS"),
    selfUserId: process.env.FOURSDAY_DINGTALK_SELF_USER?.trim() || null,
    dwsPath: process.env.FOURSDAY_DWS_PATH?.trim() || join(homedir(), ".local", "bin", "dws"),
    codexPath: process.env.FOURSDAY_CODEX_PATH?.trim() || "codex",
    ghPath: process.env.FOURSDAY_GH_PATH?.trim() || null,
    personalMemoryEnabled,
    personalMemoryMcpUrl,
    personalMemoryIssuerUrl,
    personalMemoryClientId,
    personalMemoryClientSecret,
    personalMemoryTimeoutMs,
    personalMemoryMaxResults,
    personalMemoryWriteEnabled,
    personalMemoryGitRemote,
    personalMemoryGitBranch,
    personalMemoryWriterRoot,
    personalMemoryGbrainPath,
  };
}
