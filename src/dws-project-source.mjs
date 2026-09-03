import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { withDwsCommandLock } from "./dws-command-lock.mjs";

const execFileAsync = promisify(execFile);
const dingtalkNodeId = /^[A-Za-z0-9]{20,80}$/u;
const dingtalkWorkspaceId = /^[A-Za-z0-9]{8,80}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const accessRoles = new Set(["READER", "EDITOR", "DOWNLOADER", "MANAGER", "OWNER"]);
const sufficientRoles = Object.freeze({
  read: new Set(["READER", "EDITOR", "DOWNLOADER", "MANAGER", "OWNER"]),
  download: new Set(["DOWNLOADER", "MANAGER", "OWNER"]),
  edit: new Set(["EDITOR", "MANAGER", "OWNER"]),
  manage: new Set(["MANAGER", "OWNER"]),
});

function dwsEnvironment(dwsPath, environment) {
  const home = String(environment.FOURSDAY_DWS_HOME ?? "").trim();
  if (!isAbsolute(home)) throw new Error("project_source_host_unavailable");
  return {
    HOME: home,
    PATH: [dirname(dwsPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
  };
}

async function executableDws(dwsPath) {
  if (!isAbsolute(String(dwsPath ?? ""))) {
    throw new Error("project_source_host_unavailable");
  }
  const executable = await realpath(dwsPath).catch(() => null);
  if (!executable) throw new Error("project_source_host_unavailable");
  await access(executable, constants.X_OK).catch(() => {
    throw new Error("project_source_host_unavailable");
  });
  return executable;
}

function structuredDwsFailure(error) {
  if (error?.message === "dws_command_lock_invalid") return "project_source_host_unavailable";
  if (["ENOENT", "EACCES", "ETIMEDOUT"].includes(String(error?.code ?? "")) || error?.killed) {
    return "project_source_host_unavailable";
  }
  for (const candidate of [error?.stdout, error?.stderr]) {
    try {
      const document = JSON.parse(String(candidate ?? ""));
      const marker = [
        document?.error?.reason,
        document?.error?.code,
        document?.reason,
        document?.code,
      ].filter(Boolean).join(" ").toLowerCase();
      if (/auth|not_authenticated|network|timeout|backend_dependency|service_unavailable/u.test(marker)) {
        return "project_source_host_unavailable";
      }
    } catch {}
  }
  return "project_source_read_failed";
}

async function runDwsJson({
  dwsPath,
  args,
  environment,
  run,
  timeoutMs,
  maxBuffer,
} = {}) {
  const executable = await executableDws(dwsPath);
  let stdout;
  try {
    ({ stdout } = await withDwsCommandLock(
      environment.DWS_PERSONAL_COMMAND_LOCK,
      () => run(executable, args, {
        env: dwsEnvironment(executable, environment),
        timeout: timeoutMs,
        maxBuffer,
      }),
      { timeoutMs: 10_000 },
    ));
  } catch (error) {
    if (error?.code === "dws_command_busy" || error?.message === "dws_command_busy") {
      throw new Error("project_source_host_busy");
    }
    throw new Error(structuredDwsFailure(error));
  }
  try {
    return { executable, payload: JSON.parse(String(stdout)) };
  } catch {
    throw new Error("project_source_read_failed");
  }
}

export async function inspectDwsProjectNode({
  dwsPath,
  nodeId,
  environment = process.env,
  run = execFileAsync,
  timeoutMs = 8_000,
  maxBuffer = 2 * 1024 * 1024,
} = {}) {
  if (!dingtalkNodeId.test(String(nodeId ?? ""))) {
    throw new Error("project_source_read_failed");
  }
  const { payload } = await runDwsJson({
    dwsPath,
    args: ["doc", "+inspect", "--node", nodeId, "--format", "json", "--timeout", "8"],
    environment,
    run,
    timeoutMs,
    maxBuffer,
  });
  const document = payload?.data?.document;
  if (
    payload?.complete !== true || payload?.status !== "success" || payload?.ok !== true ||
    document?.success !== true || document?.nodeId !== nodeId ||
    !["file", "folder"].includes(document?.nodeType) ||
    !dingtalkWorkspaceId.test(String(document?.workspaceId ?? "")) ||
    !dingtalkNodeId.test(String(document?.folderId ?? ""))
  ) throw new Error("project_source_read_failed");
  const updateTime = Number(document.updateTime);
  const createTime = Number(document.createTime);
  return {
    nodeId,
    nodeType: document.nodeType,
    title: String(document.name ?? "").trim().slice(0, 200),
    workspaceId: document.workspaceId,
    folderId: document.folderId,
    updatedAt: Number.isSafeInteger(updateTime) && updateTime > 0
      ? new Date(updateTime).toISOString()
      : null,
    createdAt: Number.isSafeInteger(createTime) && createTime > 0
      ? new Date(createTime).toISOString()
      : null,
  };
}

export async function inspectDwsProjectAccess({
  dwsPath,
  nodeId,
  principalHash,
  requiredAccess,
  environment = process.env,
  run = execFileAsync,
  timeoutMs = 8_000,
  maxBuffer = 2 * 1024 * 1024,
} = {}) {
  if (
    !dingtalkNodeId.test(String(nodeId ?? "")) ||
    !sha256.test(String(principalHash ?? "")) ||
    !Object.hasOwn(sufficientRoles, requiredAccess)
  ) throw new Error("project_source_access_unverifiable");
  const { payload } = await runDwsJson({
    dwsPath,
    args: [
      "doc", "+inspect", "--node", nodeId, "--include-permissions",
      "--format", "json", "--timeout", "8",
    ],
    environment,
    run,
    timeoutMs,
    maxBuffer,
  });
  const permissions = payload?.data?.permissions;
  const rows = permissions?.permissions;
  if (
    payload?.complete !== true || payload?.status !== "success" || payload?.ok !== true ||
    permissions?.success !== true || permissions?.hasMore !== false ||
    permissions?.truncated !== false || !Array.isArray(rows) || rows.length > 1_000 ||
    !Number.isSafeInteger(permissions?.totalCount) || permissions.totalCount !== rows.length
  ) throw new Error("project_source_access_unverifiable");
  for (const item of rows) {
    if (
      !item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.id !== "string" || item.id.length < 1 || item.id.length > 500 ||
      !accessRoles.has(String(item.role ?? "").toUpperCase())
    ) throw new Error("project_source_access_unverifiable");
  }
  const matches = rows.filter((item) =>
    createHash("sha256").update(item.id).digest("hex") === principalHash
  );
  const roles = [...new Set(matches.map((item) => String(item.role).toUpperCase()))].sort();
  return {
    state: matches.length > 0
      ? roles.some((role) => sufficientRoles[requiredAccess].has(role)) ? "granted" : "insufficient"
      : "unverified",
    principalMatched: matches.length > 0,
    roles,
    requiredAccess,
    hasRequiredAccess: matches.length > 0
      ? roles.some((role) => sufficientRoles[requiredAccess].has(role))
      : null,
    complete: true,
  };
}

export async function fetchDwsProjectDocument({
  dwsPath,
  nodeId,
  keyword = null,
  environment = process.env,
  run = execFileAsync,
  timeoutMs = 8_000,
  maxBuffer = 2 * 1024 * 1024,
} = {}) {
  if (!dingtalkNodeId.test(String(nodeId ?? ""))) throw new Error("project_source_read_failed");
  const args = ["doc", "+fetch", "--node", nodeId, "--format", "json", "--timeout", "8"];
  if (keyword) args.push("--keyword", keyword);
  const { payload } = await runDwsJson({
    dwsPath, args, environment, run, timeoutMs, maxBuffer,
  });
  const content = payload?.content;
  if (
    payload?.complete !== true || payload?.status !== "success" ||
    content?.success !== true || content?.nodeId !== nodeId ||
    typeof content?.markdown !== "string" || content.markdown.trim() === ""
  ) throw new Error("project_source_read_failed");
  return {
    title: String(content.title ?? "").trim().slice(0, 200),
    markdown: content.markdown,
  };
}
