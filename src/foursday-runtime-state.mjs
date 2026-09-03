import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeDwsCheckLifecycle } from "./dws-checkpoint-health.mjs";

export const enterpriseIdentityRetryDefaults = Object.freeze({
  ttlMs: 30 * 60_000,
  maxAttempts: 8,
  capacity: 128,
  perIdentityCapacity: 8,
  maximumContentBytes: 128 * 1024,
});

export function diagnosticCode(error, fallback = "error") {
  return String(error?.code ?? error?.name ?? fallback)
    .replaceAll(/[^A-Za-z0-9_.-]/gu, "_")
    .slice(0, 80) || fallback;
}

export function epoch(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function enterpriseIdentityRetryKey(messageId) {
  return createHash("sha256").update(String(messageId)).digest("hex");
}

export function responsibilityReactionKey(conversationId, messageId) {
  return createHash("sha256").update(`${conversationId}\0${messageId}`).digest("hex");
}

export function pendingOwnerReactionKey(eventId) {
  return createHash("sha256").update(String(eventId)).digest("hex");
}

export function boundedReactionValue(value, maximum = 500) {
  const output = String(value ?? "").trim();
  return output && output.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(output)
    ? output
    : null;
}

function normalizeTaskReconciliation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const attemptCount = Number(value.attemptCount);
  const lastAttemptAt = epoch(value.lastAttemptAt);
  const nextAttemptAt = epoch(value.nextAttemptAt);
  const requesterRole = String(value.requesterRole ?? "");
  const provided = Array.isArray(value.providedDingtalkSources)
    ? value.providedDingtalkSources.slice(0, 4) : [];
  if (
    !/^[a-f0-9]{64}$/u.test(String(value.signature ?? "")) ||
    !/^[a-f0-9]{64}$/u.test(String(value.sourcePrincipalHash ?? "")) ||
    !Number.isSafeInteger(attemptCount) || attemptCount < 1 || attemptCount > 4 ||
    lastAttemptAt == null || nextAttemptAt == null || nextAttemptAt < lastAttemptAt ||
    !["owner", "trusted"].includes(requesterRole) || provided.length === 0 ||
    provided.some((source) =>
      !source || typeof source !== "object" || Array.isArray(source) ||
      !/^provided_[1-4]$/u.test(String(source.sourceId ?? "")) ||
      source.kind !== "doc" || !/^[A-Za-z0-9]{20,80}$/u.test(String(source.nodeId ?? "")) ||
      !/^[a-f0-9]{64}$/u.test(String(source.messageHash ?? "")) ||
      source.requesterRole !== requesterRole
    )
  ) return null;
  return {
    signature: value.signature,
    attemptCount,
    lastAttemptAt: new Date(lastAttemptAt).toISOString(),
    nextAttemptAt: new Date(nextAttemptAt).toISOString(),
    sourcePrincipalHash: value.sourcePrincipalHash,
    requesterRole,
    providedDingtalkSources: provided.map((source) => ({
      sourceId: source.sourceId,
      kind: "doc",
      nodeId: source.nodeId,
      messageHash: source.messageHash,
      requesterRole,
    })),
  };
}

function normalizeResponsibilityReactionEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const conversationId = boundedReactionValue(value.conversationId);
  const messageId = boundedReactionValue(value.messageId);
  const reactionName = boundedReactionValue(value.reactionName, 100);
  const sourceMessageIds = Array.isArray(value.sourceMessageIds)
    ? [...new Set(value.sourceMessageIds.map((item) => boundedReactionValue(item)).filter(Boolean))]
      .slice(0, 32)
    : [];
  const ownerRevision = Number(value.ownerRevision);
  const sendGeneration = Number(value.sendGeneration);
  const status = String(value.status ?? "");
  const claimedAt = epoch(value.claimedAt);
  const clearedAt = value.clearedAt == null ? null : epoch(value.clearedAt);
  if (
    !conversationId || !messageId || !reactionName ||
    !sourceMessageIds.includes(messageId) ||
    !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
    !Number.isSafeInteger(sendGeneration) || sendGeneration < 0 ||
    ![
      "claiming", "claimed", "handled_no_reply",
      "shadow", "clearing", "cleared", "unavailable",
    ].includes(status) ||
    claimedAt == null || (value.clearedAt != null && clearedAt == null)
  ) return null;
  return {
    conversationId,
    messageId,
    sourceMessageIds,
    reactionName,
    ownerRevision,
    sendGeneration,
    status,
    claimedAt: new Date(claimedAt).toISOString(),
    clearedAt: clearedAt == null ? null : new Date(clearedAt).toISOString(),
  };
}

