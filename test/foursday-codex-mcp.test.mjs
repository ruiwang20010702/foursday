import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  callFoursdayCodexTool,
  handleFoursdayMcpRequest,
  listFoursdayAttachments,
  readFoursdayProjectMemory,
  readFoursdayRuntimeStatus,
} from "../src/foursday-codex-mcp.mjs";

async function fixture(t, {
  expiresAt = Math.floor(Date.now() / 1000) + 60,
  sourceScope = "direct",
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "foursday-codex-mcp-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = `fctx_${"a".repeat(64)}`;
  const contextPath = join(root, "contexts.json");
  const attachmentPath = join(root, "source-report.csv");
  await writeFile(attachmentPath, "batch,passed\nA,42\n", { mode: 0o600 });
  await writeFile(contextPath, `${JSON.stringify({
    schemaVersion: 1,
    contexts: {
      [token]: {
        projectId: "example",
        workspace: root,
        projectContext: "Project: Example",
        memoryContext: "Personal gbrain fact",
        sourcePrincipalHandle: "d".repeat(64),
        sourceSessionHash: "b".repeat(64),
        sourceScope,
        attachments: [{
          path: attachmentPath,
          name: "生产 汇总.csv",
          mimeType: "text/csv",
        }],
        expiresAt,
      },
    },
  })}\n`, { mode: 0o600 });
  await writeFile(join(root, "projects.json"), `${JSON.stringify({
    schemaVersion: 1,
    projects: [{
      id: "example",
      name: "Example",
      aliases: [],
      root,
      gbrainSlugs: ["projects/example"],
    }],
  })}\n`, { mode: 0o600 });
  await writeFile(join(root, "foursday-release.json"), `${JSON.stringify({
    schema: "foursday-profile-release/v1",
    foursdayVersion: "0.8.0-rc.1",
    foursdayCommit: "e".repeat(40),
  })}\n`, { mode: 0o600 });
  await writeFile(join(root, "dws.json"), `${JSON.stringify({
    lastFullSuccessAt: new Date(Date.now() - 1_000).toISOString(),
    lastErrorCount: 0,
    sendBlocked: false,
    eventWake: { ready: true },
  })}\n`, { mode: 0o600 });
  return {
    root,
    token,
    contextPath,
    attachmentPath,
    environment: {
      FOURSDAY_WORK_CONTEXT_FILE: contextPath,
      FOURSDAY_PRODUCTION_CONFIG: join(root, "production.json"),
      FOURSDAY_PROJECT_REGISTRY: join(root, "projects.json"),
      FOURSDAY_PROFILE_RELEASE_FILE: join(root, "foursday-release.json"),
      FOURSDAY_RELEASE_SHA: "e".repeat(40),
      FOURSDAY_MODE: "active",
      DWS_PERSONAL_SEND_ENABLED: "true",
      DWS_PERSONAL_FALLBACK_MS: "30000",
      DWS_PERSONAL_STATE_FILE: join(root, "dws.json"),
    },
  };
}

function input(contextToken) {
  return {
    contextToken,
    type: "atom",
    factKey: "project.verified_fact",
    title: "Verified fact",
    statement: "The current workspace proves this fact.",
    sensitivity: "internal",
    confidence: 0.99,
    evidence: [{
      relativePath: "README.md",
      contentSha256: "c".repeat(64),
      description: "Current project evidence",
    }],
  };
}

test("Codex MCP advertises bounded memory, attachment and live-status tools", async () => {
  const initialized = await handleFoursdayMcpRequest({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" },
  });
  assert.equal(initialized.result.serverInfo.name, "foursday");
  const listed = await handleFoursdayMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    "foursday_remember_project_fact",
    "foursday_list_attachments",
    "foursday_stage_attachment",
    "foursday_read_project_memory",
    "foursday_runtime_status",
  ]);
  assert.ok(listed.result.tools[0].inputSchema.required.includes("contextToken"));
  assert.deepEqual(listed.result.tools.map((tool) => tool.annotations.readOnlyHint), [
    false, true, false, true, true,
  ]);
  assert.equal(listed.result.tools.every((tool) => tool.annotations.destructiveHint === false), true);
  assert.equal(listed.result.tools.every((tool) => tool.annotations.idempotentHint === true), true);
  assert.deepEqual(listed.result.tools.map((tool) => tool.annotations.openWorldHint), [
    true, false, false, true, false,
  ]);

  const ping = await handleFoursdayMcpRequest({ jsonrpc: "2.0", id: 21, method: "ping" });
  assert.deepEqual(ping.result, {});
});

