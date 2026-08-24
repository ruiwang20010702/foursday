#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { admitHermesMemoryCandidate } from "./hermes-memory-candidate-sidecar.mjs";
import {
  createHermesPersonalMemoryClient,
  readHermesProjectMemoryContext,
} from "./hermes-personal-memory-context.mjs";
import {
  foursdayContextTokenPattern,
  loadFoursdayWorkContext,
} from "./foursday-work-context.mjs";
import { isMainModule } from "./main-module.mjs";

const toolName = "foursday_remember_project_fact";
const listAttachmentsToolName = "foursday_list_attachments";
const stageAttachmentToolName = "foursday_stage_attachment";
const readProjectMemoryToolName = "foursday_read_project_memory";

export const foursdayCodexTool = Object.freeze({
  name: toolName,
  description: "Queue one verified, low-risk project fact for the owner's personal gbrain.",
  inputSchema: {
    type: "object",
    properties: {
      contextToken: { type: "string", description: "Opaque Foursday token from the current message context." },
      type: { type: "string", enum: ["atom", "prospective", "source"] },
      factKey: { type: "string" },
      title: { type: "string" },
      statement: { type: "string" },
      sensitivity: { type: "string", enum: ["public", "internal"] },
      confidence: { type: "number", minimum: 0.97, maximum: 1 },
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            relativePath: { type: "string" },
            contentSha256: { type: "string" },
            description: { type: "string" },
          },
          required: ["relativePath", "contentSha256", "description"],
          additionalProperties: false,
        },
      },
    },
    required: [
      "contextToken", "type", "factKey", "title", "statement",
      "sensitivity", "confidence", "evidence",
    ],
    additionalProperties: false,
  },
});

export const foursdayListAttachmentsTool = Object.freeze({
  name: listAttachmentsToolName,
  description: "List the current DWS message attachments without exposing host paths.",
  inputSchema: {
    type: "object",
    properties: {
      contextToken: { type: "string", description: "Opaque Foursday token from the current message context." },
    },
    required: ["contextToken"],
    additionalProperties: false,
  },
});

export const foursdayStageAttachmentTool = Object.freeze({
  name: stageAttachmentToolName,
  description: "Copy one current DWS attachment into the routed project .foursday-inbox for local Codex/Python inspection.",
  inputSchema: {
    type: "object",
    properties: {
      contextToken: { type: "string", description: "Opaque Foursday token from the current message context." },
      attachmentIndex: { type: "integer", minimum: 0, maximum: 7 },
    },
    required: ["contextToken", "attachmentIndex"],
    additionalProperties: false,
  },
});

export const foursdayReadProjectMemoryTool = Object.freeze({
  name: readProjectMemoryToolName,
  description: "Read only the personal-gbrain pages registered for the current routed project.",
  inputSchema: {
    type: "object",
    properties: {
      contextToken: { type: "string", description: "Opaque Foursday token from the current message context." },
    },
    required: ["contextToken"],
    additionalProperties: false,
  },
});

async function attachmentContext(input, { environment, cwd, now }) {
  if (!foursdayContextTokenPattern.test(String(input?.contextToken ?? ""))) {
    throw new Error("work_context_invalid");
  }
  const contextPath = environment.FOURSDAY_WORK_CONTEXT_FILE;
  if (!contextPath) throw new Error("foursday_mcp_unconfigured");
  return loadFoursdayWorkContext({ path: contextPath, token: input.contextToken, cwd, now });
}

export async function listFoursdayAttachments(input, {
  environment = process.env,
  cwd = process.cwd(),
  now = Date.now(),
} = {}) {
  const context = await attachmentContext(input, { environment, cwd, now });
  if (!["direct", "group"].includes(context.sourceScope)) {
    throw new Error("work_context_mcp_scope_denied");
  }
  return {
    projectId: context.projectId,
    attachments: context.attachments.map((item, attachmentIndex) => ({
      attachmentIndex,
      name: item.name || `attachment-${attachmentIndex + 1}`,
      mimeType: item.mimeType || "application/octet-stream",
      size: item.size,
      imageAlreadyAttached: item.isImage,
    })),
  };
}

