import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const digest = /^[a-f0-9]{64}$/u;
const sourceId = /^provided_[1-4]$/u;
const nodeId = /^[A-Za-z0-9]{20,80}$/u;
const retryDelays = [15, 30, 60, 180].map((minutes) => minutes * 60_000);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function privateJson(path, { optional = false, maximum = 1024 * 1024 } = {}) {
  if (!isAbsolute(String(path ?? ""))) {
    if (optional) return null;
    throw new Error("Foursday reconciliation source path is invalid");
  }
  const absolute = resolve(path);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > maximum ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new Error("Foursday reconciliation source is unsafe");
    const content = await handle.readFile("utf8");
    return { document: JSON.parse(content), content };
  } finally {
    await handle.close();
  }
}

function normalizedSource(value, requesterRole) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !sourceId.test(String(value.sourceId ?? "")) || value.kind !== "doc" ||
    !nodeId.test(String(value.nodeId ?? "")) || !digest.test(String(value.messageHash ?? "")) ||
    value.requesterRole !== requesterRole
  ) return null;
  return {
    sourceId: value.sourceId,
    kind: "doc",
    nodeId: value.nodeId,
    messageHash: value.messageHash,
    requesterRole,
  };
}

async function contextCandidates(path) {
  const source = await privateJson(path, { optional: true });
  const contexts = source?.document?.schemaVersion === 1 &&
    source.document.contexts && typeof source.document.contexts === "object"
    ? Object.values(source.document.contexts).slice(-64) : [];
  const candidates = new Map();
  for (const context of contexts) {
    const requesterRole = String(context?.requesterRole ?? "");
    if (
      context?.sourceScope !== "direct" || !["owner", "trusted"].includes(requesterRole) ||
      !digest.test(String(context.sourceSessionHash ?? "")) ||
      !digest.test(String(context.sourcePrincipalHash ?? ""))
    ) continue;
    const sources = [...new Map((context.providedDingtalkSources ?? [])
      .map((value) => normalizedSource(value, requesterRole))
      .filter(Boolean)
      .map((value) => [value.sourceId, value])).values()].slice(0, 4);
    if (sources.length === 0) continue;
    candidates.set(context.sourceSessionHash, {
      sourcePrincipalHash: context.sourcePrincipalHash,
      requesterRole,
      providedDingtalkSources: sources,
    });
  }
  return candidates;
}

function nextAttempt(now, attempts) {
  const index = Math.min(retryDelays.length - 1, Math.max(0, attempts - 1));
  return new Date(now.getTime() + retryDelays[index]).toISOString();
}

