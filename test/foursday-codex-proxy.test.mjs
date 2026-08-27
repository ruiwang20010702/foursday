import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  classifyCodexServerRequest,
  codexProxyChildArgs,
  codexProcessEnvironment,
  injectFoursdayTurnContext,
  rewriteCodexClientRequest,
  runFoursdayCodexProxy,
} from "../src/foursday-codex-proxy.mjs";
import {
  foursdayCodexConfig,
  foursdayCodexRules,
} from "../src/foursday-native-profile-config.mjs";

const execFileAsync = promisify(execFile);

test("proxy forces the Foursday permission profile on every Codex thread", () => {
  const initialized = rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { capabilities: { optOutNotificationMethods: ["x"] } },
  });
  assert.equal(initialized.params.capabilities.experimentalApi, true);
  assert.deepEqual(initialized.params.capabilities.optOutNotificationMethods, ["x"]);
  for (const method of ["thread/start"]) {
    const rewritten = rewriteCodexClientRequest({
      jsonrpc: "2.0", id: 2, method,
      params: {
        cwd: "/project",
        approvalPolicy: "never",
        sandbox: "dangerFullAccess",
        permissions: { type: "profile", id: ":danger-full-access" },
      },
    }, { developerInstructions: "Foursday trusted instructions" });
    assert.equal(rewritten.params.cwd, "/project");
    assert.equal(rewritten.params.approvalPolicy, "untrusted");
    assert.equal(rewritten.params.permissions, "foursday-workspace");
    assert.equal(rewritten.params.serviceName, "foursday");
    assert.equal(rewritten.params.sandbox, undefined);
    assert.equal(rewritten.params.developerInstructions, "Foursday trusted instructions");
  }
  for (const method of ["thread/resume", "thread/fork"]) {
    assert.throws(() => rewriteCodexClientRequest({
      jsonrpc: "2.0", id: 8, method, params: { threadId: "foreign" },
    }, { developerInstructions: "Foursday trusted instructions" }), /unbound_thread_denied/u);
    const rewritten = rewriteCodexClientRequest({
      jsonrpc: "2.0", id: 9, method, params: {
        threadId: "bound-thread", cwd: "/project", permissions: ":danger-full-access",
      },
    }, {
      allowedRoots: new Set(["/project"]),
      boundThreadIds: new Set(["bound-thread"]),
      developerInstructions: "Foursday trusted instructions",
    });
    assert.equal(rewritten.params.threadId, "bound-thread");
    assert.equal(rewritten.params.permissions, "foursday-workspace");
    assert.equal(rewritten.params.approvalPolicy, "untrusted");
  }
  const turn = rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 4, method: "turn/start",
    params: {
      threadId: "thread",
      input: [],
      cwd: "/project",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      permissions: ":danger-full-access",
      config: { default_permissions: ":danger-full-access" },
      runtimeWorkspaceRoots: ["/"],
      environments: [{ id: "remote" }],
      dynamicTools: [{ name: "unsafe" }],
      collaborationMode: { mode: "default", settings: { developer_instructions: "unsafe" } },
      multiAgentMode: "unrestricted",
      model: "attacker-model",
      serviceTier: "attacker-tier",
    },
  }, {
    allowedRoots: new Set(["/project"]),
    developerInstructions: "Foursday trusted instructions",
  });
  assert.equal(turn.params.cwd, "/project");
  assert.equal(turn.params.approvalPolicy, "untrusted");
  assert.equal(turn.params.permissions, "foursday-workspace");
  assert.equal(turn.params.sandboxPolicy, undefined);
  assert.equal(turn.params.config, undefined);
  assert.equal(turn.params.runtimeWorkspaceRoots, undefined);
  assert.equal(turn.params.environments, undefined);
  assert.equal(turn.params.dynamicTools, undefined);
  assert.equal(turn.params.collaborationMode, undefined);
  assert.equal(turn.params.multiAgentMode, undefined);
  assert.equal(turn.params.model, undefined);
  assert.equal(turn.params.serviceTier, undefined);
  assert.throws(() => rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 5, method: "turn/start",
    params: { threadId: "thread", input: [], cwd: "/other" },
  }, {
    allowedRoots: new Set(["/project"]),
    developerInstructions: "Foursday trusted instructions",
  }), /workspace_denied/u);

  const classifier = rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 10, method: "thread/start",
    params: { cwd: "/project", permissions: ":danger-full-access" },
  }, {
    allowedRoots: new Set(["/project"]),
    developerInstructions: "Classifier only",
    classifierMode: true,
  });
  assert.equal(classifier.params.permissions, "foursday-classifier");
  assert.equal(classifier.params.approvalPolicy, "never");
  assert.equal(classifier.params.developerInstructions, "Classifier only");
  assert.throws(() => rewriteCodexClientRequest({
    jsonrpc: "2.0", id: 3, method: "thread/start", params: { cwd: "/other" },
  }, {
    allowedRoots: new Set(["/project"]),
    developerInstructions: "Foursday trusted instructions",
  }), /workspace_denied/u);
});