function safeAttachmentName(value, index) {
  const candidate = basename(String(value ?? "")).normalize("NFKC")
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 100);
  return candidate && candidate !== "." && candidate !== ".."
    ? candidate
    : `attachment-${index + 1}.bin`;
}

export async function stageFoursdayAttachment(input, {
  environment = process.env,
  cwd = process.cwd(),
  now = Date.now(),
} = {}) {
  if (!Number.isSafeInteger(input?.attachmentIndex) || input.attachmentIndex < 0 || input.attachmentIndex > 7) {
    throw new Error("attachment_index_invalid");
  }
  const context = await attachmentContext(input, { environment, cwd, now });
  if (!["direct", "group"].includes(context.sourceScope)) {
    throw new Error("work_context_mcp_scope_denied");
  }
  const source = context.attachments[input.attachmentIndex];
  if (!source) throw new Error("attachment_not_found");
  const workspace = await realpath(context.workspace);
  const inbox = join(workspace, ".foursday-inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await chmod(inbox, 0o700);
  const inboxMetadata = await lstat(inbox);
  const canonicalInbox = await realpath(inbox);
  if (
    !inboxMetadata.isDirectory() || inboxMetadata.isSymbolicLink() ||
    (inboxMetadata.mode & 0o077) !== 0 ||
    !(canonicalInbox === workspace || canonicalInbox.startsWith(`${workspace}${sep}`))
  ) throw new Error("attachment_inbox_unsafe");
  const sourceHandle = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const sourceMetadata = await sourceHandle.stat();
    if (!sourceMetadata.isFile() || sourceMetadata.size < 1 || sourceMetadata.size > 128 * 1024 * 1024) {
      throw new Error("attachment_rejected");
    }
    bytes = await sourceHandle.readFile();
  } finally {
    await sourceHandle.close();
  }
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const name = safeAttachmentName(source.name, input.attachmentIndex);
  const destination = resolve(canonicalInbox, `${contentSha256.slice(0, 16)}-${name}`);
  if (!destination.startsWith(`${canonicalInbox}${sep}`)) throw new Error("attachment_inbox_unsafe");
  try {
    await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const destinationMetadata = await lstat(destination);
    if (!destinationMetadata.isFile() || destinationMetadata.isSymbolicLink()) {
      throw new Error("attachment_stage_conflict");
    }
    if (await realpath(destination) !== destination) throw new Error("attachment_stage_conflict");
    const existing = await readFile(destination);
    if (createHash("sha256").update(existing).digest("hex") !== contentSha256) {
      throw new Error("attachment_stage_conflict");
    }
  }
  await chmod(destination, 0o600);
  return {
    projectId: context.projectId,
    attachmentIndex: input.attachmentIndex,
    relativePath: relative(workspace, destination),
    name,
    mimeType: source.mimeType || "application/octet-stream",
    size: bytes.length,
    contentSha256,
    temporaryWorkspaceArtifact: true,
    commitAllowed: false,
  };
}

async function registeredProjectMemorySlugs(path, projectId) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) {
      throw new Error("project_memory_unavailable");
    }
    const registry = JSON.parse(await handle.readFile("utf8"));
    const projects = registry?.schemaVersion === 1 && Array.isArray(registry.projects)
      ? registry.projects
      : null;
    if (!projects || projects.length > 1_000) throw new Error("project_memory_unavailable");
    const project = projects.find((item) => item?.id === projectId);
    if (!project || !Array.isArray(project.gbrainSlugs) || project.gbrainSlugs.length > 20) {
      throw new Error("project_memory_unavailable");
    }
    return project.gbrainSlugs;
  } finally {
    await handle.close();
  }
}

export async function readFoursdayProjectMemory(input, {
  environment = process.env,
  cwd = process.cwd(),
  now = Date.now(),
  createClient = createHermesPersonalMemoryClient,
  readMemory = readHermesProjectMemoryContext,
} = {}) {
  const context = await attachmentContext(input, { environment, cwd, now });
  const registryPath = environment.FOURSDAY_PROJECT_REGISTRY;
  const configPath = environment.FOURSDAY_PRODUCTION_CONFIG;
  if (!registryPath || !configPath) throw new Error("foursday_mcp_unconfigured");
  const slugs = await registeredProjectMemorySlugs(registryPath, context.projectId);
  const client = await createClient({ configPath });
  const result = await readMemory({ client, slugs, maxTotalBytes: 12 * 1024 });
  return {
    projectId: context.projectId,
    available: result.available === true,
    sourceId: "default",
    readOnly: true,
    pages: Array.isArray(result.pages) ? result.pages : [],
  };
}