test("runtime status tool reads live Profile state instead of project memory", async (t) => {
  const value = await fixture(t);
  const now = Date.now();
  const result = await readFoursdayRuntimeStatus(
    { contextToken: value.token },
    { environment: value.environment, cwd: value.root, now },
  );
  assert.equal(result.source, "live_profile");
  assert.equal(result.version, "0.8.0-rc.1");
  assert.equal(result.releaseSha, "e".repeat(40));
  assert.equal(result.mode, "active");
  assert.equal(result.sendEnabled, true);
  assert.equal(result.sendBlocked, false);
  assert.equal(result.checkpointHealthy, true);
  assert.equal(result.checkpointState, "healthy");
  assert.equal(result.checkpointBusy, false);
  assert.equal(result.checkpointGeneration, 0);
  assert.equal(result.checkpointOperation, null);
  assert.equal(result.eventWakeReady, true);

  const called = await handleFoursdayMcpRequest({
    jsonrpc: "2.0", id: 20, method: "tools/call",
    params: { name: "foursday_runtime_status", arguments: { contextToken: value.token } },
  }, { environment: value.environment, cwd: value.root, now });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.mode, "active");
});

test("runtime status tool projects a bounded DWS queue wait without marking it stale", async (t) => {
  const value = await fixture(t);
  const baseline = Date.now();
  await writeFile(join(value.root, "dws.json"), `${JSON.stringify({
    lastFullSuccessAt: new Date(baseline - 70_000).toISOString(),
    lastErrorCount: 0,
    sendBlocked: false,
    eventWake: { ready: true },
    checkLifecycle: {
      status: "running",
      generation: 8,
      operation: "history_check",
      wakeSource: "fallback",
      startedAt: new Date(baseline - 70_000).toISOString(),
      completedAt: null,
      errorCount: 0,
    },
  })}\n`, { mode: 0o600 });
  const result = await readFoursdayRuntimeStatus(
    { contextToken: value.token },
    { environment: value.environment, cwd: value.root, now: baseline },
  );
  assert.equal(result.checkpointState, "busy_but_bounded");
  assert.equal(result.checkpointHealthy, true);
  assert.equal(result.checkpointBusy, true);
  assert.equal(result.checkpointGeneration, 8);
  assert.equal(result.checkpointOperation, "history_check");
});

test("attachment tools hide host paths and stage exact bytes inside the routed workspace", async (t) => {
  const value = await fixture(t);
  const listed = await handleFoursdayMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "foursday_list_attachments",
      arguments: { contextToken: value.token },
    },
  }, { environment: value.environment, cwd: value.root });
  assert.equal(listed.result.isError, false);
  assert.equal(listed.result.structuredContent.attachments[0].name, "生产 汇总.csv");
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(value.root.replaceAll("/", "\\/"), "u"));

  const staged = await handleFoursdayMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "foursday_stage_attachment",
      arguments: { contextToken: value.token, attachmentIndex: 0 },
    },
  }, { environment: value.environment, cwd: value.root });
  assert.equal(staged.result.isError, false);
  const result = staged.result.structuredContent;
  assert.match(result.relativePath, /^\.foursday-inbox\//u);
  assert.equal(result.commitAllowed, false);
  assert.equal(await readFile(join(value.root, result.relativePath), "utf8"), "batch,passed\nA,42\n");
  assert.equal((await lstat(join(value.root, result.relativePath))).mode & 0o077, 0);

  const repeated = await handleFoursdayMcpRequest({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: {
      name: "foursday_stage_attachment",
      arguments: { contextToken: value.token, attachmentIndex: 0 },
    },
  }, { environment: value.environment, cwd: value.root });
  assert.equal(repeated.result.structuredContent.relativePath, result.relativePath);
});

test("attachment staging rejects a pre-created symlink destination", async (t) => {
  const value = await fixture(t);
  const inbox = join(value.root, ".foursday-inbox");
  await mkdir(inbox, { mode: 0o700 });
  const outside = join(value.root, "outside.txt");
  await writeFile(outside, "do not follow\n", { mode: 0o600 });
  const digest = createHash("sha256").update("batch,passed\nA,42\n").digest("hex");
  await symlink(outside, join(inbox, `${digest.slice(0, 16)}-生产-汇总.csv`));
  const result = await handleFoursdayMcpRequest({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: {
      name: "foursday_stage_attachment",
      arguments: { contextToken: value.token, attachmentIndex: 0 },
    },
  }, { environment: value.environment, cwd: value.root });
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.error, "attachment_stage_conflict");
  assert.equal(await readFile(outside, "utf8"), "do not follow\n");
});