test("proxy identifies high-risk commands even through absolute paths or shell wrappers", () => {
  const request = (command) => ({
    method: "item/commandExecution/requestApproval",
    params: { command },
  });
  for (const command of [
    "/usr/bin/git push origin main",
    "git add -A",
    "git add .foursday-inbox/report.csv",
    "/bin/zsh -lc 'rm -rf ./output'",
    "terraform destroy -auto-approve",
    "/usr/bin/security find-generic-password -w",
    "psql -c 'delete from users'",
    "rm notes.txt",
    "git restore important.md",
    "find . -name '*.tmp' -delete",
  ]) assert.equal(classifyCodexServerRequest(request(command)), "high_risk_command");
  assert.equal(classifyCodexServerRequest(request("npm test")), null);
  assert.equal(classifyCodexServerRequest({
    method: "item/permissions/requestApproval",
  }), "permission_escalation");
  assert.equal(classifyCodexServerRequest({
    method: "execCommandApproval",
    params: { command: "git push origin main" },
  }), "high_risk_command");
});

test("proxy rejects command-line config overrides before starting Codex", async () => {
  let spawned = false;
  await assert.rejects(runFoursdayCodexProxy({
    args: ["app-server", "-c", "default_permissions=\":danger-full-access\""],
    spawnProcess: () => { spawned = true; },
  }), /fixed app-server entrypoint/u);
  assert.equal(spawned, false);
});

test("classifier proxy disables every non-text capability before Codex starts", () => {
  const args = codexProxyChildArgs({ classifierMode: true });
  assert.deepEqual(args.slice(-1), ["app-server"]);
  assert.equal(args.includes("mcp_servers={}"), true);
  assert.equal(args.includes("tools.web_search=false"), true);
  assert.equal(args.includes("tools.view_image=false"), true);
  assert.equal(args.includes("features.multi_agent=false"), true);
  assert.equal(args.includes("features.memories=false"), true);
  assert.deepEqual(codexProxyChildArgs(), ["app-server"]);
});