export function createTaskReconciliationCoordinator({
  enabled = false,
  workContextFile,
  projectRegistryFile,
  taskLedgerStore,
  controlStore,
  activeConversations,
  state,
  persist,
  emit,
  taskKey,
  now = () => new Date(),
  intervalMs = 15 * 60_000,
} = {}) {
  if (
    !(activeConversations instanceof Map) || !state || typeof persist !== "function" ||
    typeof emit !== "function" || typeof taskKey !== "function"
  ) throw new Error("Foursday task reconciliation ports are invalid");
  let running = false;
  let timer = null;

  const run = async () => {
    if (!enabled || running || !taskLedgerStore || !controlStore || !workContextFile || !projectRegistryFile) {
      return { queued: 0, skipped: true };
    }
    running = true;
    try {
      const [contexts, registry, ledger, control] = await Promise.all([
        contextCandidates(workContextFile),
        privateJson(projectRegistryFile),
        taskLedgerStore.snapshot(),
        controlStore.snapshot(),
      ]);
      const registryDigest = sha256(registry.content);
      const currentTime = now();
      const currentMs = currentTime.getTime();
      state.taskReconciliations = state.taskReconciliations ?? {};
      let queued = 0;
      for (const [taskId, contract] of Object.entries(ledger.tasks ?? {})) {
        if (queued >= 8 || contract.lifecycleState !== "escalated") continue;
        const controlTask = control.tasks?.[taskId];
        if (!controlTask || controlTask.state !== "active") continue;
        const live = [...activeConversations.entries()].find(([conversationId, active]) =>
          taskKey(conversationId, active.participantUserId) === taskId
        );
        if (!live || live[1].chatType !== "direct" || !String(live[1].sourceMessageId ?? "").trim()) continue;
        const prior = state.taskReconciliations[taskId] ?? {};
        const source = contexts.get(taskId) ?? (
          prior.sourcePrincipalHash && prior.providedDingtalkSources?.length ? prior : null
        );
        if (!source || sha256(live[1].participantUserId) !== source.sourcePrincipalHash) continue;
        const contractDigest = sha256(JSON.stringify({
          projectId: contract.projectId ?? null,
          title: contract.title ?? "",
          goal: contract.goal ?? "",
          deliverables: contract.deliverables ?? [],
          acceptanceCriteria: contract.acceptanceCriteria ?? [],
          lifecycleState: contract.lifecycleState,
          evidence: contract.evidence ?? [],
        }));
        const signature = sha256([
          registryDigest,
          taskId,
          contractDigest,
          controlTask.ownerRevision,
          controlTask.sendGeneration,
        ].join("\0"));
        const signatureChanged = prior.signature !== signature;
        const attempts = signatureChanged ? 0 : Number(prior.attemptCount ?? 0);
        const dueAt = Date.parse(prior.nextAttemptAt ?? "");
        if (!signatureChanged && (attempts >= retryDelays.length || (Number.isFinite(dueAt) && dueAt > currentMs))) {
          continue;
        }
        const nextAttempts = attempts + 1;
        state.taskReconciliations[taskId] = {
          signature,
          attemptCount: nextAttempts,
          lastAttemptAt: currentTime.toISOString(),
          nextAttemptAt: nextAttempt(currentTime, nextAttempts),
          sourcePrincipalHash: source.sourcePrincipalHash,
          requesterRole: source.requesterRole,
          providedDingtalkSources: source.providedDingtalkSources,
        };
        await persist();
        const [conversationId, active] = live;
        emit({
          type: "event",
          record: {
            id: active.sourceMessageId,
            senderUserId: active.participantUserId,
            senderOpenDingTalkId: active.participantOpenDingTalkId ?? null,
            senderName: controlTask.requester?.displayName ?? active.participantUserId,
            conversationId,
            content: [
              "Silently reconcile the existing Foursday task using the current project registry and current source access.",
              "Resume the same Codex Thread, re-read the exact provided source with accessRequired matching the original requested operation, use gbrain and the project graph to select the best primary and related work scopes, and verify the present evidence.",
              "Do not modify project files or external systems in this maintenance turn. Set the task contract to completed only when current evidence itself proves the original requested outcome already exists; otherwise keep the precise blocker and only correct the task scope.",
              "This is not a new user request. Do not ask the owner to perform routing or status cleanup, and do not send an acknowledgement or duplicate reply.",
            ].join(" "),
            createTime: currentTime.toISOString(),
            chatType: "direct",
            mentionedSelf: false,
            isSelf: false,
            enterpriseVerified: active.enterpriseVerified === true,
            attachments: [],
            ownerRevision: controlTask.ownerRevision,
            sendGeneration: controlTask.sendGeneration,
            detectedAt: currentTime.toISOString(),
            detectionLatencyMs: 0,
            wakeSource: "reconciliation",
            internalReconciliation: true,
            providedDingtalkSources: source.providedDingtalkSources,
            taskId,
          },
        });
        queued += 1;
      }
      for (const taskId of Object.keys(state.taskReconciliations)) {
        if (!ledger.tasks?.[taskId] || ledger.tasks[taskId].lifecycleState !== "escalated") {
          delete state.taskReconciliations[taskId];
        }
      }
      state.taskReconciliations = Object.fromEntries(
        Object.entries(state.taskReconciliations)
          .sort((left, right) => String(right[1].lastAttemptAt ?? "")
            .localeCompare(String(left[1].lastAttemptAt ?? "")))
          .slice(0, 64),
      );
      await persist();
      return { queued, skipped: false };
    } finally {
      running = false;
    }
  };

  return {
    run,
    start() {
      if (!enabled || timer) return;
      timer = setInterval(() => run().catch(() => {}), intervalMs);
      timer.unref?.();
      queueMicrotask(() => run().catch(() => {}));
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