function normalizeReactionAutomationOp(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = boundedReactionValue(value.id, 64);
  const conversationId = boundedReactionValue(value.conversationId);
  const messageId = boundedReactionValue(value.messageId);
  const reactionName = boundedReactionValue(value.reactionName, 100);
  const action = String(value.action ?? "");
  const status = String(value.status ?? "");
  const startedAt = epoch(value.startedAt);
  const expiresAt = epoch(value.expiresAt);
  if (
    !/^[a-f0-9]{64}$/u.test(id ?? "") ||
    !conversationId || !messageId || !reactionName ||
    !["added", "removed"].includes(action) ||
    !["intent", "completed", "unknown", "failed"].includes(status) ||
    startedAt == null || expiresAt == null || expiresAt < startedAt
  ) return null;
  return {
    id,
    action,
    conversationId,
    messageId,
    reactionName,
    startedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    status,
  };
}

function normalizePendingOwnerReaction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const eventId = boundedReactionValue(value.eventId);
  const conversationId = boundedReactionValue(value.conversationId);
  const messageId = boundedReactionValue(value.messageId);
  const operatorOpenDingTalkId = boundedReactionValue(value.operatorOpenDingTalkId);
  const senderOpenDingTalkId = boundedReactionValue(value.senderOpenDingTalkId);
  const reactionName = boundedReactionValue(value.reactionName, 100);
  const occurredAt = epoch(value.occurredAt);
  const expiresAt = epoch(value.expiresAt);
  if (
    !eventId || !conversationId || !messageId || !operatorOpenDingTalkId ||
    !reactionName || value.action !== "added" || occurredAt == null ||
    expiresAt == null || expiresAt < occurredAt
  ) return null;
  return {
    eventId,
    conversationId,
    messageId,
    operatorOpenDingTalkId,
    senderOpenDingTalkId,
    reactionName,
    action: "added",
    occurredAt: new Date(occurredAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function normalizeEnterpriseRetryMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bounded = (input, maximum = 500) => {
    const output = String(input ?? "").trim();
    return output && output.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(output)
      ? output
      : null;
  };
  const id = bounded(value.id);
  const conversationId = bounded(value.conversationId);
  const createTime = bounded(value.createTime, 100);
  const senderUserId = bounded(value.senderUserId);
  const senderOpenDingTalkId = bounded(value.senderOpenDingTalkId);
  const content = String(value.content ?? "");
  if (
    !id || !conversationId || !createTime ||
    (!senderUserId && !senderOpenDingTalkId) ||
    Buffer.byteLength(content, "utf8") > enterpriseIdentityRetryDefaults.maximumContentBytes ||
    epoch(createTime) == null
  ) return null;
  const media = Array.isArray(value.media) ? value.media.slice(0, 8).map((item) => ({
    resourceId: bounded(item?.resourceId),
    resourceType: item?.resourceType === "fileId" ? "fileId" : "mediaId",
    name: bounded(item?.name, 1_000),
    mimeType: bounded(item?.mimeType, 200),
  })).filter((item) => item.resourceId) : [];
  return {
    id,
    senderUserId,
    senderOpenDingTalkId,
    senderIdentitySource: bounded(value.senderIdentitySource, 80) ?? "unknown",
    senderName: bounded(value.senderName, 500),
    conversationId,
    content,
    createTime: new Date(createTime).toISOString(),
    singleChat: value.singleChat !== false,
    isSelf: value.isSelf === true,
    isWithdrawn: value.isWithdrawn === true,
    withdrawnAt: epoch(value.withdrawnAt) == null
      ? null
      : new Date(value.withdrawnAt).toISOString(),
    media,
  };
}

function normalizeEnterpriseRetryEntry(value) {
  const message = normalizeEnterpriseRetryMessage(value?.message);
  const firstSeenAt = epoch(value?.firstSeenAt);
  const lastAttemptAt = epoch(value?.lastAttemptAt);
  const nextAttemptAt = epoch(value?.nextAttemptAt);
  const expiresAt = epoch(value?.expiresAt);
  const attempts = Number(value?.attempts);
  if (
    !message || firstSeenAt == null || lastAttemptAt == null ||
    nextAttemptAt == null || expiresAt == null ||
    !Number.isSafeInteger(attempts) || attempts < 1
  ) return null;
  return {
    message,
    firstSeenAt: new Date(firstSeenAt).toISOString(),
    lastAttemptAt: new Date(lastAttemptAt).toISOString(),
    nextAttemptAt: new Date(nextAttemptAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    attempts,
    lastErrorCode: diagnosticCode({ code: value?.lastErrorCode }, "identity_check_failed"),
  };
}

export function normalizedControlState(value = {}) {
  const ownerRevision = Number(value?.ownerRevision ?? 0);
  const sendGeneration = Number(value?.sendGeneration ?? 0);
  if (
    !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
    !Number.isSafeInteger(sendGeneration) || sendGeneration < 0
  ) throw new Error("DWS sidecar control state is invalid");
  return {
    ownerRevision,
    sendGeneration,
    lastOwnerMessageId: typeof value?.lastOwnerMessageId === "string"
      ? value.lastOwnerMessageId.slice(0, 500)
      : null,
  };
}

function emptyState() {
  return {
    lastUsers: {}, lastGroups: {}, lastEnterpriseAt: null, recentMessageIds: [],
    recentReactionEventIds: [], enterpriseIdentityQueue: {},
    enterpriseIdentityRejectedIds: [],
    enterpriseIdentityRejections: { count: 0, lastAt: null, lastErrorCode: null },
    recipients: {}, activeConversations: {}, takeoverReported: [], controlStates: {},
    sendLedger: {}, lastCheckAt: null, lastFullSuccessAt: null, lastErrorCount: 0,
    checkLifecycle: normalizeDwsCheckLifecycle(),
    sendBlocked: false, sendBlockReason: null, sendBlockedAt: null,
    responsibilityReactions: {}, reactionAutomationOps: [], pendingOwnerReactions: {},
    manualReplyProbe: { ready: null, errorCode: null, updatedAt: null },
    deferredReply: {
      waiting: false, attemptCount: 0, errorCode: null,
      expiresAt: null, updatedAt: null,
    },
    lastWakeSource: null,
    lastDetection: null,
    eventWake: { enabled: false, ready: false, errorCode: null, updatedAt: null },
    reactionWake: {
      enabled: false, readyCount: 0, errorCount: 0,
      lastErrorCode: null, updatedAt: null,
    },
    taskReconciliations: {},
  };
}

export async function loadFoursdayRuntimeState(path) {
  if (!path) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      lastUsers: parsed?.lastUsers && typeof parsed.lastUsers === "object" ? parsed.lastUsers : {},
      lastGroups: parsed?.lastGroups && typeof parsed.lastGroups === "object" ? parsed.lastGroups : {},
      lastEnterpriseAt: typeof parsed?.lastEnterpriseAt === "string"
        ? parsed.lastEnterpriseAt : null,
      enterpriseIdentityQueue: parsed?.enterpriseIdentityQueue &&
          typeof parsed.enterpriseIdentityQueue === "object" &&
          !Array.isArray(parsed.enterpriseIdentityQueue)
        ? Object.fromEntries(Object.entries(parsed.enterpriseIdentityQueue)
          .map(([key, value]) => [key, normalizeEnterpriseRetryEntry(value)])
          .filter(([key, value]) => /^[a-f0-9]{64}$/u.test(key) && value)
          .slice(-enterpriseIdentityRetryDefaults.capacity))
        : {},
      enterpriseIdentityRejectedIds: Array.isArray(parsed?.enterpriseIdentityRejectedIds)
        ? parsed.enterpriseIdentityRejectedIds.map(String)
          .filter((value) => /^[a-f0-9]{64}$/u.test(value)).slice(-1_000)
        : [],
      enterpriseIdentityRejections: {
        count: Number.isSafeInteger(parsed?.enterpriseIdentityRejections?.count) &&
            parsed.enterpriseIdentityRejections.count >= 0
          ? parsed.enterpriseIdentityRejections.count : 0,
        lastAt: typeof parsed?.enterpriseIdentityRejections?.lastAt === "string"
          ? parsed.enterpriseIdentityRejections.lastAt : null,
        lastErrorCode: typeof parsed?.enterpriseIdentityRejections?.lastErrorCode === "string"
          ? parsed.enterpriseIdentityRejections.lastErrorCode.slice(0, 80) : null,
      },
      recentMessageIds: Array.isArray(parsed?.recentMessageIds)
        ? parsed.recentMessageIds.map(String).filter(Boolean).slice(-5_000) : [],
      recentReactionEventIds: Array.isArray(parsed?.recentReactionEventIds)
        ? parsed.recentReactionEventIds.map(String).filter(Boolean).slice(-5_000) : [],
      recipients: parsed?.recipients && typeof parsed.recipients === "object"
        ? parsed.recipients : {},
      activeConversations: parsed?.activeConversations &&
          typeof parsed.activeConversations === "object"
        ? parsed.activeConversations : {},
      takeoverReported: Array.isArray(parsed?.takeoverReported)
        ? parsed.takeoverReported.map(String).filter(Boolean) : [],
      controlStates: parsed?.controlStates && typeof parsed.controlStates === "object"
        ? parsed.controlStates : {},
      sendLedger: parsed?.sendLedger && typeof parsed.sendLedger === "object"
        ? Object.fromEntries(Object.entries(parsed.sendLedger).slice(-1_000)) : {},
      responsibilityReactions: parsed?.responsibilityReactions &&
          typeof parsed.responsibilityReactions === "object" &&
          !Array.isArray(parsed.responsibilityReactions)
        ? Object.fromEntries(Object.entries(parsed.responsibilityReactions)
          .map(([key, value]) => [key, normalizeResponsibilityReactionEntry(value)])
          .filter(([key, value]) =>
            value && key === responsibilityReactionKey(value.conversationId, value.messageId)
          )
          .slice(-1_000))
        : {},
      reactionAutomationOps: Array.isArray(parsed?.reactionAutomationOps)
        ? parsed.reactionAutomationOps.map(normalizeReactionAutomationOp).filter(Boolean).slice(-200)
        : [],
      pendingOwnerReactions: parsed?.pendingOwnerReactions &&
          typeof parsed.pendingOwnerReactions === "object" &&
          !Array.isArray(parsed.pendingOwnerReactions)
        ? Object.fromEntries(Object.entries(parsed.pendingOwnerReactions)
          .map(([key, value]) => [key, normalizePendingOwnerReaction(value)])
          .filter(([key, value]) => value && key === pendingOwnerReactionKey(value.eventId))
          .slice(-128))
        : {},
      sendBlocked: parsed?.sendBlocked === true,
      sendBlockReason: typeof parsed?.sendBlockReason === "string"
        ? parsed.sendBlockReason.slice(0, 80) : null,
      sendBlockedAt: typeof parsed?.sendBlockedAt === "string" ? parsed.sendBlockedAt : null,
      manualReplyProbe: {
        ready: typeof parsed?.manualReplyProbe?.ready === "boolean"
          ? parsed.manualReplyProbe.ready : null,
        errorCode: typeof parsed?.manualReplyProbe?.errorCode === "string"
          ? parsed.manualReplyProbe.errorCode.slice(0, 80) : null,
        updatedAt: typeof parsed?.manualReplyProbe?.updatedAt === "string"
          ? parsed.manualReplyProbe.updatedAt : null,
      },
      deferredReply: {
        waiting: false,
        attemptCount: Number.isSafeInteger(parsed?.deferredReply?.attemptCount) &&
            parsed.deferredReply.attemptCount >= 0
          ? parsed.deferredReply.attemptCount : 0,
        errorCode: parsed?.deferredReply?.waiting === true
          ? "candidate_lost_on_restart"
          : typeof parsed?.deferredReply?.errorCode === "string"
            ? parsed.deferredReply.errorCode.slice(0, 80) : null,
        expiresAt: null,
        updatedAt: typeof parsed?.deferredReply?.updatedAt === "string"
          ? parsed.deferredReply.updatedAt : null,
      },
      lastCheckAt: typeof parsed?.lastCheckAt === "string" ? parsed.lastCheckAt : null,
      lastFullSuccessAt: typeof parsed?.lastFullSuccessAt === "string"
        ? parsed.lastFullSuccessAt : null,
      lastErrorCount: Number.isSafeInteger(parsed?.lastErrorCount) ? parsed.lastErrorCount : 0,
      checkLifecycle: normalizeDwsCheckLifecycle(parsed?.checkLifecycle),
      lastWakeSource: typeof parsed?.lastWakeSource === "string"
        ? parsed.lastWakeSource.slice(0, 40) : null,
      lastDetection: parsed?.lastDetection && typeof parsed.lastDetection === "object"
        ? parsed.lastDetection : null,
      eventWake: parsed?.eventWake && typeof parsed.eventWake === "object"
        ? parsed.eventWake
        : { enabled: false, ready: false, errorCode: null, updatedAt: null },
      reactionWake: parsed?.reactionWake && typeof parsed.reactionWake === "object"
        ? {
            enabled: parsed.reactionWake.enabled === true,
            readyCount: Number.isSafeInteger(parsed.reactionWake.readyCount)
              ? Math.max(0, parsed.reactionWake.readyCount) : 0,
            errorCount: Number.isSafeInteger(parsed.reactionWake.errorCount)
              ? Math.max(0, parsed.reactionWake.errorCount) : 0,
            lastErrorCode: typeof parsed.reactionWake.lastErrorCode === "string"
              ? parsed.reactionWake.lastErrorCode.slice(0, 80) : null,
            updatedAt: typeof parsed.reactionWake.updatedAt === "string"
              ? parsed.reactionWake.updatedAt : null,
          }
        : {
            enabled: false, readyCount: 0, errorCount: 0,
            lastErrorCode: null, updatedAt: null,
          },
      taskReconciliations: parsed?.taskReconciliations &&
          typeof parsed.taskReconciliations === "object" &&
          !Array.isArray(parsed.taskReconciliations)
        ? Object.fromEntries(Object.entries(parsed.taskReconciliations)
          .map(([key, value]) => [key, normalizeTaskReconciliation(value)])
          .filter(([key, value]) => /^[a-f0-9]{64}$/u.test(key) && value)
          .slice(-64))
        : {},
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveFoursdayRuntimeState(path, state) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export function createRuntimeStatePersistence({ path, state } = {}) {
  if (!state || typeof state !== "object") {
    throw new Error("Foursday runtime state persistence requires mutable state");
  }
  let stateWrite = Promise.resolve();
  const enqueue = (operation) => {
    const current = stateWrite.catch(() => {}).then(operation);
    stateWrite = current;
    return current;
  };
  const persist = () => {
    const snapshot = structuredClone(state);
    return enqueue(() => saveFoursdayRuntimeState(path, snapshot));
  };
  const persistCheckHealth = () => {
    const health = structuredClone({
      lastCheckAt: state.lastCheckAt,
      lastFullSuccessAt: state.lastFullSuccessAt,
      lastErrorCount: state.lastErrorCount,
      lastWakeSource: state.lastWakeSource,
      checkLifecycle: state.checkLifecycle,
      manualReplyProbe: state.manualReplyProbe,
    });
    return enqueue(async () => {
      const stored = await loadFoursdayRuntimeState(path);
      Object.assign(stored, health);
      await saveFoursdayRuntimeState(path, stored);
    });
  };
  return { persist, persistCheckHealth };
}