test("proxy gives Codex only runtime essentials and read-only MCP status bindings", () => {
  const environment = codexProcessEnvironment({
    HOME: "/home/foursday",
    CODEX_HOME: "/home/foursday/codex",
    FOURSDAY_PRODUCTION_CONFIG: "/private/config.json",
    FOURSDAY_PROJECT_REGISTRY: "/private/projects.json",
    FOURSDAY_ROUTE_STATE_FILE: "/private/routes.json",
    FOURSDAY_WORK_CONTEXT_FILE: "/private/contexts.json",
    FOURSDAY_PROFILE_RELEASE_FILE: "/private/release.json",
    FOURSDAY_RELEASE_SHA: "a".repeat(40),
    FOURSDAY_MODE: "shadow",
    DWS_PERSONAL_SEND_ENABLED: "false",
    DWS_PERSONAL_STATE_FILE: "/private/dws.json",
    DWS_PERSONAL_FALLBACK_MS: "30000",
    DWS_PERSONAL_COMMAND_LOCK: "/private/dws-command.lock",
    DWS_PERSONAL_ENTERPRISE_USERS_ENABLED: "true",
    DWS_PATH: "/private/dws",
    FOURSDAY_DWS_HOME: "/private/home",
    FOURSDAY_PYTHON_PATH: "/managed/python/bin/python3",
    FOURSDAY_NODE_PATH: "/managed/node/bin/node",
    FOURSDAY_DINGTALK_USERS: "private-user-id",
    DWS_PERSONAL_ALLOWED_USERS: "private-user-id",
    GH_TOKEN: "secret",
    DATABASE_URL: "secret",
  }, "/usr/local/bin/codex");
  assert.equal(environment.HOME, "/home/foursday");
  assert.equal(environment.FOURSDAY_PROJECT_REGISTRY, "/private/projects.json");
  assert.equal(environment.FOURSDAY_ROUTE_STATE_FILE, "/private/routes.json");
  assert.equal(environment.FOURSDAY_PROFILE_RELEASE_FILE, "/private/release.json");
  assert.equal(environment.FOURSDAY_RELEASE_SHA, "a".repeat(40));
  assert.equal(environment.FOURSDAY_MODE, "shadow");
  assert.equal(environment.DWS_PERSONAL_SEND_ENABLED, "false");
  assert.equal(environment.DWS_PERSONAL_STATE_FILE, "/private/dws.json");
  assert.equal(environment.DWS_PERSONAL_COMMAND_LOCK, "/private/dws-command.lock");
  assert.equal(environment.DWS_PERSONAL_ENTERPRISE_USERS_ENABLED, "true");
  assert.equal(environment.PYTHON, "/managed/python/bin/python3");
  assert.equal(environment.PATH.split(":")[0], "/managed/node/bin");
  assert.equal(environment.FOURSDAY_NODE_PATH, undefined);
  assert.equal(environment.FOURSDAY_PYTHON_PATH, undefined);
  assert.equal(environment.FOURSDAY_DINGTALK_USERS, undefined);
  assert.equal(environment.DWS_PERSONAL_ALLOWED_USERS, undefined);
  assert.equal(environment.DWS_PATH, undefined);
  assert.equal(environment.FOURSDAY_DWS_HOME, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.DATABASE_URL, undefined);

  const classifier = codexProcessEnvironment({
    HOME: "/home/foursday",
    CODEX_HOME: "/home/foursday/codex",
    FOURSDAY_PROJECT_REGISTRY: "/private/projects.json",
    FOURSDAY_PRODUCTION_CONFIG: "/private/config.json",
    DWS_PERSONAL_STATE_FILE: "/private/dws.json",
  }, "/usr/local/bin/codex", "/usr/local/bin/codex", { includeFoursday: false });
  assert.equal(classifier.CODEX_HOME, "/home/foursday/codex");
  assert.equal(classifier.FOURSDAY_PROJECT_REGISTRY, undefined);
  assert.equal(classifier.FOURSDAY_PRODUCTION_CONFIG, undefined);
  assert.equal(classifier.DWS_PERSONAL_STATE_FILE, undefined);
});