test("memory tool binds project, requester and session outside model-controlled arguments", async (t) => {
  const value = await fixture(t);
  let admitted;
  const result = await callFoursdayCodexTool(input(value.token), {
    environment: value.environment,
    cwd: value.root,
    admit: async (candidate, options) => {
      admitted = { candidate, options };
      return {
        accepted: true,
        status: "proposed",
        projectId: candidate.projectId,
        automaticPromotionQueued: true,
      };
    },
  });
  assert.equal(result.accepted, true);
  assert.equal(admitted.candidate.projectId, "example");
  assert.equal(admitted.candidate.sourcePrincipalId, "d".repeat(64));
  assert.equal(admitted.candidate.sourceSessionHash, "b".repeat(64));
  assert.equal("contextToken" in admitted.candidate, false);
  assert.equal(admitted.options.configPath, value.environment.FOURSDAY_PRODUCTION_CONFIG);
  assert.doesNotMatch(JSON.stringify(result), /trusted-user|fctx_|dddddddd/u);
});

test("MCP authorization is layered by verified direct, group and cron scope", async (t) => {
  const group = await fixture(t, { sourceScope: "group" });
  const attachments = await listFoursdayAttachments(
    { contextToken: group.token },
    { environment: group.environment, cwd: group.root },
  );
  assert.equal(attachments.attachments.length, 1);
  await assert.rejects(
    callFoursdayCodexTool(input(group.token), {
      environment: group.environment,
      cwd: group.root,
      admit: async () => { throw new Error("must not reach admission"); },
    }),
    /mcp_scope_denied/u,
  );

  const cron = await fixture(t, { sourceScope: "cron" });
  await assert.rejects(
    listFoursdayAttachments(
      { contextToken: cron.token },
      { environment: cron.environment, cwd: cron.root },
    ),
    /mcp_scope_denied/u,
  );
  let requested;
  const memory = await readFoursdayProjectMemory(
    { contextToken: cron.token },
    {
      environment: cron.environment,
      cwd: cron.root,
      createClient: async ({ configPath }) => {
        assert.equal(configPath, cron.environment.FOURSDAY_PRODUCTION_CONFIG);
        return { id: "read-only-client" };
      },
      readMemory: async (options) => {
        requested = options;
        return {
          available: true,
          pages: [{ slug: "projects/example", title: "Example", content: "Stable context" }],
        };
      },
    },
  );
  assert.deepEqual(requested.slugs, ["projects/example"]);
  assert.equal(requested.maxTotalBytes, 12 * 1024);
  assert.equal(memory.sourceId, "default");
  assert.equal(memory.readOnly, true);
});

test("project memory reuses one verified read-only client inside the MCP process", async (t) => {
  const value = await fixture(t);
  const cache = new Map();
  let created = 0;
  const options = {
    environment: value.environment,
    cwd: value.root,
    clientCache: cache,
    createClient: async () => {
      created += 1;
      return { id: "cached-read-only-client" };
    },
    readMemory: async ({ client }) => ({
      available: true,
      pages: [{ slug: "projects/example", title: client.id, content: "Stable context" }],
    }),
  };
  const [first, second] = await Promise.all([
    readFoursdayProjectMemory({ contextToken: value.token }, options),
    readFoursdayProjectMemory({ contextToken: value.token }, options),
  ]);
  assert.equal(created, 1);
  assert.equal(first.pages[0].title, "cached-read-only-client");
  assert.deepEqual(second, first);
});

test("expired, wrong-workspace and broadly-readable work contexts fail closed", async (t) => {
  const expired = await fixture(t, { expiresAt: 1 });
  await assert.rejects(callFoursdayCodexTool(input(expired.token), {
    environment: expired.environment,
    cwd: expired.root,
  }), /work_context_expired/u);

  const current = await fixture(t);
  const other = await realpath(await mkdtemp(join(tmpdir(), "foursday-codex-other-")));
  t.after(() => rm(other, { recursive: true, force: true }));
  await assert.rejects(callFoursdayCodexTool(input(current.token), {
    environment: current.environment,
    cwd: other,
  }), /workspace_mismatch/u);

  await chmod(current.contextPath, 0o644);
  await assert.rejects(callFoursdayCodexTool(input(current.token), {
    environment: current.environment,
    cwd: current.root,
  }), /work_context_unavailable/u);

  const linked = await fixture(t);
  const linkPath = join(linked.root, "linked-contexts.json");
  await symlink(linked.contextPath, linkPath);
  await assert.rejects(callFoursdayCodexTool(input(linked.token), {
    environment: { ...linked.environment, FOURSDAY_WORK_CONTEXT_FILE: linkPath },
    cwd: linked.root,
  }), /work_context_unavailable/u);
});
