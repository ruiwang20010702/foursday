import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  access,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const proxyPath = fileURLToPath(new URL("./foursday-codex-proxy.mjs", import.meta.url));

function safeShadowDiagnostic(value) {
  return String(value ?? "")
    .replaceAll(/fctx_[a-f0-9]{64}/gu, "[context-token]")
    .replaceAll(/(token|secret|password|authorization)\s*[:=]\s*\S+/giu, "$1=[redacted]")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(-1_000);
}

async function privateJson(path, label) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || await realpath(absolute) !== absolute
  ) throw new Error(`${label} must be a private regular file`);
  return { absolute, value: JSON.parse(await readFile(absolute, "utf8")) };
}

async function privateFile(path, label) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (
    !metadata.isFile() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || await realpath(absolute) !== absolute
  ) throw new Error(`${label} must be a private regular file`);
  return absolute;
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  async function visit(path, relativePath = "") {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("Foursday shadow workspace contains a symlink");
    if (metadata.isDirectory()) {
      hash.update(`d\0${relativePath}\0`);
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    if (!metadata.isFile()) throw new Error("Foursday shadow workspace contains a special file");
    hash.update(`f\0${relativePath}\0${metadata.mode & 0o777}\0`);
    hash.update(await readFile(path));
  }
  await visit(root);
  return hash.digest("hex");
}