test("turn context token becomes project and personal-memory context without reaching the user request", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-turn-context-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = `fctx_${"a".repeat(64)}`;
  const contextPath = join(root, "contexts.json");
  const imagePath = join(root, "input.png");
  const spoofedImagePath = join(root, "spoofed.png");
  await writeFile(
    imagePath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    { mode: 0o600 },
  );
  await writeFile(spoofedImagePath, "not an image\n", { mode: 0o600 });
  await writeFile(contextPath, `${JSON.stringify({
    schemaVersion: 1,
    contexts: {
      [token]: {
        projectId: "example",
        workspace: root,
        projectContext: "Project: Example. Workspace is already routed.",
        memoryContext: "The owner prefers evidence-first answers.",
        sourcePrincipalHandle: "b".repeat(64),
        sourceSessionHash: "c".repeat(64),
        sourceScope: "direct",
        requesterRole: "owner",
        providedDingtalkSources: [],
        ownerIntervention: "task_correction",
        attachments: [
          { path: imagePath, mimeType: "image/png", name: "input.png" },
          { path: spoofedImagePath, mimeType: "image/png", name: "spoofed.png" },
        ],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
    },
  })}\n`, { mode: 0o600 });
  const result = await injectFoursdayTurnContext({
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {
      threadId: "thread",
      input: [{ type: "text", text: `What changed?\n\n<!-- foursday-context:${token} -->` }],
    },
  }, {
    environment: {
      FOURSDAY_WORK_CONTEXT_FILE: contextPath,
      FOURSDAY_REQUIRE_WORK_CONTEXT: "true",
    },
    cwd: root,
  });
  const text = result.params.input[0].text;
  assert.match(text, /Project: Example/u);
  assert.match(text, /scope="project-reversible"/u);
  assert.match(text, /Ask the requester only for irreducible business meaning/u);
  assert.match(text, /owner prefers evidence-first/u);
  assert.match(text, /<current_user_request>\nWhat changed\?/u);
  assert.match(text, /<foursday_owner_intervention trust="connector-verified" type="task_correction" \/>/u);
  assert.doesNotMatch(text, /<!-- foursday-context:/u);
  assert.deepEqual(result.params.input[1], { type: "localImage", path: imagePath });
  assert.equal(result.params.input.length, 2);
  assert.match(text, /spoofed\.png.*use-foursday_stage_attachment-mcp/u);
});

test("turn context replaces DingTalk URLs with connector-bound source IDs", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-turn-link-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = `fctx_${"f".repeat(64)}`;
  const nodeId = "OWNERPROVIDEDDOCNODE123456789012";
  const contextPath = join(root, "contexts.json");
  await writeFile(contextPath, `${JSON.stringify({
    schemaVersion: 1,
    contexts: {
      [token]: {
        projectId: "example",
        workspace: root,
        projectContext: "Project: Example",
        memoryContext: "",
        sourcePrincipalHandle: "b".repeat(64),
        sourceSessionHash: "c".repeat(64),
        sourceScope: "direct",
        requesterRole: "owner",
        providedDingtalkSources: [{
          sourceId: "provided_1",
          kind: "doc",
          nodeId,
          messageHash: "d".repeat(64),
          requesterRole: "owner",
        }],
        attachments: [],
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
    },
  })}\n`, { mode: 0o600 });
  const result = await injectFoursdayTurnContext({
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {
      threadId: "thread",
      input: [{
        type: "text",
        text: `读取 https://alidocs.dingtalk.com/i/nodes/${nodeId}?utm_scene=team_space 和 https://alidocs.dingtalk.com/i/nodes/UNBOUNDPROVIDEDDOCNODE1234567890\n\n<!-- foursday-context:${token} -->`,
      }],
    },
  }, {
    environment: {
      FOURSDAY_WORK_CONTEXT_FILE: contextPath,
      FOURSDAY_REQUIRE_WORK_CONTEXT: "true",
    },
    cwd: root,
  });
  const text = result.params.input[0].text;
  assert.match(text, /DingTalk document source: provided_1/u);
  assert.match(text, /Unbound DingTalk document link/u);
  assert.doesNotMatch(text, /alidocs\.dingtalk\.com|OWNERPROVIDEDDOCNODE|UNBOUNDPROVIDEDDOCNODE/u);
});