export async function callFoursdayCodexTool(input, {
  environment = process.env,
  cwd = process.cwd(),
  now = Date.now(),
  admit = admitHermesMemoryCandidate,
} = {}) {
  const contextPath = environment.FOURSDAY_WORK_CONTEXT_FILE;
  const configPath = environment.FOURSDAY_PRODUCTION_CONFIG;
  const registryPath = environment.FOURSDAY_PROJECT_REGISTRY;
  if (!contextPath || !configPath || !registryPath) throw new Error("foursday_mcp_unconfigured");
  if (!foursdayContextTokenPattern.test(String(input?.contextToken ?? ""))) {
    throw new Error("work_context_invalid");
  }
  const context = await loadFoursdayWorkContext({
    path: contextPath,
    token: input.contextToken,
    cwd,
    now,
  });
  if (context.sourceScope !== "direct") throw new Error("work_context_mcp_scope_denied");
  const { contextToken: _discarded, ...candidate } = input ?? {};
  const result = await admit({
    ...candidate,
    projectId: context.projectId,
    sourceSessionHash: context.sourceSessionHash,
    sourcePrincipalId: context.sourcePrincipalHandle,
    observedAt: new Date(now).toISOString(),
  }, { configPath, registryPath, environment });
  return {
    accepted: result.accepted === true,
    status: result.status,
    projectId: result.projectId,
    automaticPromotionQueued: result.automaticPromotionQueued === true,
    personalWorktreeTouched: false,
  };
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleFoursdayMcpRequest(request, options = {}) {
  if (!request || request.jsonrpc !== "2.0") return errorResponse(request?.id ?? null, -32600, "Invalid request");
  if (request.method === "initialize") {
    return response(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "foursday", version: "0.1.0" },
    });
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "tools/list") {
    return response(request.id, {
      tools: [
        foursdayCodexTool,
        foursdayListAttachmentsTool,
        foursdayStageAttachmentTool,
        foursdayReadProjectMemoryTool,
      ],
    });
  }
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (![toolName, listAttachmentsToolName, stageAttachmentToolName, readProjectMemoryToolName].includes(name)) {
      return errorResponse(request.id, -32601, "Unknown tool");
    }
    try {
      const result = name === toolName
        ? await callFoursdayCodexTool(request.params?.arguments, options)
        : name === listAttachmentsToolName
          ? await listFoursdayAttachments(request.params?.arguments, options)
          : name === stageAttachmentToolName
            ? await stageFoursdayAttachment(request.params?.arguments, options)
            : await readFoursdayProjectMemory(request.params?.arguments, options);
      return response(request.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error) {
      const knownErrors = new Set([
        "work_context_invalid",
        "work_context_unavailable",
        "work_context_expired",
        "work_context_workspace_mismatch",
        "work_context_scope_invalid",
        "work_context_mcp_scope_denied",
        "work_context_attachments_invalid",
        "foursday_mcp_unconfigured",
        "attachment_index_invalid",
        "attachment_not_found",
        "attachment_inbox_unsafe",
        "attachment_stage_conflict",
        "project_memory_unavailable",
      ]);
      const candidate = String(error?.message ?? "");
      const code = knownErrors.has(candidate)
        ? candidate
        : name === toolName
          ? "memory_candidate_rejected"
          : name === readProjectMemoryToolName
            ? "project_memory_unavailable"
            : "attachment_rejected";
      return response(request.id, {
        content: [{ type: "text", text: JSON.stringify({ accepted: false, error: code }) }],
        structuredContent: { accepted: false, error: code },
        isError: true,
      });
    }
  }
  return errorResponse(request.id ?? null, -32601, "Method not found");
}

async function runStdio() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let output;
    try {
      output = await handleFoursdayMcpRequest(JSON.parse(line));
    } catch {
      output = errorResponse(null, -32700, "Parse error");
    }
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

if (isMainModule(import.meta.url)) await runStdio();
