#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/main-module.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultProfile = join(process.env.HOME ?? "", ".hermes", "profiles", "foursday");
const tokenPattern = /fctx_[a-f0-9]{64}/gu;

function parseEnv(content) {
  const values = {};
  for (const line of String(content).split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (!match) continue;
    values[match[1]] = JSON.parse(match[2]);
  }
  return values;
}

async function privateFile(path, maximum = 1024 * 1024) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || metadata.size > maximum ||
    await realpath(absolute) !== absolute
  ) throw new Error("Runtime MCP validation input is unsafe");
  return absolute;
}

async function regularSourceFile(path, root, maximum = 2 * 1024 * 1024) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  const canonicalRoot = await realpath(root);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum ||
    await realpath(absolute) !== absolute ||
    !(absolute === canonicalRoot || absolute.startsWith(`${canonicalRoot}${sep}`))
  ) throw new Error("Runtime MCP validation source is unsafe");
  return absolute;
}

export function percentile95(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Runtime MCP latency sample is invalid");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Runtime MCP validation option is invalid");
  }
  return parsed;
}

function rpcClient(child, timeoutMs) {
  const pending = new Map();
  let requestId = 0;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id == null || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(
      `Runtime MCP app-server request failed: ${String(message.error?.message ?? "protocol error").slice(0, 200)}`,
    ));
    else request.resolve(message.result);
  });
  child.once("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Runtime MCP app-server stopped before responding"));
    }
    pending.clear();
  });
  return (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      rejectRequest(new Error(`Runtime MCP ${method} timed out`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function validationEnvironment(environment, profile, contexts) {
  const output = {
    HOME: process.env.HOME,
    CODEX_HOME: join(profile, "local", "foursday", "codex"),
    PATH: [
      dirname(String(environment.FOURSDAY_NODE_PATH ?? "")),
      dirname(String(environment.FOURSDAY_CODEX_PATH ?? "")),
      "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ].filter(Boolean).join(":"),
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "C.UTF-8",
    FOURSDAY_PRODUCTION_CONFIG: environment.FOURSDAY_PRODUCTION_CONFIG,
    FOURSDAY_PROJECT_REGISTRY: environment.FOURSDAY_PROJECT_REGISTRY,
    FOURSDAY_WORK_CONTEXT_FILE: contexts,
    FOURSDAY_PROFILE_RELEASE_FILE: environment.FOURSDAY_PROFILE_RELEASE_FILE,
    FOURSDAY_RELEASE_SHA: environment.FOURSDAY_RELEASE_SHA,
    FOURSDAY_MODE: environment.FOURSDAY_MODE,
    DWS_PERSONAL_SEND_ENABLED: environment.DWS_PERSONAL_SEND_ENABLED,
    DWS_PERSONAL_STATE_FILE: environment.DWS_PERSONAL_STATE_FILE,
    DWS_PERSONAL_FALLBACK_MS: environment.DWS_PERSONAL_FALLBACK_MS,
  };
  for (const [name, value] of Object.entries(output)) {
    if (typeof value !== "string" || value === "") delete output[name];
  }
  return output;
}

async function terminateChild(child) {
  if (!child || child.exitCode != null) return;
  await new Promise((resolveClose) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClose();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    timer = setTimeout(() => {
      if (child.exitCode == null) child.kill("SIGKILL");
      finish();
    }, 2_000);
    timer.unref?.();
  });
}

async function timedCall(request, threadId, tool, args) {
  const started = performance.now();
  const result = await request("mcpServer/tool/call", {
    threadId,
    server: "foursday",
    tool,
    arguments: args,
  });
  const elapsedMs = performance.now() - started;
  if (result?.isError === true) {
    throw new Error(`Runtime MCP ${tool} returned an error`);
  }
  return { elapsedMs, result };
}

export async function verifyRuntimeMcpReliability({
  iterations = 20,
  timeoutMs = 12_000,
  maximumP95Ms = 2_000,
  profileDirectory = defaultProfile,
  mcpPath = join(projectRoot, "src", "foursday-codex-mcp.mjs"),
} = {}) {
  const count = boundedInteger(iterations, 20, 1, 100);
  const requestTimeoutMs = boundedInteger(timeoutMs, 12_000, 1_000, 60_000);
  const p95Limit = boundedInteger(maximumP95Ms, 2_000, 100, 10_000);
  const profile = await realpath(profileDirectory);
  const envPath = await privateFile(join(profile, ".env"));
  const environment = parseEnv(await readFile(envPath, "utf8"));
  if (
    environment.FOURSDAY_MODE !== "shadow" ||
    environment.DWS_PERSONAL_SEND_ENABLED !== "false"
  ) throw new Error("Runtime MCP validation requires send-disabled Shadow mode");
  const sourceMcp = await regularSourceFile(mcpPath, projectRoot);
  const nodePath = String(environment.FOURSDAY_NODE_PATH ?? "");
  const codexPath = String(environment.FOURSDAY_CODEX_PATH ?? "");
  const workspace = await realpath(String(environment.FOURSDAY_FALLBACK_WORKSPACE ?? ""));
  if (!isAbsolute(nodePath) || !isAbsolute(codexPath) || !workspace.startsWith(`${profile}${sep}`)) {
    throw new Error("Runtime MCP validation runtime is invalid");
  }
  const productionConfigPath = await privateFile(environment.FOURSDAY_PRODUCTION_CONFIG);
  const productionConfig = JSON.parse(await readFile(productionConfigPath, "utf8"));
  if (/^(?:1|true|yes)$/iu.test(String(productionConfig.FOURSDAY_GBRAIN_WRITE_ENABLED ?? "false"))) {
    throw new Error("Runtime MCP validation requires gbrain writes to remain disabled");
  }

  const temporary = await realpath(await mkdtemp(join(tmpdir(), "foursday-runtime-mcp-")));
  const attachment = join(temporary, "validation.txt");
  const contexts = join(temporary, "contexts.json");
  const token = `fctx_${randomBytes(32).toString("hex")}`;
  const attachmentBytes = Buffer.from(`Runtime MCP validation ${randomBytes(16).toString("hex")}\n`);
  let child = null;
  let stagedPath = null;
  let inboxExisted = false;
  try {
    await writeFile(attachment, attachmentBytes, { mode: 0o600 });
    await writeFile(contexts, `${JSON.stringify({
      schemaVersion: 1,
      contexts: {
        [token]: {
          projectId: "foursday",
          workspace,
          projectContext: "Runtime MCP read-only Shadow validation.",
          memoryContext: "",
          sourcePrincipalHandle: "a".repeat(64),
          sourceSessionHash: "b".repeat(64),
          sourceScope: "direct",
          attachments: [{ path: attachment, name: "validation.txt", mimeType: "text/plain" }],
          expiresAt: Math.floor(Date.now() / 1000) + 900,
        },
      },
    })}\n`, { mode: 0o600 });
    const inbox = join(workspace, ".foursday-inbox");
    inboxExisted = await lstat(inbox).then(() => true).catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    const childEnvironment = validationEnvironment(environment, profile, contexts);
    const argsOverride = `mcp_servers.foursday.args=[${JSON.stringify(sourceMcp)}]`;
    child = spawn(nodePath, [
      codexPath,
      "app-server",
      "-c", argsOverride,
      "-c", "mcp_servers.foursday.startup_timeout_sec=5",
      "-c", "mcp_servers.foursday.tool_timeout_sec=10",
    ], {
      cwd: workspace,
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderrSeen = false;
    child.stderr.on("data", () => { stderrSeen = true; });
    const request = rpcClient(child, requestTimeoutMs);
    await request("initialize", {
      clientInfo: { name: "foursday-runtime-mcp-validation", version: "1" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    const thread = await request("thread/start", { cwd: workspace, ephemeral: true });
    const threadId = thread?.thread?.id ?? thread?.id;
    if (!threadId) throw new Error("Runtime MCP validation did not create an ephemeral thread");
    const samples = {
      foursday_runtime_status: [],
      foursday_list_attachments: [],
      foursday_read_project_memory: [],
      foursday_stage_attachment: [],
    };
    for (let index = 0; index < count; index += 1) {
      const status = await timedCall(request, threadId, "foursday_runtime_status", { contextToken: token });
      if (
        status.result?.structuredContent?.source !== "live_profile" ||
        status.result?.structuredContent?.mode !== "shadow" ||
        status.result?.structuredContent?.sendEnabled !== false
      ) throw new Error("Runtime MCP status read-back is invalid");
      samples.foursday_runtime_status.push(status.elapsedMs);

      const listed = await timedCall(request, threadId, "foursday_list_attachments", { contextToken: token });
      if (listed.result?.structuredContent?.attachments?.length !== 1) {
        throw new Error("Runtime MCP attachment list read-back is invalid");
      }
      samples.foursday_list_attachments.push(listed.elapsedMs);

      const memory = await timedCall(request, threadId, "foursday_read_project_memory", { contextToken: token });
      if (
        memory.result?.structuredContent?.sourceId !== "default" ||
        memory.result?.structuredContent?.readOnly !== true
      ) throw new Error("Runtime MCP project memory read-back is invalid");
      samples.foursday_read_project_memory.push(memory.elapsedMs);

      const staged = await timedCall(request, threadId, "foursday_stage_attachment", {
        contextToken: token,
        attachmentIndex: 0,
      });
      const relativePath = String(staged.result?.structuredContent?.relativePath ?? "");
      const candidate = resolve(workspace, relativePath);
      if (
        !relativePath.startsWith(".foursday-inbox/") ||
        !candidate.startsWith(`${workspace}${sep}`) ||
        staged.result?.structuredContent?.commitAllowed !== false ||
        !(await readFile(candidate)).equals(attachmentBytes)
      ) throw new Error("Runtime MCP staged attachment read-back is invalid");
      stagedPath = candidate;
      samples.foursday_stage_attachment.push(staged.elapsedMs);
    }
    const metrics = Object.fromEntries(Object.entries(samples).map(([tool, values]) => [tool, {
      calls: values.length,
      p95Ms: Math.round(percentile95(values) * 100) / 100,
      maximumMs: Math.round(Math.max(...values) * 100) / 100,
    }]));
    const slowMetrics = Object.entries(metrics)
      .filter(([, metric]) => metric.p95Ms >= p95Limit)
      .map(([tool, metric]) => `${tool}:${metric.p95Ms}ms`);
    if (slowMetrics.length > 0) {
      throw new Error(`Runtime MCP P95 latency gate failed (${slowMetrics.join(",")})`);
    }
    return {
      schema: "foursday-runtime-mcp-validation/v1",
      verified: true,
      iterations: count,
      successfulCalls: count * Object.keys(samples).length,
      failedCalls: 0,
      maximumP95Ms: p95Limit,
      metrics,
      candidateWriteTool: "isolated-tests-only",
      codeModeHostPreserved: true,
      messageSent: false,
      gbrainWritePerformed: false,
      scheduleRunPerformed: false,
      productionDeploymentPerformed: false,
      stderrSeen,
    };
  } finally {
    await terminateChild(child);
    if (stagedPath) await unlink(stagedPath).catch(() => {});
    if (!inboxExisted) await rmdir(join(workspace, ".foursday-inbox")).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
    });
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  const iterationsFlag = process.argv.find((value) => value.startsWith("--iterations="));
  const iterations = iterationsFlag ? Number(iterationsFlag.split("=")[1]) : 20;
  const result = await verifyRuntimeMcpReliability({ iterations });
  process.stdout.write(`${JSON.stringify(result, null, 2).replace(tokenPattern, "[context-token]")}\n`);
}
