#!/usr/bin/env node
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { FoursdayControlService, controlServicePaths } from "./foursday-control-service.mjs";
import { foursdayNativeHermesLayout } from "./foursday-hermes-native-install.mjs";
import { isMainModule } from "./main-module.mjs";

export const controlToolDefinitions = Object.freeze([
  {
    name: "foursday_status",
    description: "Read the current Foursday Gateway, send mode, global control revision and task counts.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "foursday_tasks",
    description: "List privacy-safe Foursday tasks joined from control state and bound Codex Threads.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "foursday_schedules",
    description: "List Foursday Hermes Cron/Monitor schedules without prompts, scripts or private delivery targets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "foursday_memory",
    description: "Read Foursday personal-gbrain capability flags and exact registered project page slugs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "foursday_evidence",
    description: "Read aggregate, content-free Foursday shadow evidence counts and last event time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "foursday_control",
    description: "Apply one owner control action with an exact revision fence. This never enables sending, deploys, changes permissions or deletes data.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "pause_all", "resume_all", "pause_task", "communication_takeover",
            "task_correction", "task_takeover", "resume_task",
          ],
        },
        expectedRevision: { type: "integer", minimum: 0 },
        taskId: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
        note: { type: "string", maxLength: 2000 },
      },
      required: ["action", "expectedRevision"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]);

function result(structuredContent, summary) {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent,
    isError: false,
  };
}

export function createFoursdayControlMcpHandler({ service }) {
  return async function handle(request) {
    if (!request || request.jsonrpc !== "2.0") throw new Error("Invalid MCP request");
    if (request.method === "initialize") {
      return {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "foursday-control", version: "0.1.0" },
        instructions: "Foursday owner control surface. Read first, then use exact revision for reversible controls.",
      };
    }
    if (request.method === "notifications/initialized") return null;
    if (request.method === "ping") return {};
    if (request.method === "tools/list") return { tools: controlToolDefinitions };
    if (request.method !== "tools/call") throw Object.assign(new Error("Method not found"), { code: -32601 });
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    if (name !== "foursday_control" && Object.keys(args).length !== 0) {
      throw Object.assign(new Error("Read tools do not accept arguments"), { code: -32602 });
    }
    if (name === "foursday_status") return result(await service.status(), "Foursday状态已读取。");
    if (name === "foursday_tasks") {
      const value = await service.tasks();
      return result(value, `读取到${value.items.length}个Foursday任务。`);
    }
    if (name === "foursday_schedules") {
      const value = await service.schedules();
      return result(value, `读取到${value.items.length}个定时或主动任务。`);
    }
    if (name === "foursday_memory") return result(await service.memory(), "Foursday记忆边界已读取。");
    if (name === "foursday_evidence") return result(await service.evidence(), "Foursday证据摘要已读取。");
    if (name === "foursday_control") {
      const value = await service.apply({
        action: args.action,
        expectedRevision: args.expectedRevision,
        taskId: args.taskId ?? null,
        note: args.note ?? "",
      });
      return result({
        schema: "foursday-control-action/v1",
        revision: value.revision,
        ...value.result,
      }, "Foursday控制动作已写入，并由新revision保护。" );
    }
    throw Object.assign(new Error("Unknown tool"), { code: -32601 });
  };
}

function rpcResponse(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function rpcError(id, error) {
  const known = new Set([
    "foursday_control_revision_conflict",
    "foursday_control_task_not_found",
  ]);
  const message = known.has(String(error?.message)) ? String(error.message) : "Foursday control request failed";
  return { jsonrpc: "2.0", id, error: { code: error?.code ?? -32000, message } };
}

export async function runFoursdayControlMcp({
  projectRoot = fileURLToPath(new URL("../", import.meta.url)),
  environment = process.env,
} = {}) {
  const layout = foursdayNativeHermesLayout({ projectRoot });
  const service = new FoursdayControlService({
    layout,
    ...controlServicePaths({ layout, environment }),
  });
  const handle = createFoursdayControlMcpHandler({ service });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify(rpcError(null, { code: -32700 }))}\n`);
      continue;
    }
    try {
      const value = await handle(request);
      if (value != null && request.id != null) {
        process.stdout.write(`${JSON.stringify(rpcResponse(request.id, value))}\n`);
      }
    } catch (error) {
      if (request.id != null) process.stdout.write(`${JSON.stringify(rpcError(request.id, error))}\n`);
    }
  }
}

if (isMainModule(import.meta.url)) await runFoursdayControlMcp();
