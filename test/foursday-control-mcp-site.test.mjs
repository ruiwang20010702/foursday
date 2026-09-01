import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createInterface } from "node:readline";
import test from "node:test";
import { createFoursdayControlMcpHandler } from "../src/foursday-control-mcp.mjs";
import { createFoursdayControlSite } from "../src/foursday-control-site.mjs";

function service() {
  return {
    status: async () => ({
      ready: true,
      control: { revision: 4, state: "running" },
      gateway: {
        mode: "active",
        sendEnabled: true,
        running: true,
        sendBlocked: false,
        modeConsistent: true,
        checkpointState: "busy_but_bounded",
        checkpointGeneration: 7,
      },
      taskCounts: {},
    }),
    tasks: async () => ({ revision: 4, items: [{ taskId: "a".repeat(64), projectId: "p", state: "active" }] }),
    schedules: async () => ({ items: [] }),
    memory: async () => ({
      readEnabled: true,
      fixedBindings: { projectCount: 2, pageCount: 2 },
      discovery: { enabled: true, state: "ready", projectCount: 45, truncated: false },
      projects: [],
    }),
    evidence: async () => ({ count: 2, byType: { inbound: 2 }, lastEventAt: null }),
    apply: async (input) => ({ revision: 5, result: { target: "global", state: input.action === "pause_all" ? "paused" : "running" } }),
  };
}

function requestWithHost(url, host) {
  return new Promise((accept, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => accept(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

test("control MCP reads first and applies only exact bounded control arguments", async () => {
  const handle = createFoursdayControlMcpHandler({ service: service() });
  const tools = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    "foursday_status", "foursday_tasks", "foursday_schedules",
    "foursday_memory", "foursday_evidence", "foursday_control",
  ]);
  const status = await handle({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "foursday_status", arguments: {} },
  });
  assert.equal(status.structuredContent.control.revision, 4);
  const controlled = await handle({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "foursday_control", arguments: { action: "pause_all", expectedRevision: 4 } },
  });
  assert.equal(controlled.structuredContent.revision, 5);
  await assert.rejects(handle({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "foursday_tasks", arguments: { unexpected: true } },
  }), /do not accept arguments/u);
});

test("optional status page is loopback-only, read-only and uses the same service", async (t) => {
  const site = createFoursdayControlSite({ service: service(), port: 0 });
  t.after(() => site.stop());
  const started = await site.start();
  assert.equal(started.readOnly, true);
  const page = await fetch(started.url);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /不维护第二套状态/u);
  assert.match(pageText, /只读应急状态/u);
  assert.match(pageText, /桌宠不可用或非macOS环境/u);
  assert.match(pageText, /id="pet"[^>]*hidden/u);
  assert.match(pageText, /id="drawer"[^>]*hidden/u);
  assert.match(pageText, /已暂停/u);
  assert.match(pageText, /filter\(item=>item\.enabled\)/u);
  assert.match(pageText, /DWS 检查点/u);
  assert.match(pageText, /有界检查中/u);
  assert.match(pageText, /固定/u);
  assert.match(pageText, /可发现/u);
  assert.match(pageText, /打开Foursday任务/u);
  assert.match(pageText, /现在由我负责/u);
  assert.match(pageText, /waiting_acceptance:'等待验收'/u);
  assert.match(pageText, /prefers-reduced-motion/u);
  assert.match(pageText, /taken_over:'已接管'/u);
  assert.match(pageText, /task\.state!==['"]taken_over['"]/u);
  assert.match(pageText, /status\.gateway\.sendBlocked===true/u);
  assert.match(pageText, /status\.gateway\.mode!==['"]active['"]/u);
  assert.match(pageText, /stale:stopped\?['"]未运行['"]:['"]已过期['"]/u);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/u);
  const status = await fetch(`${started.url}api/status`).then((response) => response.json());
  assert.equal(status.control.revision, 4);
  const post = await fetch(`${started.url}api/status`, { method: "POST" });
  assert.equal(post.status, 403);
  assert.equal(await requestWithHost(`${started.url}api/status`, "evil.example"), 403);
});

test("public control-mcp CLI speaks clean JSON-RPC without trailing product output", async () => {
  const child = spawn(process.execPath, ["scripts/新环境向导.mjs", "control-mcp"], {
    cwd: new URL("../", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => lines.push(line));
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" },
  })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  child.stdin.end();
  const [code] = await once(child, "close");
  assert.equal(code, 0);
  const messages = lines.map(JSON.parse);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].result.serverInfo.name, "foursday-control");
  assert.equal(messages[1].result.tools.length, 6);
});
