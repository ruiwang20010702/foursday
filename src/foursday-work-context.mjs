import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

export const foursdayContextTokenPattern = /^fctx_[a-f0-9]{64}$/u;
const providedSourceId = /^provided_[1-4]$/u;
const dingtalkNodeId = /^[A-Za-z0-9]{20,80}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

function validProjectGbrainSlug(value) {
  const slug = String(value ?? "");
  return /^projects\/[A-Za-z0-9._/-]{1,291}$/u.test(slug) &&
    !slug.includes("//") && !slug.split("/").includes("..");
}

export async function loadFoursdayWorkContext({ path, token, cwd, now = Date.now() } = {}) {
  if (!foursdayContextTokenPattern.test(String(token ?? ""))) {
    throw new Error("work_context_invalid");
  }
  const absolute = resolve(path);
  if (await realpath(absolute) !== absolute) throw new Error("work_context_unavailable");
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let content;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024) {
      throw new Error("work_context_unavailable");
    }
    content = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const document = JSON.parse(content);
  const context = document?.schemaVersion === 1 ? document.contexts?.[token] : null;
  if (
    !context ||
    typeof context.projectId !== "string" ||
    typeof context.workspace !== "string" ||
    typeof context.projectContext !== "string" || context.projectContext.length > 8_000 ||
    typeof context.memoryContext !== "string" || context.memoryContext.length > 16_000 ||
    !/^[a-f0-9]{64}$/u.test(String(context.sourcePrincipalHandle ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(context.sourceSessionHash ?? "")) ||
    !Number.isSafeInteger(context.expiresAt) ||
    context.expiresAt * 1000 <= now
  ) throw new Error("work_context_expired");
  const primaryScopeId = context.primaryScopeId == null
    ? (context.projectId === "shared_link" ? null : context.projectId)
    : String(context.primaryScopeId);
  const relatedScopeIds = context.relatedScopeIds ?? [];
  const relatedGbrainSlugs = context.relatedGbrainSlugs ?? [];
  if (
    (primaryScopeId != null && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(primaryScopeId)) ||
    !Array.isArray(relatedScopeIds) || relatedScopeIds.length > 8 ||
    relatedScopeIds.some((value) =>
      !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(String(value)) || value === primaryScopeId
    ) ||
    !Array.isArray(relatedGbrainSlugs) || relatedGbrainSlugs.length > 12 ||
    relatedGbrainSlugs.some((value) => !validProjectGbrainSlug(value))
  ) throw new Error("work_context_scope_graph_invalid");
  if (!["direct", "group", "cron"].includes(context.sourceScope)) {
    throw new Error("work_context_scope_invalid");
  }
  if (
    !["owner", "trusted", "system"].includes(context.requesterRole) ||
    (context.sourceScope === "cron") !== (context.requesterRole === "system")
  ) throw new Error("work_context_requester_invalid");
  const responseDuty = context.responseDuty ?? {
    decision: "action_required",
    source: "availability_fallback",
    confidence: 0,
  };
  if (
    !responseDuty || typeof responseDuty !== "object" || Array.isArray(responseDuty) ||
    !["action_required", "no_text_reply"].includes(responseDuty.decision) ||
    !["codex", "availability_fallback"].includes(responseDuty.source) ||
    !Number.isFinite(responseDuty.confidence) ||
    responseDuty.confidence < 0 || responseDuty.confidence > 1
  ) throw new Error("work_context_response_duty_invalid");
  const rawProvidedSources = context.providedDingtalkSources ?? [];
  if (
    !Array.isArray(rawProvidedSources) || rawProvidedSources.length > 4 ||
    (context.sourceScope !== "direct" && rawProvidedSources.length > 0)
  ) throw new Error("work_context_project_sources_invalid");
  const providedDingtalkSources = [];
  const sourceIds = new Set();
  const nodeIds = new Set();
  for (const source of rawProvidedSources) {
    if (
      !source || typeof source !== "object" || Array.isArray(source) ||
      Object.keys(source).some((key) => ![
        "sourceId", "kind", "nodeId", "messageHash", "requesterRole",
      ].includes(key)) ||
      !providedSourceId.test(String(source.sourceId ?? "")) ||
      sourceIds.has(source.sourceId) ||
      source.kind !== "doc" ||
      !dingtalkNodeId.test(String(source.nodeId ?? "")) ||
      nodeIds.has(source.nodeId) ||
      !sha256.test(String(source.messageHash ?? "")) ||
      source.requesterRole !== context.requesterRole
    ) throw new Error("work_context_project_sources_invalid");
    sourceIds.add(source.sourceId);
    nodeIds.add(source.nodeId);
    providedDingtalkSources.push({ ...source });
  }
  const rawAttachments = context.attachments ?? [];
  if (!Array.isArray(rawAttachments) || rawAttachments.length > 8) {
    throw new Error("work_context_attachments_invalid");
  }
  const attachments = [];
  for (const item of rawAttachments) {
    if (!item || typeof item !== "object" || typeof item.path !== "string") {
      throw new Error("work_context_attachments_invalid");
    }
    const sourceMetadata = await lstat(item.path);
    if (sourceMetadata.isSymbolicLink()) throw new Error("work_context_attachments_invalid");
    const canonical = await realpath(item.path);
    const attachment = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let size;
    let header;
    try {
      const metadata = await attachment.stat();
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > 128 * 1024 * 1024) {
        throw new Error("work_context_attachments_invalid");
      }
      size = metadata.size;
      header = Buffer.alloc(Math.min(16, metadata.size));
      await attachment.read(header, 0, header.length, 0);
    } finally {
      await attachment.close();
    }
    attachments.push({
      path: canonical,
      mimeType: String(item.mimeType ?? "").slice(0, 120),
      name: String(item.name ?? "").slice(0, 255),
      size,
      isImage: (
        header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
        header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
        ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii")) ||
        (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") ||
        header.subarray(0, 2).toString("ascii") === "BM"
      ),
    });
  }
  if (
    context.ownerIntervention != null &&
    !["task_correction", "resume_requested"].includes(context.ownerIntervention)
  ) throw new Error("work_context_owner_intervention_invalid");
  const [workspace, current] = await Promise.all([
    realpath(context.workspace),
    realpath(cwd),
  ]);
  if (workspace !== current) throw new Error("work_context_workspace_mismatch");
  return {
    ...context,
    primaryScopeId,
    relatedScopeIds: [...new Set(relatedScopeIds.map(String))],
    relatedGbrainSlugs: [...new Set(relatedGbrainSlugs.map(String))],
    workspace,
    attachments,
    providedDingtalkSources,
    responseDuty: { ...responseDuty },
  };
}