async function safeEnvironment({
  values, userHome, configPath, contextPath, codexHome, registry, workspace,
  profileInstructions, projectSkill,
}) {
  const codexPath = String(values.FOURSDAY_CODEX_PATH ?? "").trim();
  if (!isAbsolute(codexPath)) throw new Error("FOURSDAY_CODEX_PATH must be absolute before verification");
  const configuredCodex = resolve(codexPath);
  const codex = await realpath(codexPath);
  await access(codex, constants.X_OK);
  return {
    HOME: userHome,
    CODEX_HOME: codexHome,
    FOURSDAY_CODEX_PATH: configuredCodex,
    FOURSDAY_PROJECT_REGISTRY: registry,
    FOURSDAY_FALLBACK_WORKSPACE: workspace,
    FOURSDAY_PRODUCTION_CONFIG: configPath,
    FOURSDAY_WORK_CONTEXT_FILE: contextPath,
    FOURSDAY_PROFILE_INSTRUCTIONS_FILE: profileInstructions,
    FOURSDAY_PROJECT_SKILL_FILE: projectSkill,
    FOURSDAY_REQUIRE_WORK_CONTEXT: "false",
    PATH: [...new Set([
      dirname(configuredCodex), dirname(codex), dirname(process.execPath),
      "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ])].join(":"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

export function shadowServerDecision(message) {
  if (message?.method === "item/commandExecution/requestApproval") {
    return { decision: "accept" };
  }
  if (message?.method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (message?.method === "execCommandApproval") {
    return { decision: "approved" };
  }
  if (message?.method === "applyPatchApproval") {
    return { decision: { denied: { rejection: "Foursday shadow is read-only" } } };
  }
  return null;
}

export function shadowNotificationBelongsToTurn(message, { threadId, turnId } = {}) {
  const params = message?.params && typeof message.params === "object" ? message.params : {};
  const nestedTurn = params.turn && typeof params.turn === "object" ? params.turn : {};
  const nestedItem = params.item && typeof params.item === "object" ? params.item : {};
  const observedThreadId = params.threadId ?? params.thread_id ??
    nestedTurn.threadId ?? nestedTurn.thread_id ??
    nestedItem.threadId ?? nestedItem.thread_id ?? null;
  const observedTurnId = params.turnId ?? params.turn_id ??
    nestedTurn.id ?? nestedTurn.turnId ??
    nestedItem.turnId ?? nestedItem.turn_id ?? null;
  return !(
    (observedThreadId != null && threadId != null && String(observedThreadId) !== String(threadId)) ||
    (observedTurnId != null && turnId != null && String(observedTurnId) !== String(turnId))
  );
}

export function shadowVerificationPrompt() {
  return [
    "This is a read-only Foursday system verification.",
    "Use project tools to read FACT.txt in the current project.",
    "Return the exact evidence token found inside that file and identify the file as the source.",
    "The token is not provided in this request; do not guess it.",
    "Do not edit files, access the network, or call memory tools.",
  ].join(" ");
}

export function appServerSession({
  environment,
  workspace,
  expectedFact,
  prompt = null,
  timeoutMs = 180_000,
}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [proxyPath, "app-server"], {
      cwd: workspace,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    const completedItems = [];
    let finalText = "";
    let turnStatus = null;
    let activeThreadId = null;
    let activeTurnId = null;
    let stderr = "";
    let settled = false;
    let requestId = 0;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode == null) child.kill("SIGTERM");
      if (error) reject(error);
      else accept(result);
    };
    const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
      const id = ++requestId;
      pending.set(id, { resolveRequest, rejectRequest, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    timer = setTimeout(() => finish(new Error("Foursday Codex shadow timed out")), timeoutMs);
    timer.unref();
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (!settled) {
        const diagnostic = safeShadowDiagnostic(stderr);
        finish(new Error([
          signal
            ? `Foursday Codex shadow stopped by ${signal}`
            : `Foursday Codex shadow stopped before completion (${code})`,
          diagnostic,
        ].filter(Boolean).join(": ")));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && pending.has(message.id)) {
        const callback = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) callback.rejectRequest(new Error(
          `Foursday Codex ${callback.method} request failed: ${String(message.error?.message ?? "protocol error").slice(0, 300)}`,
        ));
        else callback.resolveRequest(message.result);
        return;
      }
      if (message.id != null && message.method) {
        const decision = shadowServerDecision(message);
        if (decision) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: decision })}\n`);
          return;
        }
      }
      const params = message.params && typeof message.params === "object" ? message.params : {};
      const nestedTurn = params.turn && typeof params.turn === "object" ? params.turn : {};
      const nestedItem = params.item && typeof params.item === "object" ? params.item : {};
      const observedTurnId = params.turnId ?? params.turn_id ??
        nestedTurn.id ?? nestedTurn.turnId ??
        nestedItem.turnId ?? nestedItem.turn_id ?? null;
      if (!shadowNotificationBelongsToTurn(message, {
        threadId: activeThreadId,
        turnId: activeTurnId,
      })) return;
      if (message.method === "turn/started" && observedTurnId != null && activeTurnId == null) {
        activeTurnId = String(observedTurnId);
      }
      if (message.method === "item/completed") {
        const item = message.params?.item;
        if (item) completedItems.push(item);
        if (item?.type === "agentMessage") finalText = String(item.text ?? "");
      }
      if (message.method === "turn/completed") {
        turnStatus = message.params?.turn?.status ?? null;
        const error = message.params?.turn?.error;
        if (turnStatus !== "completed") {
          finish(new Error(error?.message ? "Foursday Codex shadow turn failed" : "Foursday Codex shadow did not complete"));
          return;
        }
        finish(null, { finalText, completedItems, turnStatus, stderrSeen: Boolean(stderr.trim()) });
      }
    });
    (async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "foursday-shadow", title: "Foursday Shadow", version: "1" },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        const thread = await request("thread/start", { cwd: workspace });
        const threadId = thread?.thread?.id ?? thread?.id;
        if (!threadId) throw new Error("Foursday Codex shadow did not create a thread");
        activeThreadId = String(threadId);
        const startedTurn = await request("turn/start", {
          threadId,
          input: [{
            type: "text",
            text: prompt ?? shadowVerificationPrompt(),
          }],
        });
        activeTurnId = String(startedTurn?.turn?.id ?? startedTurn?.id ?? activeTurnId ?? "") || null;
      } catch (error) {
        finish(error);
      }
    })();
  });
}

export async function runFoursdayCodexShadow({
  layout,
  configPath,
  apply = false,
  execute = appServerSession,
} = {}) {
  const config = await privateJson(configPath, "Foursday config");
  const codexHome = join(layout.profileDirectory, "local", "foursday", "codex");
  await privateFile(join(codexHome, "config.toml"), "Foursday Codex config");
  const preview = {
    schema: "foursday-codex-shadow/v1",
    apply,
    isolatedCodexHome: codexHome,
    workspace: "ephemeral",
    messageSent: false,
    productionWrite: false,
    deploymentPerformed: false,
  };
  if (!apply) return { ...preview, loginRequiredBeforeApply: true };

  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-codex-shadow-")));
  try {
    const workspace = join(root, "workspace");
    const registry = join(root, "projects.json");
    const contextPath = join(root, "work-contexts.json");
    const fact = `FOURSDAY-SHADOW-${randomBytes(12).toString("hex").toUpperCase()}`;
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace, { mode: 0o700 }));
    await writeFile(join(workspace, "FACT.txt"), `${fact}\n`, { mode: 0o600 });
    await writeFile(contextPath, '{"schemaVersion":1,"contexts":{}}\n', { mode: 0o600 });
    const handle = await open(registry, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: 1,
        projects: [{ id: "shadow", name: "Foursday Shadow", aliases: [], root: workspace }],
      })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const before = await treeDigest(workspace);
    const session = await execute({
      environment: await safeEnvironment({
        values: config.value,
        userHome: layout.userHome,
        configPath: config.absolute,
        contextPath,
        codexHome,
        registry,
        workspace,
        profileInstructions: join(layout.profileDirectory, "SOUL.md"),
        projectSkill: join(layout.profileDirectory, "skills", "project-work", "SKILL.md"),
      }),
      workspace,
      expectedFact: fact,
    });
    const after = await treeDigest(workspace);
    if (before !== after) throw new Error("Foursday Codex shadow modified the verification workspace");
    if (!String(session.finalText ?? "").includes(fact)) {
      throw new Error("Foursday Codex shadow response did not contain verified project evidence");
    }
    const toolEvidence = (session.completedItems ?? []).filter((item) =>
      ["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(item?.type));
    if (toolEvidence.length === 0) throw new Error("Foursday Codex shadow produced no tool evidence");
    return {
      ...preview,
      verified: true,
      turnStatus: session.turnStatus,
      evidenceTokenVerified: true,
      toolEvidenceCount: toolEvidence.length,
      workspaceDigestBefore: before,
      workspaceDigestAfter: after,
      workspaceUnchanged: true,
      messageSent: false,
      productionWrite: false,
      deploymentPerformed: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