test("real Codex app-server confirms the forced Foursday sandbox and permission profile", async (t) => {
  let codex;
  try {
    codex = String((await execFileAsync("/usr/bin/which", ["codex"])).stdout).trim();
  } catch {
    t.skip("Codex is not installed");
    return;
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-appserver-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const workspace = join(root, "workspace");
  const fallback = join(root, "fallback");
  const registry = join(root, "projects.json");
  const profileInstructions = join(root, "SOUL.md");
  const projectSkill = join(root, "project-work.md");
  await mkdir(join(codexHome, "rules"), { recursive: true, mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(fallback, { mode: 0o700 });
  await writeFile(registry, `${JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: "test", name: "Test", aliases: [], root: workspace }],
  })}\n`, { mode: 0o600 });
  await writeFile(profileInstructions, "# Foursday\nWork from evidence.\n", { mode: 0o600 });
  await writeFile(projectSkill, "# Project work\nRead and verify.\n", { mode: 0o600 });
  await writeFile(join(codexHome, "config.toml"), foursdayCodexConfig({
    nodePath: process.execPath,
    mcpPath: fileURLToPath(new URL("../src/foursday-codex-mcp.mjs", import.meta.url)),
    dwsPath: process.execPath,
    dwsHome: root,
  }), { mode: 0o600 });
  await writeFile(join(codexHome, "rules", "foursday.rules"), foursdayCodexRules(), { mode: 0o600 });
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../src/foursday-codex-proxy.mjs", import.meta.url)),
    "app-server",
  ], {
    env: {
      ...process.env,
      FOURSDAY_CODEX_PATH: codex,
      CODEX_HOME: codexHome,
      FOURSDAY_PROJECT_REGISTRY: registry,
      FOURSDAY_FALLBACK_WORKSPACE: fallback,
      FOURSDAY_PROFILE_INSTRUCTIONS_FILE: profileInstructions,
      FOURSDAY_PROJECT_SKILL_FILE: projectSkill,
      FOURSDAY_REQUIRE_WORK_CONTEXT: "false",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode == null) child.kill("SIGTERM");
    await closed;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id != null && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const request = (id, method, params = {}) => new Promise((accept, reject) => {
    pending.set(id, accept);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref();
  });
  const initialized = await request(1, "initialize", {
    clientInfo: { name: "foursday-test", title: "Foursday Test", version: "0.1" },
  });
  assert.equal(initialized.error, undefined);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
  const started = await request(2, "thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "dangerFullAccess",
  });
  assert.equal(started.error, undefined);
  assert.equal(started.result.cwd, workspace);
  assert.equal(started.result.approvalPolicy, "untrusted");
  assert.match(String(started.result.approvalsReviewer), /auto.?review/iu);
  assert.equal(started.result.sandbox.type, "workspaceWrite");
  assert.equal(started.result.sandbox.networkAccess, false);
  assert.equal(started.result.activePermissionProfile.id, "foursday-workspace");
  child.stdin.end();
  child.kill("SIGTERM");
  await closed;
});

test("proxy resumes the bound Codex thread after a fresh Hermes app-server process", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-resume-proxy-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const fallback = join(root, "fallback");
  const codexHome = join(root, "codex");
  const registry = join(root, "projects.json");
  const profileInstructions = join(root, "SOUL.md");
  const projectSkill = join(root, "project-work.md");
  const contextPath = join(root, "contexts.json");
  const bindingRoot = join(root, "bindings");
  const fakeLog = join(root, "fake-codex.jsonl");
  const fakeCodex = join(root, "fake-codex.mjs");
  await Promise.all([
    mkdir(workspace, { mode: 0o700 }),
    mkdir(fallback, { mode: 0o700 }),
    mkdir(join(codexHome, "rules"), { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(registry, `${JSON.stringify({
    schemaVersion: 1,
    projects: [{ id: "test", name: "Test", aliases: [], root: workspace }],
  })}\n`, { mode: 0o600 });
  await writeFile(profileInstructions, "# Foursday\nWork from evidence.\n", { mode: 0o600 });
  await writeFile(projectSkill, "# Project work\nRead and verify.\n", { mode: 0o600 });
  await writeFile(fakeCodex, [
    `#!${process.execPath}`,
    'import fs from "node:fs";',
    'import readline from "node:readline";',
    `const log = ${JSON.stringify(fakeLog)};`,
    'const temporaryThread = `temporary-${process.pid}`;',
    'const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'for await (const line of lines) {',
    '  const message = JSON.parse(line);',
    '  if (message.id == null) continue;',
    '  const threadId = message.params?.threadId ?? null;',
    '  fs.appendFileSync(log, JSON.stringify({ method: message.method, threadId }) + "\\n");',
    '  let result = {};',
    '  if (message.method === "thread/start") result = { thread: { id: temporaryThread } };',
    '  if (message.method === "thread/resume") result = { thread: { id: threadId } };',
    '  if (message.method === "thread/fork") result = { thread: { id: `fork-${process.pid}` } };',
    '  if (message.method === "turn/start") result = { threadId, turn: { id: `turn-${process.pid}` } };',
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
    '}',
    '',
  ].join("\n"), { mode: 0o700 });
  await chmod(fakeCodex, 0o700);

  const writeContext = async (token) => {
    await writeFile(contextPath, `${JSON.stringify({
      schemaVersion: 1,
      contexts: {
        [token]: {
          projectId: "test",
          workspace,
          projectContext: "Project test",
          memoryContext: "",
          sourcePrincipalHandle: "d".repeat(64),
          sourceSessionHash: "e".repeat(64),
          hermesSessionHash: "a".repeat(64),
          hermesTurnHash: "b".repeat(64),
          sourcePrincipalHash: "c".repeat(64),
          sourceScope: "direct",
          requesterRole: "owner",
          providedDingtalkSources: [],
          platform: "dws_personal",
          ownerRevision: 0,
          sendGeneration: 0,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
        },
      },
    })}\n`, { mode: 0o600 });
  };

  const runOnce = async (token, baseId, { fork = false } = {}) => {
    await writeContext(token);
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../src/foursday-codex-proxy.mjs", import.meta.url)),
      "app-server",
    ], {
      env: {
        ...process.env,
        FOURSDAY_CODEX_PATH: fakeCodex,
        CODEX_HOME: codexHome,
        FOURSDAY_PROJECT_REGISTRY: registry,
        FOURSDAY_FALLBACK_WORKSPACE: fallback,
        FOURSDAY_PROFILE_INSTRUCTIONS_FILE: profileInstructions,
        FOURSDAY_PROJECT_SKILL_FILE: projectSkill,
        FOURSDAY_WORK_CONTEXT_FILE: contextPath,
        FOURSDAY_THREAD_BINDINGS_ROOT: bindingRoot,
        FOURSDAY_REQUIRE_WORK_CONTEXT: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map();
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id != null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const request = (id, method, params = {}) => new Promise((accept, reject) => {
      pending.set(id, accept);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 5_000).unref();
    });
    await request(baseId, "initialize", { clientInfo: { name: "test", version: "1" } });
    const started = await request(baseId + 1, "thread/start", { cwd: workspace });
    const alias = started.result.thread.id;
    const turn = await request(baseId + 2, "turn/start", {
      threadId: alias,
      cwd: workspace,
      input: [{ type: "text", text: `continue\n\n<!-- foursday-context:${token} -->` }],
    });
    const forked = fork
      ? await request(baseId + 3, "thread/fork", {
          threadId: alias,
          cwd: workspace,
          path: "/tmp/attacker-rollout.jsonl",
          model: "attacker-model",
          permissions: ":danger-full-access",
        })
      : null;
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0);
    return { alias, turn, forked };
  };

  const first = await runOnce(`fctx_${"1".repeat(64)}`, 10, { fork: true });
  const second = await runOnce(`fctx_${"2".repeat(64)}`, 20);
  assert.notEqual(first.alias, second.alias);
  assert.equal(first.turn.result.threadId, first.alias);
  assert.equal(second.turn.result.threadId, second.alias);
  assert.match(first.forked.result.thread.id, /^fork-/u);
  const calls = (await readFile(fakeLog, "utf8")).trim().split("\n").map(JSON.parse);
  const resume = calls.find((call) => call.method === "thread/resume");
  assert.equal(resume.threadId, first.alias);
  const turns = calls.filter((call) => call.method === "turn/start");
  assert.equal(turns[0].threadId, first.alias);
  assert.equal(turns[1].threadId, first.alias);
  const fork = calls.find((call) => call.method === "thread/fork");
  assert.equal(fork.threadId, first.alias);
  const bindingFiles = await import("node:fs/promises").then(({ readdir }) => readdir(bindingRoot));
  const bindingFile = bindingFiles.find((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  const binding = JSON.parse(await readFile(join(bindingRoot, bindingFile), "utf8"));
  assert.equal(binding.forkThreadIds.length, 1);
  assert.match(binding.forkThreadIds[0], /^fork-/u);
});
