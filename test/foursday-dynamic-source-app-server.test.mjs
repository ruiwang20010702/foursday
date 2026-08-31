import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function rpcClient(child, timeoutMs = 10_000) {
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
    if (message.error) request.reject(new Error(String(message.error.message ?? "app-server error")));
    else request.resolve(message.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`App Server request timed out: ${method}`));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

test("real Codex App Server reads one owner-provided DingTalk source without exposing its node", async (t) => {
  let codex;
  try {
    codex = String((await execFileAsync("/usr/bin/which", ["codex"])).stdout).trim();
  } catch {
    t.skip("Codex is not installed");
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-dynamic-appserver-")));
  let child = null;
  t.after(async () => {
    if (child?.exitCode == null) {
      child.kill("SIGTERM");
      await Promise.race([
        once(child, "close"),
        new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
      ]);
      if (child.exitCode == null) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const codexHome = join(root, "codex");
  const workspace = join(root, "workspace");
  await mkdir(codexHome, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const nodeId = "OWNERPROVIDEDDOCNODE123456789012";
  const token = `fctx_${"e".repeat(64)}`;
  const contextPath = join(root, "contexts.json");
  const registryPath = join(root, "projects.json");
  const routeStatePath = join(root, "routes.json");
  const dwsPath = join(root, "dws");
  await writeFile(dwsPath, `#!/bin/sh
if [ "$2" = "+inspect" ]; then
  printf '%s\\n' '{"complete":true,"status":"success","ok":true,"data":{"document":{"success":true,"nodeId":"${nodeId}","nodeType":"file","name":"Approved PRD","workspaceId":"OWNERWORKSPACE01","folderId":"OWNERDOCUMENTFOLDER123456789012","createTime":1784712405000,"updateTime":1787041697000}}}'
elif [ "$2" = "+fetch" ]; then
  printf '%s\\n' '{"complete":true,"status":"success","content":{"success":true,"nodeId":"${nodeId}","title":"Approved PRD","markdown":"# Approved requirements\\n\\nCurrent product evidence."}}'
else
  exit 7
fi
`, { mode: 0o700 });
  await chmod(dwsPath, 0o700);
  await writeFile(contextPath, `${JSON.stringify({
    schemaVersion: 1,
    contexts: {
      [token]: {
        projectId: "shared_link",
        workspace,
        projectContext: "Project: Example",
        memoryContext: "",
        sourcePrincipalHandle: "a".repeat(64),
        sourceSessionHash: "b".repeat(64),
        sourceScope: "direct",
        requesterRole: "owner",
        providedDingtalkSources: [{
          sourceId: "provided_1",
          kind: "doc",
          nodeId,
          messageHash: "c".repeat(64),
          requesterRole: "owner",
        }],
        attachments: [],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      },
    },
  })}\n`, { mode: 0o600 });
  await writeFile(registryPath, `${JSON.stringify({
    schemaVersion: 1,
    projects: [{
      id: "example",
      name: "Example",
      aliases: [],
      root: workspace,
      gbrainSlugs: [],
      dingtalkSources: [],
    }],
  })}\n`, { mode: 0o600 });
  const mcpPath = join(projectRoot, "src", "foursday-codex-mcp.mjs");
  await writeFile(join(codexHome, "config.toml"), `
[mcp_servers.foursday]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(mcpPath)}]
startup_timeout_sec = 5
tool_timeout_sec = 30
env_vars = ["FOURSDAY_PROJECT_REGISTRY", "FOURSDAY_ROUTE_STATE_FILE", "FOURSDAY_WORK_CONTEXT_FILE"]
required = true
enabled_tools = ["foursday_list_project_sources", "foursday_read_project_source", "foursday_list_projects", "foursday_select_project", "foursday_discover_work_scopes", "foursday_select_work_scope"]
default_tools_approval_mode = "auto"

[mcp_servers.foursday.env]
DWS_PATH = ${JSON.stringify(dwsPath)}
FOURSDAY_DWS_HOME = ${JSON.stringify(root)}
DWS_PERSONAL_COMMAND_LOCK = ${JSON.stringify(join(root, "dws-command.lock"))}

[projects.${JSON.stringify(workspace)}]
trust_level = "trusted"
`, { mode: 0o600 });
  child = spawn(codex, ["app-server"], {
    cwd: workspace,
    env: {
      HOME: process.env.HOME,
      CODEX_HOME: codexHome,
      FOURSDAY_PROJECT_REGISTRY: registryPath,
      FOURSDAY_ROUTE_STATE_FILE: routeStatePath,
      FOURSDAY_WORK_CONTEXT_FILE: contextPath,
      PATH: [dirname(process.execPath), dirname(codex), "/usr/bin", "/bin"].join(":"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "1",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const request = rpcClient(child);
  await request("initialize", { clientInfo: { name: "dynamic-source-test", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
  const thread = await request("thread/start", { cwd: workspace, ephemeral: true });
  const threadId = thread?.thread?.id ?? thread?.id;
  assert.ok(threadId);
  const listed = await request("mcpServer/tool/call", {
    threadId,
    server: "foursday",
    tool: "foursday_list_project_sources",
    arguments: { contextToken: token },
  });
  assert.equal(listed.isError, false);
  assert.equal(listed.structuredContent.sources[0].sourceId, "provided_1");
  assert.equal(listed.structuredContent.sources[0].access, "owner_exact_link");
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(nodeId, "u"));
  const read = await request("mcpServer/tool/call", {
    threadId,
    server: "foursday",
    tool: "foursday_read_project_source",
    arguments: { contextToken: token, sourceId: "provided_1", maxChars: 1_000 },
  });
  assert.equal(read.isError, false);
  assert.equal(read.structuredContent.sourceId, "provided_1");
  assert.equal(read.structuredContent.access, "owner_exact_link");
  assert.equal(read.structuredContent.sourceOrigin, "provided");
  assert.equal(read.structuredContent.sourceUpdatedAt, "2026-08-18T08:28:17.000Z");
  assert.match(read.structuredContent.content, /Current product evidence/u);
  assert.doesNotMatch(JSON.stringify(read), new RegExp(nodeId, "u"));
  const projects = await request("mcpServer/tool/call", {
    threadId,
    server: "foursday",
    tool: "foursday_list_projects",
    arguments: { contextToken: token },
  });
  assert.equal(projects.isError, false);
  assert.deepEqual(projects.structuredContent.projects.map((project) => project.projectId), ["example"]);
  const selected = await request("mcpServer/tool/call", {
    threadId,
    server: "foursday",
    tool: "foursday_select_work_scope",
    arguments: {
      contextToken: token,
      primaryScopeId: "example",
      evidenceSourceIds: ["provided_1"],
      rationale: "The exact current document belongs to the Example workspace.",
    },
  });
  assert.equal(selected.isError, false);
  assert.equal(selected.structuredContent.appliesOn, "next_turn");
  const routeState = JSON.parse(await readFile(routeStatePath, "utf8"));
  assert.equal(routeState.schemaVersion, 2);
  assert.equal(routeState.bindings["b".repeat(64)].primaryScopeId, "example");
  assert.deepEqual(routeState.bindings["b".repeat(64)].evidenceSourceIds, ["provided_1"]);
  assert.equal(stderr.join("").trim(), "");
});
