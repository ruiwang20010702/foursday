import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  DwsAdapter,
  dwsMessageContentDigest,
  dwsMessageContentFingerprint,
  dwsMessageContentRenderFingerprint,
  dwsMessageUsesOrderedList,
  isAutomatedSelfMessage,
} from "./dws.mjs";
import { discoverWatchDirectories } from "./dingtalk-watch-directories.mjs";
import { isMainModule } from "./main-module.mjs";
import { FoursdayControlStore } from "./foursday-control-store.mjs";
import { normalizeDwsCheckLifecycle } from "./dws-checkpoint-health.mjs";
import {
  ownerInterventionCandidate,
  resolveOwnerIntervention,
} from "./foursday-owner-intervention.mjs";
import { resolveResponsibilityGroups } from "./foursday-message-groups.mjs";

function csv(value) {
  return [...new Set(String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("DWS sidecar timing configuration is invalid");
  }
  return parsed;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function diagnosticCode(error, fallback = "error") {
  return String(error?.code ?? error?.name ?? fallback)
    .replaceAll(/[^A-Za-z0-9_.-]/gu, "_")
    .slice(0, 80) || fallback;
}

function manualReplyErrorCode(error) {
  const stderr = String(error?.stderr ?? "").trim();
  if (stderr && stderr.length <= 64 * 1024) {
    try {
      const parsed = JSON.parse(stderr);
      const reason = parsed?.error?.reason ?? parsed?.error?.code;
      if (reason != null) return diagnosticCode({ code: reason }, "dws_manual_reply_probe_failed");
    } catch {}
  }
  return diagnosticCode(error, "dws_manual_reply_probe_failed");
}

const retryableManualReplyCodes = new Set([
  "tls_timeout",
  "network_unreachable",
  "backend_dependency_unavailable",
  "ETIMEDOUT",
  "dws_manual_reply_temporary",
]);
const deferredReplyRetentionMs = 90_000;
const deferredReplyProbeTimeoutMs = 12_000;
const enterpriseIdentityRetryDefaults = Object.freeze({
  ttlMs: 30 * 60_000,
  maxAttempts: 8,
  capacity: 128,
  perIdentityCapacity: 8,
  maximumContentBytes: 128 * 1024,
});
const deferredReplyRetryDelays = Object.freeze([
  500, 1_500, 3_000, 5_000, 8_000, 12_000, 15_000, 20_000, 25_000,
]);

function taskId(conversationId, participantUserId) {
  return createHash("sha256")
    .update(`${String(conversationId)}:${String(participantUserId)}`)
    .digest("hex");
}

function stableSendKey(payload) {
  return createHash("sha256").update(JSON.stringify({
    conversationId: String(payload?.conversationId ?? ""),
    content: String(payload?.content ?? ""),
    replyTo: String(payload?.replyTo ?? ""),
    ownerRevision: payload?.ownerRevision,
    sendGeneration: payload?.sendGeneration,
    metadata: payload?.metadata && typeof payload.metadata === "object"
      ? Object.fromEntries(Object.entries(payload.metadata).sort(([left], [right]) =>
        left.localeCompare(right)))
      : {},
  })).digest("hex");
}

export function classifyOwnerIntervention(text, {
  active = true,
  explicitOnly = false,
} = {}) {
  if (!active) return "unrelated_owner_message";
  const value = String(text ?? "").trim();
  if (/^(?:继续|恢复|接着做|resume)(?:\s|$|[，。！？,.!?])/iu.test(value)) return "resume_requested";
  if (/(?:我来(?:处理|做|接管)|停止任务|别做了|不用做了|取消任务|task\s*takeover|stop\s+task)/iu.test(value)) {
    return "task_takeover";
  }
  if (/(?:改成|调整为|纠正|修正|不要.{0,30}(?:而是|改为)|目标(?:改|调整)|task\s*correction)/iu.test(value)) {
    return "task_correction";
  }
  if (
    explicitOnly &&
    !/(?:我|已经|刚刚|刚才).{0,12}(?:回复|回了|发送|发给).{0,16}(?:对方|他|她|客户|同事|群里)|communication\s*takeover/iu.test(value)
  ) {
    return "unrelated_owner_message";
  }
  return "communication_takeover";
}

function idempotencyUuid(key) {
  const hex = `${key.slice(0, 12)}5${key.slice(13, 16)}8${key.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function epoch(value) {
  if (value == null || String(value).trim() === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function messageIdFromReceipt(receipt) {
  const queue = [receipt];
  for (let depth = 0; queue.length > 0 && depth < 200; depth += 1) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        /^(?:openMessageId|messageId|msgId)$/u.test(key) &&
        child.trim()
      ) return child.trim();
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function readBackSentMessage({ dws, route, conversationId, evidence }) {
  if (typeof dws.fetchDirect !== "function") return null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await sleep(1_000);
    let messages;
    try {
      messages = await dws.fetchDirect({
        userId: route.recipientId,
        identityKind: route.recipientKind ?? null,
        before: new Date(),
        limit: 50,
        lookbackMs: 10 * 60 * 1_000,
        timeoutMs: 10_000,
      });
    } catch {
      continue;
    }
    const matched = messages.filter((message) =>
      message.conversationId === conversationId &&
      isAutomatedSelfMessage(message, [evidence])
    );
    if (matched.length === 1 && String(matched[0].id ?? "").trim()) {
      return String(matched[0].id).trim();
    }
  }
  return null;
}

function emptyState() {
  return {
    lastUsers: {}, lastGroups: {}, lastEnterpriseAt: null, recentMessageIds: [],
    recentReactionEventIds: [],
    enterpriseIdentityQueue: {},
    enterpriseIdentityRejectedIds: [],
    enterpriseIdentityRejections: { count: 0, lastAt: null, lastErrorCode: null },
    recipients: {}, activeConversations: {}, takeoverReported: [],
    controlStates: {},
    sendLedger: {}, lastCheckAt: null, lastFullSuccessAt: null, lastErrorCount: 0,
    checkLifecycle: normalizeDwsCheckLifecycle(),
    sendBlocked: false, sendBlockReason: null, sendBlockedAt: null,
    responsibilityReactions: {}, reactionAutomationOps: [],
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
  };
}

function enterpriseIdentityRetryKey(messageId) {
  return createHash("sha256").update(String(messageId)).digest("hex");
}

function responsibilityReactionKey(conversationId, messageId) {
  return createHash("sha256").update(`${conversationId}\0${messageId}`).digest("hex");
}

function boundedReactionValue(value, maximum = 500) {
  const output = String(value ?? "").trim();
  return output && output.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(output)
    ? output
    : null;
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

function normalizeEnterpriseRetryMessage(value) {
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

function normalizedControlState(value = {}) {
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

async function loadState(path) {
  if (!path) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      lastUsers: parsed?.lastUsers && typeof parsed.lastUsers === "object" ? parsed.lastUsers : {},
      lastGroups: parsed?.lastGroups && typeof parsed.lastGroups === "object" ? parsed.lastGroups : {},
      lastEnterpriseAt: typeof parsed?.lastEnterpriseAt === "string"
        ? parsed.lastEnterpriseAt
        : null,
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
          ? parsed.enterpriseIdentityRejections.count
          : 0,
        lastAt: typeof parsed?.enterpriseIdentityRejections?.lastAt === "string"
          ? parsed.enterpriseIdentityRejections.lastAt
          : null,
        lastErrorCode: typeof parsed?.enterpriseIdentityRejections?.lastErrorCode === "string"
          ? parsed.enterpriseIdentityRejections.lastErrorCode.slice(0, 80)
          : null,
      },
      recentMessageIds: Array.isArray(parsed?.recentMessageIds)
        ? parsed.recentMessageIds.map(String).filter(Boolean).slice(-5_000)
        : [],
      recentReactionEventIds: Array.isArray(parsed?.recentReactionEventIds)
        ? parsed.recentReactionEventIds.map(String).filter(Boolean).slice(-5_000)
        : [],
      recipients: parsed?.recipients && typeof parsed.recipients === "object"
        ? parsed.recipients
        : {},
      activeConversations:
        parsed?.activeConversations && typeof parsed.activeConversations === "object"
          ? parsed.activeConversations
          : {},
      takeoverReported: Array.isArray(parsed?.takeoverReported)
        ? parsed.takeoverReported.map(String).filter(Boolean)
        : [],
      controlStates: parsed?.controlStates && typeof parsed.controlStates === "object"
        ? parsed.controlStates
        : {},
      sendLedger: parsed?.sendLedger && typeof parsed.sendLedger === "object"
        ? Object.fromEntries(Object.entries(parsed.sendLedger).slice(-1_000))
        : {},
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
      sendBlocked: parsed?.sendBlocked === true,
      sendBlockReason: typeof parsed?.sendBlockReason === "string"
        ? parsed.sendBlockReason.slice(0, 80)
        : null,
      sendBlockedAt: typeof parsed?.sendBlockedAt === "string"
        ? parsed.sendBlockedAt
        : null,
      manualReplyProbe: {
        ready: typeof parsed?.manualReplyProbe?.ready === "boolean"
          ? parsed.manualReplyProbe.ready
          : null,
        errorCode: typeof parsed?.manualReplyProbe?.errorCode === "string"
          ? parsed.manualReplyProbe.errorCode.slice(0, 80)
          : null,
        updatedAt: typeof parsed?.manualReplyProbe?.updatedAt === "string"
          ? parsed.manualReplyProbe.updatedAt
          : null,
      },
      deferredReply: {
        waiting: false,
        attemptCount: Number.isSafeInteger(parsed?.deferredReply?.attemptCount) &&
            parsed.deferredReply.attemptCount >= 0
          ? parsed.deferredReply.attemptCount
          : 0,
        errorCode: parsed?.deferredReply?.waiting === true
          ? "candidate_lost_on_restart"
          : typeof parsed?.deferredReply?.errorCode === "string"
            ? parsed.deferredReply.errorCode.slice(0, 80)
            : null,
        expiresAt: null,
        updatedAt: typeof parsed?.deferredReply?.updatedAt === "string"
          ? parsed.deferredReply.updatedAt
          : null,
      },
      lastCheckAt: typeof parsed?.lastCheckAt === "string" ? parsed.lastCheckAt : null,
      lastFullSuccessAt:
        typeof parsed?.lastFullSuccessAt === "string" ? parsed.lastFullSuccessAt : null,
      lastErrorCount: Number.isSafeInteger(parsed?.lastErrorCount)
        ? parsed.lastErrorCount
        : 0,
      checkLifecycle: normalizeDwsCheckLifecycle(parsed?.checkLifecycle),
      lastWakeSource: typeof parsed?.lastWakeSource === "string"
        ? parsed.lastWakeSource.slice(0, 40)
        : null,
      lastDetection: parsed?.lastDetection && typeof parsed.lastDetection === "object"
        ? parsed.lastDetection
        : null,
      eventWake: parsed?.eventWake && typeof parsed.eventWake === "object"
        ? parsed.eventWake
        : { enabled: false, ready: false, errorCode: null, updatedAt: null },
      reactionWake: parsed?.reactionWake && typeof parsed.reactionWake === "object"
        ? {
            enabled: parsed.reactionWake.enabled === true,
            readyCount: Number.isSafeInteger(parsed.reactionWake.readyCount)
              ? Math.max(0, parsed.reactionWake.readyCount)
              : 0,
            errorCount: Number.isSafeInteger(parsed.reactionWake.errorCount)
              ? Math.max(0, parsed.reactionWake.errorCount)
              : 0,
            lastErrorCode: typeof parsed.reactionWake.lastErrorCode === "string"
              ? parsed.reactionWake.lastErrorCode.slice(0, 80)
              : null,
            updatedAt: typeof parsed.reactionWake.updatedAt === "string"
              ? parsed.reactionWake.updatedAt
              : null,
          }
        : {
            enabled: false, readyCount: 0, errorCount: 0,
            lastErrorCode: null, updatedAt: null,
          },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function saveState(path, state) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export function sidecarConfig(environment = process.env) {
  const dwsPath = String(environment.DWS_PATH ?? "").trim();
  if (!isAbsolute(dwsPath)) throw new Error("DWS_PATH must be absolute");
  const stateFile = String(environment.DWS_PERSONAL_STATE_FILE ?? "").trim();
  if (stateFile && !isAbsolute(stateFile)) {
    throw new Error("DWS_PERSONAL_STATE_FILE must be absolute");
  }
  const mediaRoot = String(environment.DWS_PERSONAL_MEDIA_ROOT ?? "").trim();
  if (mediaRoot && !isAbsolute(mediaRoot)) {
    throw new Error("DWS_PERSONAL_MEDIA_ROOT must be absolute");
  }
  const controlFile = String(environment.FOURSDAY_CONTROL_FILE ?? "").trim();
  if (controlFile && !isAbsolute(controlFile)) {
    throw new Error("FOURSDAY_CONTROL_FILE must be absolute");
  }
  const responsibilityReactionName = String(
    environment.DWS_PERSONAL_RESPONSIBILITY_REACTION ?? "OK",
  ).trim();
  if (
    !responsibilityReactionName || responsibilityReactionName.length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(responsibilityReactionName)
  ) {
    throw new Error("DWS responsibility reaction name is invalid");
  }
  return {
    dwsPath: resolve(dwsPath),
    dingtalkRoot: String(
      environment.DINGTALK_ROOT ?? environment.DINGTALK_DATA_ROOT ?? "",
    ).trim(),
    userIds: csv(
      environment.DWS_PERSONAL_FETCH_USERS ??
      environment.DWS_PERSONAL_ALLOWED_USERS,
    ),
    enterpriseUsersEnabled: String(
      environment.DWS_PERSONAL_ENTERPRISE_USERS_ENABLED ?? "false",
    ).toLowerCase() === "true",
    groupIds: csv(environment.DWS_PERSONAL_ALLOWED_GROUPS),
    selfUserId: String(environment.DINGTALK_SELF_USER_ID ?? "").trim() || null,
    stateFile: stateFile ? resolve(stateFile) : null,
    mediaRoot: mediaRoot ? resolve(mediaRoot) : null,
    controlFile: controlFile ? resolve(controlFile) : null,
    initialLookbackMs: boundedInteger(
      environment.DWS_PERSONAL_INITIAL_LOOKBACK_MS,
      120_000,
      10_000,
      24 * 60 * 60 * 1_000,
    ),
    fallbackMs: boundedInteger(
      environment.DWS_PERSONAL_FALLBACK_MS,
      30_000,
      5_000,
      5 * 60 * 1_000,
    ),
    historySettleMs: boundedInteger(
      environment.DWS_PERSONAL_HISTORY_SETTLE_MS,
      120_000,
      0,
      10 * 60 * 1_000,
    ),
    enterpriseIdentityRetryTtlMs: boundedInteger(
      environment.DWS_PERSONAL_IDENTITY_RETRY_TTL_MS,
      enterpriseIdentityRetryDefaults.ttlMs,
      60_000,
      24 * 60 * 60 * 1_000,
    ),
    enterpriseIdentityRetryMaxAttempts: boundedInteger(
      environment.DWS_PERSONAL_IDENTITY_RETRY_MAX_ATTEMPTS,
      enterpriseIdentityRetryDefaults.maxAttempts,
      1,
      20,
    ),
    enterpriseIdentityRetryCapacity: boundedInteger(
      environment.DWS_PERSONAL_IDENTITY_RETRY_CAPACITY,
      enterpriseIdentityRetryDefaults.capacity,
      1,
      1_000,
    ),
    eventWakeEnabled: String(
      environment.DWS_PERSONAL_EVENT_WAKE_ENABLED ?? "true",
    ).toLowerCase() === "true",
    outboundQuietMs: boundedInteger(
      environment.DWS_PERSONAL_OUTBOUND_QUIET_MS,
      8_000,
      0,
      30_000,
    ),
    outboundMaxQuietMs: boundedInteger(
      environment.DWS_PERSONAL_OUTBOUND_MAX_QUIET_MS,
      20_000,
      0,
      60_000,
    ),
    semanticInterventionEnabled: String(
      environment.DWS_PERSONAL_SEMANTIC_INTERVENTION_ENABLED ?? "false",
    ).toLowerCase() === "true",
    semanticInterventionTimeoutMs: boundedInteger(
      environment.DWS_PERSONAL_SEMANTIC_INTERVENTION_TIMEOUT_MS,
      30_000,
      5_000,
      60_000,
    ),
    responsibilityReactionsEnabled: String(
      environment.DWS_PERSONAL_RESPONSIBILITY_REACTIONS_ENABLED ?? "false",
    ).toLowerCase() === "true",
    responsibilityReactionName,
    sendEnabled: String(environment.DWS_PERSONAL_SEND_ENABLED ?? "false").toLowerCase() === "true",
  };
}

export async function createSidecarRuntime({
  config = sidecarConfig(),
  dws = new DwsAdapter({ dwsPath: config.dwsPath }),
  emit = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`),
  diagnose = (value) => process.stderr.write(`${value}\n`),
  now = () => new Date(),
  clock = () => Date.now(),
  wait = sleep,
  controlStore = config.controlFile
    ? new FoursdayControlStore({ path: config.controlFile })
    : null,
  semanticInterventionClassifier = resolveOwnerIntervention,
  responsibilityGroupingResolver = resolveResponsibilityGroups,
  classifierEnvironment = process.env,
} = {}) {
  if (config.outboundQuietMs > config.outboundMaxQuietMs) {
    throw new Error("DWS outbound quiet window exceeds its maximum");
  }
  const wakePriority = new Map([
    ["dws_event", 4],
    ["filesystem", 3],
    ["fallback", 2],
    ["startup", 1],
    ["manual", 0],
  ]);
  const strongerWakeSource = (current, candidate) => {
    if (!current) return candidate;
    return (wakePriority.get(candidate) ?? -1) > (wakePriority.get(current) ?? -1)
      ? candidate
      : current;
  };
  await access(config.dwsPath);
  if (config.mediaRoot) {
    await mkdir(config.mediaRoot, { recursive: true, mode: 0o700 });
    await chmod(config.mediaRoot, 0o700);
  }
  const state = await loadState(config.stateFile);
  const enterpriseIdentityRetryTtlMs = boundedInteger(
    config.enterpriseIdentityRetryTtlMs,
    enterpriseIdentityRetryDefaults.ttlMs,
    1_000,
    24 * 60 * 60 * 1_000,
  );
  const enterpriseIdentityRetryMaxAttempts = boundedInteger(
    config.enterpriseIdentityRetryMaxAttempts,
    enterpriseIdentityRetryDefaults.maxAttempts,
    1,
    20,
  );
  const enterpriseIdentityRetryCapacity = boundedInteger(
    config.enterpriseIdentityRetryCapacity,
    enterpriseIdentityRetryDefaults.capacity,
    1,
    1_000,
  );
  const seen = new Set(state.recentMessageIds);
  const seenReactionEvents = new Set(state.recentReactionEventIds);
  const enterpriseIdentityQueue = new Map(Object.entries(state.enterpriseIdentityQueue));
  while (enterpriseIdentityQueue.size > enterpriseIdentityRetryCapacity) {
    enterpriseIdentityQueue.delete(enterpriseIdentityQueue.keys().next().value);
  }
  state.enterpriseIdentityQueue = Object.fromEntries(enterpriseIdentityQueue);
  const enterpriseIdentityRejectedIds = new Set(state.enterpriseIdentityRejectedIds);
  const recipients = new Map(Object.entries(state.recipients));
  const activeConversations = new Map(Object.entries(state.activeConversations));
  const takeoverReported = new Set(state.takeoverReported);
  const controlStates = new Map(Object.entries(state.controlStates).map(([key, value]) => [
    key,
    normalizedControlState(value),
  ]));
  const sendLedger = new Map(Object.entries(state.sendLedger));
  const responsibilityReactions = new Map(Object.entries(state.responsibilityReactions));
  let reactionAutomationOps = [...state.reactionAutomationOps];
  const automatedSendEvidence = [...sendLedger.values()]
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      conversationId: entry.conversationId,
      startedAt: entry.startedAt,
      contentDigest: entry.contentDigest,
      idempotencyKey: entry.idempotencyKey,
      receipt: entry.messageId ? { messageId: entry.messageId } : undefined,
    }));
  const rememberAutomatedSend = (evidence) => {
    const index = automatedSendEvidence.findIndex((item) =>
      item?.idempotencyKey === evidence?.idempotencyKey
    );
    if (index >= 0) automatedSendEvidence[index] = evidence;
    else automatedSendEvidence.push(evidence);
    if (automatedSendEvidence.length > 1_000) automatedSendEvidence.shift();
  };
  const watchers = [];
  let eventWakeController = null;
  const reactionWakeControllers = new Map();
  const reactionWakeReady = new Set();
  const reactionWakeFailed = new Set();
  let ownerOpenDingTalkId = null;
  let fallbackTimer = null;
  let debounceTimer = null;
  let running = false;
  let pending = false;
  let pendingWakeSource = null;
  let stateWrite = Promise.resolve();
  const syncEnterpriseIdentityQueue = () => {
    state.enterpriseIdentityQueue = Object.fromEntries(enterpriseIdentityQueue);
  };
  const syncResponsibilityState = () => {
    state.responsibilityReactions = Object.fromEntries(responsibilityReactions);
    state.reactionAutomationOps = reactionAutomationOps.slice(-200);
    state.recentReactionEventIds = [...seenReactionEvents].slice(-5_000);
  };
  const identityRetryDelayMs = (attempts) => Math.min(
    5 * 60_000,
    5_000 * (2 ** Math.max(0, attempts - 1)),
  );
  const identityFailure = (error) => {
    if (typeof dws.enterpriseIdentityFailure === "function") {
      return dws.enterpriseIdentityFailure(error);
    }
    const code = diagnosticCode(error, "dws_enterprise_identity_check_failed");
    return {
      errorCode: code,
      retryable: !/(?:identity_(?:required|unavailable|mismatch)|auth|unauthorized|forbidden)/iu
        .test(`${code} ${String(error?.message ?? "")}`),
    };
  };
  const recordIdentityRejection = (message, errorCode, reason = "identity_rejected") => {
    const rejectionId = enterpriseIdentityRetryKey(
      message?.id ?? `${message?.conversationId ?? "unknown"}:${message?.createTime ?? "unknown"}:${errorCode}`,
    );
    if (enterpriseIdentityRejectedIds.has(rejectionId)) return false;
    enterpriseIdentityRejectedIds.add(rejectionId);
    if (enterpriseIdentityRejectedIds.size > 1_000) {
      enterpriseIdentityRejectedIds.delete(enterpriseIdentityRejectedIds.values().next().value);
    }
    state.enterpriseIdentityRejectedIds = [...enterpriseIdentityRejectedIds];
    state.enterpriseIdentityRejections = {
      count: Number(state.enterpriseIdentityRejections?.count ?? 0) + 1,
      lastAt: now().toISOString(),
      lastErrorCode: diagnosticCode({ code: errorCode }, reason),
    };
    diagnose(
      `dws_enterprise_${reason}:${hash(message?.id)}:${state.enterpriseIdentityRejections.lastErrorCode}`,
    );
    return true;
  };
  const enqueueIdentityRetry = (candidate, observedAt) => {
    const message = normalizeEnterpriseRetryMessage(candidate?.message);
    const errorCode = diagnosticCode(
      { code: candidate?.errorCode },
      "dws_enterprise_identity_check_failed",
    );
    if (!message || seen.has(message?.id)) {
      if (!message) recordIdentityRejection(candidate?.message, "invalid_retry_envelope");
      return null;
    }
    const key = enterpriseIdentityRetryKey(message.id);
    if (enterpriseIdentityQueue.has(key)) return key;
    const identity = message.senderOpenDingTalkId || message.senderUserId;
    const sameIdentity = [...enterpriseIdentityQueue.values()].filter((entry) =>
      (entry.message.senderOpenDingTalkId || entry.message.senderUserId) === identity
    ).length;
    if (
      enterpriseIdentityQueue.size >= enterpriseIdentityRetryCapacity ||
      sameIdentity >= enterpriseIdentityRetryDefaults.perIdentityCapacity
    ) {
      recordIdentityRejection(message, "identity_retry_capacity_exceeded", "identity_retry_dropped");
      return null;
    }
    const observed = epoch(observedAt) ?? now().getTime();
    enterpriseIdentityQueue.set(key, {
      message,
      firstSeenAt: new Date(observed).toISOString(),
      lastAttemptAt: new Date(observed).toISOString(),
      nextAttemptAt: new Date(observed + identityRetryDelayMs(1)).toISOString(),
      expiresAt: new Date(observed + enterpriseIdentityRetryTtlMs).toISOString(),
      attempts: 1,
      lastErrorCode: errorCode,
    });
    syncEnterpriseIdentityQueue();
    diagnose(`dws_enterprise_identity_retry_queued:${hash(message.id)}:${errorCode}`);
    return key;
  };
  const retryEnterpriseIdentities = async (at) => {
    if (typeof dws.retryEnterpriseDirectMessage !== "function") return [];
    const recovered = [];
    for (const [key, entry] of enterpriseIdentityQueue) {
      if (seen.has(entry.message.id)) {
        enterpriseIdentityQueue.delete(key);
        continue;
      }
      const currentTime = at.getTime();
      if (
        currentTime >= (epoch(entry.expiresAt) ?? 0) ||
        entry.attempts >= enterpriseIdentityRetryMaxAttempts
      ) {
        enterpriseIdentityQueue.delete(key);
        recordIdentityRejection(entry.message, entry.lastErrorCode, "identity_retry_expired");
        continue;
      }
      if (currentTime < (epoch(entry.nextAttemptAt) ?? 0)) continue;
      try {
        const message = await dws.retryEnterpriseDirectMessage(entry.message);
        recovered.push({ ...message, enterpriseIdentityRetryKey: key });
      } catch (error) {
        const failure = identityFailure(error);
        const attempts = entry.attempts + 1;
        if (!failure.retryable || attempts >= enterpriseIdentityRetryMaxAttempts) {
          enterpriseIdentityQueue.delete(key);
          recordIdentityRejection(
            entry.message,
            failure.errorCode,
            failure.retryable ? "identity_retry_expired" : "identity_rejected",
          );
          continue;
        }
        enterpriseIdentityQueue.set(key, {
          ...entry,
          attempts,
          lastAttemptAt: at.toISOString(),
          nextAttemptAt: new Date(currentTime + identityRetryDelayMs(attempts)).toISOString(),
          lastErrorCode: failure.errorCode,
        });
      }
    }
    syncEnterpriseIdentityQueue();
    return recovered;
  };
  const persistState = () => {
    const snapshot = structuredClone(state);
    const current = stateWrite.catch(() => {}).then(() => saveState(config.stateFile, snapshot));
    stateWrite = current;
    return current;
  };
  let handleReactionEvent = async () => {};
  const reactionTargetKey = ({ chatType, conversationId, participantOpenDingTalkId }) =>
    chatType === "group"
      ? `group:${conversationId}`
      : `direct:${participantOpenDingTalkId}`;
  const updateReactionWakeState = () => {
    state.reactionWake = {
      enabled: config.responsibilityReactionsEnabled === true,
      readyCount: reactionWakeReady.size,
      errorCount: reactionWakeFailed.size,
      lastErrorCode: state.reactionWake?.lastErrorCode ?? null,
      updatedAt: now().toISOString(),
    };
  };
  const ensureReactionWake = async ({
    chatType,
    conversationId,
    participantUserId = null,
    participantOpenDingTalkId = null,
    participantName = null,
  }) => {
    if (
      config.responsibilityReactionsEnabled !== true ||
      typeof dws.createReactionEventWake !== "function"
    ) return false;
    let openId = String(participantOpenDingTalkId ?? "").trim() || null;
    const targetFailureKey = `target:${hash(participantUserId ?? participantName ?? "unknown")}`;
    if (chatType === "direct" && !openId && typeof dws.resolveUserOpenDingTalkId === "function") {
      try {
        openId = await dws.resolveUserOpenDingTalkId(participantUserId, participantName, {
          allowPolicyFallback: false,
        });
        reactionWakeFailed.delete(targetFailureKey);
      } catch (error) {
        reactionWakeFailed.add(targetFailureKey);
        state.reactionWake.lastErrorCode = diagnosticCode(error, "reaction_target_unavailable");
        updateReactionWakeState();
        await persistState();
        return false;
      }
    }
    if (openId) reactionWakeFailed.delete(targetFailureKey);
    const target = {
      chatType,
      conversationId: String(conversationId ?? "").trim(),
      participantOpenDingTalkId: openId,
    };
    const key = reactionTargetKey(target);
    if (reactionWakeReady.has(key)) return true;
    if (reactionWakeControllers.has(key)) {
      try {
        await reactionWakeControllers.get(key).ready;
        return reactionWakeReady.has(key);
      } catch {
        return false;
      }
    }
    if (reactionWakeControllers.size >= 128) {
      reactionWakeFailed.add(key);
      state.reactionWake.lastErrorCode = "reaction_watcher_capacity_exceeded";
      updateReactionWakeState();
      await persistState();
      diagnose("dws_reaction_event_unavailable:reaction_watcher_capacity_exceeded");
      return false;
    }
    let controller;
    try {
      controller = dws.createReactionEventWake({
        ...target,
        readyTimeoutMs: 8_000,
        onEvent: (event) => {
          Promise.resolve(handleReactionEvent(event)).catch((error) => {
            diagnose(`dws_reaction_event_failed:${diagnosticCode(error, "reaction_event_failed")}`);
          });
        },
        onDiagnostic: (value) => {
          diagnose(value);
          if (String(value).startsWith("dws_event_closed:")) {
            reactionWakeReady.delete(key);
            reactionWakeFailed.add(key);
            state.reactionWake.lastErrorCode = "reaction_event_closed";
            updateReactionWakeState();
            persistState().catch(() => {});
          }
        },
      });
      reactionWakeControllers.set(key, controller);
      updateReactionWakeState();
      await persistState();
      await controller.ready;
      reactionWakeReady.add(key);
      reactionWakeFailed.delete(key);
      state.reactionWake.lastErrorCode = null;
      updateReactionWakeState();
      await persistState();
      return true;
    } catch (error) {
      reactionWakeFailed.add(key);
      state.reactionWake.lastErrorCode = diagnosticCode(error, "reaction_event_unavailable");
      updateReactionWakeState();
      await persistState();
      diagnose(`dws_reaction_event_unavailable:${state.reactionWake.lastErrorCode}`);
      return false;
    }
  };
  const pruneReactionAutomationOps = (at = clock()) => {
    reactionAutomationOps = reactionAutomationOps.filter((entry) =>
      (epoch(entry?.expiresAt) ?? 0) > at
    ).slice(-200);
    syncResponsibilityState();
  };
  const beginReactionAutomation = ({ action, conversationId, messageId, reactionName }) => {
    pruneReactionAutomationOps();
    const startedAt = now().toISOString();
    const entry = {
      id: createHash("sha256").update(
        `${action}\0${conversationId}\0${messageId}\0${reactionName}\0${startedAt}`,
      ).digest("hex"),
      action,
      conversationId,
      messageId,
      reactionName,
      startedAt,
      expiresAt: new Date(clock() + 30_000).toISOString(),
      status: "intent",
    };
    reactionAutomationOps.push(entry);
    syncResponsibilityState();
    return entry;
  };
  const consumeAutomatedReactionEvent = (event) => {
    pruneReactionAutomationOps(epoch(event?.occurredAt) ?? clock());
    const index = reactionAutomationOps.findIndex((entry) =>
      entry.conversationId === event.conversationId &&
      entry.messageId === event.messageId &&
      entry.reactionName === event.reactionName &&
      entry.action === event.action
    );
    if (index < 0) return false;
    reactionAutomationOps.splice(index, 1);
    syncResponsibilityState();
    return true;
  };
  const writeResponsibilityReaction = async ({ action, entry }) => {
    if (config.responsibilityReactionsEnabled !== true || config.sendEnabled !== true) {
      return { success: true, sendDisabled: true };
    }
    const method = action === "added" ? dws.addEmojiReaction : dws.removeEmojiReaction;
    if (typeof method !== "function") {
      return { success: false, error: "dws_reaction_write_unavailable" };
    }
    const operation = beginReactionAutomation({
      action,
      conversationId: entry.conversationId,
      messageId: entry.messageId,
      reactionName: entry.reactionName,
    });
    await persistState();
    try {
      const result = await method.call(dws, {
        conversationId: entry.conversationId,
        messageId: entry.messageId,
        emoji: entry.reactionName,
      });
      operation.status = result?.success === true ? "completed" : "failed";
      syncResponsibilityState();
      await persistState();
      return result?.success === true
        ? { success: true }
        : { success: false, error: "dws_reaction_write_failed" };
    } catch (error) {
      operation.status = "unknown";
      syncResponsibilityState();
      await persistState();
      diagnose(`dws_reaction_write_failed:${diagnosticCode(error, "reaction_write_failed")}`);
      return { success: false, error: diagnosticCode(error, "reaction_write_failed") };
    }
  };
  const claimResponsibility = async (payload) => {
    if (config.responsibilityReactionsEnabled !== true) {
      return { success: true, disabled: true };
    }
    const conversationId = String(payload?.conversationId ?? "").trim();
    const messageId = String(payload?.messageId ?? "").trim();
    const sourceMessageIds = Array.isArray(payload?.sourceMessageIds)
      ? [...new Set(payload.sourceMessageIds.map(String).filter(Boolean))].slice(0, 32)
      : [];
    const ownerRevision = Number(payload?.ownerRevision);
    const sendGeneration = Number(payload?.sendGeneration);
    const active = activeConversations.get(conversationId);
    if (
      !active || !conversationId || conversationId.length > 500 ||
      !messageId || messageId.length > 500 ||
      !sourceMessageIds.includes(messageId) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0 ||
      ownerRevision !== Number(active.ownerRevision ?? 0) ||
      sendGeneration !== Number(active.sendGeneration ?? 0)
    ) return { success: false, error: "responsibility_claim_stale" };
    if (!await resolveOwnerOpenDingTalkId()) {
      return { success: false, error: "reaction_owner_identity_unavailable" };
    }
    const targetKey = reactionTargetKey({
      chatType: active.chatType,
      conversationId,
      participantOpenDingTalkId: active.participantOpenDingTalkId,
    });
    if (
      config.responsibilityReactionsEnabled === true &&
      !reactionWakeReady.has(targetKey) &&
      !await ensureReactionWake({
        chatType: active.chatType,
        conversationId,
        participantUserId: active.participantUserId,
        participantOpenDingTalkId: active.participantOpenDingTalkId,
      })
    ) {
      return { success: false, error: "reaction_event_not_ready" };
    }
    const key = responsibilityReactionKey(conversationId, messageId);
    const existing = responsibilityReactions.get(key);
    if (
      existing &&
      existing.ownerRevision === ownerRevision &&
      existing.sendGeneration === sendGeneration
    ) {
      return ["claimed", "handled_no_reply", "shadow"].includes(existing.status)
        ? {
            success: true,
            idempotent: true,
            ...(existing.status === "shadow" ? { sendDisabled: true } : {}),
          }
        : {
            success: false,
            idempotent: true,
            error: existing.status === "unavailable"
              ? "responsibility_reaction_unavailable"
              : "responsibility_reaction_in_progress",
          };
    }
    for (const previous of [...responsibilityReactions.values()]) {
      if (
        previous.conversationId === conversationId &&
        previous.messageId !== messageId &&
        ["claiming", "claimed", "clearing"].includes(previous.status) &&
        Number(previous.sendGeneration) < sendGeneration
      ) {
        await releaseResponsibility({
          conversationId: previous.conversationId,
          messageId: previous.messageId,
        });
      }
    }
    const entry = {
      conversationId,
      messageId,
      sourceMessageIds,
      reactionName: config.responsibilityReactionName,
      ownerRevision,
      sendGeneration,
      status: "claiming",
      claimedAt: now().toISOString(),
      clearedAt: null,
    };
    responsibilityReactions.set(key, entry);
    while (responsibilityReactions.size > 1_000) {
      responsibilityReactions.delete(responsibilityReactions.keys().next().value);
    }
    syncResponsibilityState();
    await persistState();
    const result = await writeResponsibilityReaction({ action: "added", entry });
    entry.status = result.sendDisabled === true
      ? "shadow"
      : result.success === true
        ? "claimed"
        : "unavailable";
    syncResponsibilityState();
    await persistState();
    return result;
  };
  const releaseResponsibility = async (payload) => {
    if (config.responsibilityReactionsEnabled !== true) {
      return { success: true, disabled: true };
    }
    const conversationId = String(payload?.conversationId ?? "").trim();
    const messageId = String(payload?.messageId ?? "").trim();
    const key = responsibilityReactionKey(conversationId, messageId);
    const entry = responsibilityReactions.get(key);
    if (!entry || entry.status === "cleared") return { success: true, idempotent: true };
    if (!["claimed", "handled_no_reply"].includes(entry.status)) {
      entry.status = "cleared";
      entry.clearedAt = now().toISOString();
      syncResponsibilityState();
      await persistState();
      return { success: true, idempotent: true };
    }
    entry.status = "clearing";
    syncResponsibilityState();
    await persistState();
    const result = await writeResponsibilityReaction({ action: "removed", entry });
    entry.status = result.success === true ? "cleared" : "claimed";
    if (result.success === true) entry.clearedAt = now().toISOString();
    syncResponsibilityState();
    await persistState();
    return result;
  };
  const settleResponsibility = async (payload) => {
    if (config.responsibilityReactionsEnabled !== true) {
      return { success: true, disabled: true };
    }
    const conversationId = String(payload?.conversationId ?? "").trim();
    const messageId = String(payload?.messageId ?? "").trim();
    const entry = responsibilityReactions.get(
      responsibilityReactionKey(conversationId, messageId),
    );
    if (!entry || entry.status === "cleared") return { success: true, idempotent: true };
    if (entry.status === "shadow") return { success: true, sendDisabled: true, idempotent: true };
    if (entry.status === "claimed") {
      entry.status = "handled_no_reply";
      syncResponsibilityState();
      await persistState();
      return { success: true };
    }
    return { success: false, error: "responsibility_reaction_not_settleable" };
  };
  const groupResponsibilityMessages = async (payload) => {
    const messages = Array.isArray(payload?.messages)
      ? payload.messages.slice(0, 32).map((message) => ({
          id: boundedReactionValue(message?.id),
          content: String(message?.content ?? "").slice(0, 2_000),
        }))
      : [];
    if (
      messages.length < 1 ||
      messages.some((message) => !message.id) ||
      new Set(messages.map((message) => message.id)).size !== messages.length
    ) return { success: false, error: "responsibility_grouping_invalid" };
    if (config.responsibilityReactionsEnabled !== true || messages.length === 1) {
      return {
        success: true,
        groups: [messages.map((_message, index) => index)],
        source: messages.length === 1 ? "single" : "disabled",
      };
    }
    const result = await responsibilityGroupingResolver(messages, {
      environment: classifierEnvironment,
      timeoutMs: Math.min(20_000, config.semanticInterventionTimeoutMs),
    });
    return {
      success: true,
      groups: result.groups,
      source: result.source,
      confidence: result.confidence,
    };
  };
  const releaseConversationResponsibilities = async (conversationId, messageId = null) => {
    for (const entry of [...responsibilityReactions.values()]) {
      if (
        entry.conversationId === conversationId &&
        (!messageId || entry.sourceMessageIds.includes(messageId)) &&
        ["claiming", "claimed", "handled_no_reply", "clearing"].includes(entry.status)
      ) {
        await releaseResponsibility({
          conversationId: entry.conversationId,
          messageId: entry.messageId,
        });
      }
    }
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
    const current = stateWrite.catch(() => {}).then(async () => {
      const stored = await loadState(config.stateFile);
      Object.assign(stored, health);
      await saveState(config.stateFile, stored);
    });
    stateWrite = current;
    return current;
  };
  const blockSending = async (reason) => {
    state.sendBlocked = true;
    state.sendBlockReason = String(reason ?? "send_outcome_unknown").slice(0, 80);
    state.sendBlockedAt = now().toISOString();
    await persistState();
  };
  const probeManualReply = async (input, {
    retryDelays = [250],
    timeoutMs = 10_000,
    deadlineAt = Number.POSITIVE_INFINITY,
    beforeAttempt = async () => {},
    onFailure = async () => {},
  } = {}) => {
    if (!config.selfUserId || typeof dws.hasManualReply !== "function") {
      const error = new Error("DWS manual-reply verification is unavailable");
      error.code = "dws_manual_reply_probe_unavailable";
      throw error;
    }
    let lastError = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        if (clock() >= deadlineAt) {
          const error = new Error("Foursday deferred reply expired before verification");
          error.code = "deferred_reply_expired";
          throw error;
        }
        await beforeAttempt(attempt + 1);
        const result = await dws.hasManualReply({
          ...input,
          now: now(),
          timeoutMs,
        });
        if (result?.known !== true) {
          const error = new Error("DWS manual-reply verification is inconclusive");
          error.code = "dws_manual_reply_probe_unknown";
          throw error;
        }
        state.manualReplyProbe = {
          ready: true,
          errorCode: null,
          updatedAt: now().toISOString(),
        };
        if (clock() >= deadlineAt) {
          const error = new Error("Foursday deferred reply expired during verification");
          error.code = "deferred_reply_expired";
          throw error;
        }
        return result;
      } catch (error) {
        lastError = error;
        const code = manualReplyErrorCode(error);
        if (!["deferred_reply_stale", "deferred_reply_expired"].includes(code)) {
          state.manualReplyProbe = {
            ready: false,
            errorCode: code,
            updatedAt: now().toISOString(),
          };
        }
        await onFailure({ attemptCount: attempt + 1, errorCode: code });
        if (
          attempt >= retryDelays.length ||
          !retryableManualReplyCodes.has(code)
        ) break;
        const remaining = deadlineAt - clock();
        const delay = Math.min(retryDelays[attempt], remaining);
        if (!(delay > 0)) break;
        await wait(delay);
      }
    }
    const code = manualReplyErrorCode(lastError);
    if (state.manualReplyProbe.ready === false && state.manualReplyProbe.errorCode) {
      diagnose(`dws_sidecar_manual_reply_probe_failed:${state.manualReplyProbe.errorCode}`);
    }
    throw lastError;
  };

  const remember = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 5_000) seen.delete(seen.values().next().value);
    state.recentMessageIds = [...seen];
    return true;
  };

  const recentTaskText = new Map();
  const classifyIntervention = async (text, { selfChat, taskActive, conversationId }) => {
    if (config.semanticInterventionEnabled === true) {
      try {
        return await semanticInterventionClassifier(text, {
          selfChat,
          taskActive,
          recentTaskText: recentTaskText.get(conversationId) ?? "",
          environment: classifierEnvironment,
          timeoutMs: config.semanticInterventionTimeoutMs,
        });
      } catch {
        return {
          intent: "communication_takeover",
          source: "conservative_fallback",
          confidence: 0,
        };
      }
    }
    return {
      intent: classifyOwnerIntervention(text, { active: taskActive, explicitOnly: selfChat }),
      source: "legacy_fallback",
      confidence: 1,
    };
  };

  const dispatchIntervention = async ({
    conversationId,
    active,
    ownerMessageId,
    ownerContent,
    createTime,
    frozenControl,
    classification,
    emitFrame = emit,
  }) => {
    const control = {
      ...frozenControl,
      ownerRevision: Number(frozenControl.ownerRevision ?? 0) + 1,
      lastOwnerMessageId: ownerMessageId,
    };
    controlStates.set(conversationId, control);
    state.controlStates = Object.fromEntries(controlStates);
    takeoverReported.add(conversationId);
    state.takeoverReported = [...takeoverReported];
    await persistState();
    emitFrame({
      type: "event",
      record: {
        control: classification.intent,
        id: `takeover:${hash(conversationId)}:${epoch(createTime) ?? clock()}`,
        conversationId,
        participantUserId: active.participantUserId,
        chatType: active.chatType,
        enterpriseVerified: active.enterpriseVerified === true,
        sourceMessageId: active.sourceMessageId ?? null,
        ownerMessageId,
        ownerContent: String(ownerContent ?? "").slice(0, 20_000),
        ownerRevision: control.ownerRevision,
        sendGeneration: control.sendGeneration,
        createTime: new Date(createTime).toISOString(),
        classificationSource: String(classification.source ?? "unknown").slice(0, 40),
        classificationConfidence: Number.isFinite(Number(classification.confidence))
          ? Math.max(0, Math.min(1, Number(classification.confidence)))
          : null,
      },
    });
    if (controlStore) {
      await controlStore.recordIntervention({
        taskId: taskId(conversationId, active.participantUserId),
        type: classification.intent,
        ownerRevision: control.ownerRevision,
        sendGeneration: control.sendGeneration,
        occurredAt: createTime,
      });
    }
    return control;
  };

  const rememberReactionEvent = (eventId) => {
    if (seenReactionEvents.has(eventId)) return false;
    seenReactionEvents.add(eventId);
    if (seenReactionEvents.size > 5_000) {
      seenReactionEvents.delete(seenReactionEvents.values().next().value);
    }
    syncResponsibilityState();
    return true;
  };
  const resolveOwnerOpenDingTalkId = async () => {
    if (ownerOpenDingTalkId) return ownerOpenDingTalkId;
    if (!config.selfUserId || typeof dws.resolveUserOpenDingTalkId !== "function") {
      reactionWakeFailed.add("owner_identity");
      state.reactionWake.lastErrorCode = "reaction_owner_identity_unavailable";
      updateReactionWakeState();
      await persistState();
      return null;
    }
    try {
      ownerOpenDingTalkId = typeof dws.resolveCurrentUserOpenDingTalkId === "function"
        ? await dws.resolveCurrentUserOpenDingTalkId(config.selfUserId)
        : await dws.resolveUserOpenDingTalkId(config.selfUserId, null, {
            allowPolicyFallback: false,
          });
      reactionWakeFailed.delete("owner_identity");
      updateReactionWakeState();
      await persistState();
      return ownerOpenDingTalkId;
    } catch (error) {
      reactionWakeFailed.add("owner_identity");
      state.reactionWake.lastErrorCode = diagnosticCode(error, "owner_identity_failed");
      updateReactionWakeState();
      await persistState();
      diagnose(`dws_reaction_owner_identity_failed:${diagnosticCode(error, "owner_identity_failed")}`);
      return null;
    }
  };
  handleReactionEvent = async (event) => {
    if (
      config.responsibilityReactionsEnabled !== true ||
      !event || typeof event !== "object" || Array.isArray(event) ||
      !String(event.eventId ?? "").trim() ||
      seenReactionEvents.has(String(event.eventId))
    ) return;
    const eventId = String(event.eventId);
    if (consumeAutomatedReactionEvent(event)) {
      rememberReactionEvent(eventId);
      await persistState();
      return;
    }
    const ownerOpenId = await resolveOwnerOpenDingTalkId();
    if (!ownerOpenId || event.operatorOpenDingTalkId !== ownerOpenId) {
      rememberReactionEvent(eventId);
      await persistState();
      return;
    }
    const active = activeConversations.get(event.conversationId);
    if (!active) {
      rememberReactionEvent(eventId);
      await persistState();
      return;
    }
    if (
      event.senderOpenDingTalkId && active.participantOpenDingTalkId &&
      event.senderOpenDingTalkId !== active.participantOpenDingTalkId
    ) {
      rememberReactionEvent(eventId);
      await persistState();
      return;
    }
    const messageResponsibilities = [...responsibilityReactions.values()].filter((entry) =>
      entry.conversationId === event.conversationId &&
      Array.isArray(entry.sourceMessageIds) &&
      entry.sourceMessageIds.includes(event.messageId)
    );
    const claims = messageResponsibilities.filter((entry) =>
      ["claiming", "claimed", "clearing"].includes(entry.status)
    );
    const terminalResponsibility = messageResponsibilities.some((entry) =>
      ["cleared", "handled_no_reply"].includes(entry.status)
    );
    const removesHandledLabel = event.action === "removed" && messageResponsibilities.some((entry) =>
      entry.status === "handled_no_reply" &&
      entry.messageId === event.messageId &&
      entry.reactionName === event.reactionName
    );
    if (removesHandledLabel) {
      if (!rememberReactionEvent(eventId)) return;
      for (const entry of messageResponsibilities) {
        if (
          entry.status === "handled_no_reply" &&
          entry.messageId === event.messageId &&
          entry.reactionName === event.reactionName
        ) {
          entry.status = "cleared";
          entry.clearedAt = event.occurredAt;
        }
      }
      syncResponsibilityState();
      await persistState();
      return;
    }
    const currentAnchor = active.sourceMessageId === event.messageId && !terminalResponsibility;
    if (claims.length === 0 && !currentAnchor) {
      rememberReactionEvent(eventId);
      await persistState();
      return;
    }
    const removesResponsibility = event.action === "removed" && claims.some((entry) =>
      entry.messageId === event.messageId && entry.reactionName === event.reactionName
    );
    if (event.action === "removed" && !removesResponsibility) {
      rememberReactionEvent(eventId);
      await persistState();
      return;
    }
    if (!rememberReactionEvent(eventId)) return;
    const stableTaskId = taskId(event.conversationId, active.participantUserId);
    const externalControl = controlStore ? await controlStore.snapshot() : null;
    const externalTask = externalControl?.tasks?.[stableTaskId] ?? null;
    const localControl = normalizedControlState(controlStates.get(event.conversationId));
    const frozenControl = {
      ownerRevision: Math.max(localControl.ownerRevision, externalTask?.ownerRevision ?? 0),
      sendGeneration: Math.max(localControl.sendGeneration, externalTask?.sendGeneration ?? 0) + 1,
      lastOwnerMessageId: localControl.lastOwnerMessageId,
    };
    controlStates.set(event.conversationId, frozenControl);
    state.controlStates = Object.fromEntries(controlStates);
    await persistState();
    await dispatchIntervention({
      conversationId: event.conversationId,
      active,
      ownerMessageId: eventId,
      ownerContent: "",
      createTime: event.occurredAt,
      frozenControl,
      classification: {
        intent: "communication_takeover",
        source: "owner_reaction",
        confidence: 1,
      },
    });
    for (const entry of claims) {
      if (
        event.action === "removed" &&
        event.reactionName === entry.reactionName &&
        entry.messageId === event.messageId
      ) {
        entry.status = "cleared";
        entry.clearedAt = event.occurredAt;
        continue;
      }
      await releaseResponsibility({
        conversationId: entry.conversationId,
        messageId: entry.messageId,
      });
    }
    syncResponsibilityState();
    await persistState();
  };

  const emitMessage = async (message, chatType, mentionedSelf, emitFrame = emit) => {
    const id = String(message.id ?? "").trim();
    const conversationId = String(message.conversationId ?? "").trim();
    const senderUserId = String(message.senderUserId ?? "").trim();
    const senderOpenDingTalkId = String(message.senderOpenDingTalkId ?? "").trim();
    const createTime = new Date(message.createTime).toISOString();
    if (!id || !conversationId || !senderUserId || seen.has(id)) return;
    if (message.isWithdrawn === true) {
      if (!remember(id)) return;
      await releaseConversationResponsibilities(conversationId, id);
      emitFrame({
        type: "event",
        record: {
          control: "message_withdrawn",
          id: `withdrawn:${hash(id)}`,
          messageId: id,
          conversationId,
          participantUserId: senderUserId,
          chatType,
          enterpriseVerified: message.enterpriseVerified === true,
          createTime: message.withdrawnAt
            ? new Date(message.withdrawnAt).toISOString()
            : createTime,
        },
      });
      return;
    }
    const stableTaskId = taskId(conversationId, senderUserId);
    const externalControl = controlStore ? await controlStore.snapshot() : null;
    const externalTask = externalControl?.tasks?.[stableTaskId] ?? null;
    const priorActive = activeConversations.get(conversationId) ?? null;
    const ownerSelfMessage = Boolean(config.selfUserId && senderUserId === config.selfUserId);
    const selfInterventionCandidate = Boolean(
      ownerSelfMessage && priorActive && ownerInterventionCandidate(message.content),
    );
    const globalPaused = externalControl?.global?.state === "paused";
    const taskPaused = externalTask?.state === "paused";
    const taskTakenOver = externalTask?.state === "taken_over";
    if (
      globalPaused || taskPaused || taskTakenOver
    ) {
      if (!selfInterventionCandidate) {
        if (taskTakenOver && !globalPaused && !taskPaused) {
          if (!remember(id)) return;
          diagnose(`dws_taken_over_message_suppressed:${hash(id)}`);
          return;
        }
        const error = new Error("Foursday control paused this task");
        error.code = "FOURSDAY_CONTROL_PAUSED";
        throw error;
      }
    }
    const localControl = normalizedControlState(controlStates.get(conversationId));
    const priorControl = {
      ownerRevision: Math.max(localControl.ownerRevision, externalTask?.ownerRevision ?? 0),
      sendGeneration: Math.max(localControl.sendGeneration, externalTask?.sendGeneration ?? 0),
      lastOwnerMessageId: localControl.lastOwnerMessageId,
    };
    const control = {
      ...priorControl,
      sendGeneration: Number(priorControl.sendGeneration ?? 0) + 1,
    };
    if (selfInterventionCandidate) {
      controlStates.set(conversationId, control);
      state.controlStates = Object.fromEntries(controlStates);
      const classification = await classifyIntervention(message.content, {
        selfChat: true,
        taskActive: !["paused", "taken_over"].includes(externalTask?.state),
        conversationId,
      });
      if (classification.intent !== "unrelated_owner_message") {
        if (!remember(id)) return;
        await dispatchIntervention({
          conversationId,
          active: priorActive,
          ownerMessageId: id,
          ownerContent: message.content,
          createTime,
          frozenControl: control,
          classification,
          emitFrame,
        });
        if (["communication_takeover", "task_takeover"].includes(classification.intent)) {
          await releaseConversationResponsibilities(
            conversationId,
            priorActive?.sourceMessageId ?? null,
          );
        }
        return;
      }
      controlStates.set(conversationId, priorControl);
      state.controlStates = Object.fromEntries(controlStates);
    }
    if (taskTakenOver && !globalPaused && !taskPaused) {
      if (!remember(id)) return;
      diagnose(`dws_taken_over_message_suppressed:${hash(id)}`);
      return;
    }
    if (globalPaused || taskPaused) {
      const error = new Error("Foursday control paused this task");
      error.code = "FOURSDAY_CONTROL_PAUSED";
      throw error;
    }
    const attachments = [];
    if (config.mediaRoot && Array.isArray(message.media)) {
      for (const item of message.media.slice(0, 8)) {
        const resourceType = item.resourceType ?? "mediaId";
        const outputDirectory = join(
          config.mediaRoot,
          hash(`${id}:${resourceType}:${item.resourceId}`),
        );
        const downloaded = await dws.downloadMedia({
          resourceId: item.resourceId,
          resourceType,
          messageId: id,
          conversationId,
          outputDirectory,
        });
        attachments.push({
          path: downloaded.path,
          name: item.name ?? null,
          mimeType: item.mimeType ?? null,
        });
      }
    }
    if (controlStore) {
      await controlStore.observeTask({
        taskId: stableTaskId,
        projectId: null,
        ownerRevision: control.ownerRevision,
        sendGeneration: control.sendGeneration,
        lastInboundAt: createTime,
      });
    }
    if (!remember(id)) return;
    recipients.set(conversationId, {
      chatType,
      recipientId: senderOpenDingTalkId || senderUserId,
      recipientKind: senderOpenDingTalkId ? "open_dingtalk_id" : "user_id",
    });
    state.recipients = Object.fromEntries(recipients);
    activeConversations.set(conversationId, {
      participantUserId: senderUserId,
      participantOpenDingTalkId: senderOpenDingTalkId || null,
      chatType,
      after: createTime,
      sourceMessageId: id,
      ownerRevision: control.ownerRevision,
      sendGeneration: control.sendGeneration,
      observedAt: String(message.detectedAt ?? now().toISOString()),
      detectionLatencyMs: Number.isFinite(Number(message.detectionLatencyMs))
        ? Math.max(0, Number(message.detectionLatencyMs))
        : null,
      wakeSource: String(message.wakeSource ?? "unknown").slice(0, 40),
      enterpriseVerified: message.enterpriseVerified === true,
    });
    controlStates.set(conversationId, control);
    state.controlStates = Object.fromEntries(controlStates);
    takeoverReported.delete(conversationId);
    state.takeoverReported = [...takeoverReported];
    state.activeConversations = Object.fromEntries(activeConversations);
    recentTaskText.set(conversationId, String(message.content ?? "").trim().slice(0, 2_000));
    if (recentTaskText.size > 1_000) recentTaskText.delete(recentTaskText.keys().next().value);
    if (config.responsibilityReactionsEnabled === true) {
      await ensureReactionWake({
        chatType,
        conversationId,
        participantUserId: senderUserId,
        participantOpenDingTalkId: senderOpenDingTalkId || null,
        participantName: message.senderName,
      });
    }
    emitFrame({
      type: "event",
      record: {
        id,
        senderUserId,
        senderOpenDingTalkId: senderOpenDingTalkId || null,
        senderName: String(message.senderName ?? "").trim() || senderUserId,
        conversationId,
        content: String(message.content ?? "").trim(),
        createTime,
        chatType,
        mentionedSelf,
        isSelf: message.isSelf === true,
        enterpriseVerified: message.enterpriseVerified === true,
        resourceEnrichmentUnavailable: message.resourceEnrichmentUnavailable === true,
        attachments,
        ownerRevision: control.ownerRevision,
        sendGeneration: control.sendGeneration,
        detectedAt: String(message.detectedAt ?? "") || null,
        detectionLatencyMs: Number.isFinite(Number(message.detectionLatencyMs))
          ? Math.max(0, Number(message.detectionLatencyMs))
          : null,
        wakeSource: String(message.wakeSource ?? "unknown").slice(0, 40),
      },
    });
  };

  const check = async ({
    deferEmit = false,
    wakeSource = "manual",
    reconcileLookbackMs = null,
    onStarted = null,
  } = {}) => {
    if (running) {
      pending = true;
      pendingWakeSource = strongerWakeSource(pendingWakeSource, wakeSource);
      return;
    }
    running = true;
    const startedAt = now();
    const generation = Number(state.checkLifecycle?.generation ?? 0) + 1;
    const operation = reconcileLookbackMs == null ? "history_check" : "history_reconcile";
    state.lastWakeSource = wakeSource;
    state.checkLifecycle = {
      status: "running",
      generation,
      operation,
      wakeSource,
      startedAt: startedAt.toISOString(),
      completedAt: null,
      errorCount: 0,
    };
    let lifecycleFinished = false;
    try {
      await persistState();
      if (typeof onStarted === "function") await onStarted();
      const end = startedAt;
      const deferredFrames = [];
      const dispatch = deferEmit
        ? (frame) => deferredFrames.push(frame)
        : emit;
      const targets = [
        ...config.userIds.map((id) => ({ kind: "user", id })),
        ...config.groupIds.map((id) => ({ kind: "group", id })),
        ...(config.enterpriseUsersEnabled ? [{ kind: "enterprise", id: "current_org" }] : []),
      ];
      const results = await Promise.allSettled(targets.map(async (target) => {
        const checkpoints = target.kind === "user"
          ? state.lastUsers
          : target.kind === "group"
            ? state.lastGroups
            : null;
        const last = epoch(target.kind === "enterprise"
          ? state.lastEnterpriseAt
          : checkpoints[target.id]);
        const historySettleMs = Number.isFinite(Number(config.historySettleMs))
          ? Math.max(0, Number(config.historySettleMs))
          : 120_000;
        const requestedLookbackMs = Number.isFinite(Number(reconcileLookbackMs))
          ? Math.max(historySettleMs, Number(reconcileLookbackMs))
          : historySettleMs;
        const safeHistoryBoundary = Math.max(0, end.getTime() - requestedLookbackMs);
        const start = new Date(last == null
          ? end.getTime() - config.initialLookbackMs
          : Math.max(0, Math.min(last, safeHistoryBoundary) - 5_000));
        const targetEnd = target.kind === "enterprise"
          ? new Date(Math.max(start.getTime() + 1_000, end.getTime() - 10_000))
          : end;
        let messages;
        if (target.kind === "enterprise") {
          if (typeof dws.fetchEnterpriseDirect !== "function") {
            if (typeof dws.fetchEnterpriseDirectScan !== "function") {
              throw new Error("DWS enterprise message scan is unavailable");
            }
          }
          const recovered = await retryEnterpriseIdentities(end);
          if (typeof dws.fetchEnterpriseDirectScan === "function") {
            const scan = await dws.fetchEnterpriseDirectScan({
              start,
              end: targetEnd,
              selfUserId: config.selfUserId,
            });
            for (const candidate of scan.pending ?? []) {
              enqueueIdentityRetry(candidate, end);
            }
            for (const rejected of scan.rejected ?? []) {
              recordIdentityRejection(rejected.message, rejected.errorCode);
            }
            messages = [
              ...recovered,
              ...(scan.messages ?? []).map((message) => {
                const key = enterpriseIdentityRetryKey(message.id);
                return enterpriseIdentityQueue.has(key)
                  ? { ...message, enterpriseIdentityRetryKey: key }
                  : message;
              }),
            ];
          } else {
            messages = [
              ...recovered,
              ...await dws.fetchEnterpriseDirect({
                start,
                end: targetEnd,
                selfUserId: config.selfUserId,
              }),
            ];
          }
        } else if (target.kind === "user" && target.id === config.selfUserId) {
          const lookbackMs = Math.min(
            24 * 60 * 60 * 1_000,
            Math.max(60_000, end.getTime() - start.getTime()),
          );
          messages = (await dws.fetchDirect({
            userId: target.id,
            identityKind: "user_id",
            before: end,
            limit: 50,
            lookbackMs,
          })).filter((message) =>
            (epoch(message.createTime) ?? 0) >= start.getTime() &&
            !isAutomatedSelfMessage(message, automatedSendEvidence)
          );
        } else if (target.kind === "user") {
          messages = await dws.fetchBySender({ senderUserId: target.id, start, end });
        } else {
          messages = await dws.fetchGroupMentions({ groupIds: [target.id], start, end });
        }
        return { target, messages };
      }));
      const errors = [];
      for (const [index, result] of results.entries()) {
        const target = targets[index];
        if (result.status === "rejected") {
          errors.push(result.reason);
          const code = String(
            result.reason?.code ?? result.reason?.name ?? "error",
          ).replaceAll(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) || "error";
          diagnose(
            `dws_sidecar_target_failed:${target.kind}:${index}:${hash(target.id)}:${code}`,
          );
          continue;
        }
        const orderedMessages = [...result.value.messages].sort((left, right) =>
          (epoch(left.createTime) ?? 0) - (epoch(right.createTime) ?? 0)
        );
        let targetFailed = false;
        for (const message of orderedMessages) {
          try {
            const createdAt = epoch(message.createTime);
            const detectionLatencyMs = createdAt == null
              ? null
              : Math.max(0, end.getTime() - createdAt);
            state.lastDetection = {
              detectedAt: end.toISOString(),
              latencyMs: detectionLatencyMs,
              wakeSource,
            };
            await emitMessage(
              {
                ...message,
                detectedAt: end.toISOString(),
                detectionLatencyMs,
                wakeSource,
              },
              target.kind === "group" ? "group" : "direct",
              target.kind === "group",
              dispatch,
            );
            if (message.enterpriseIdentityRetryKey) {
              enterpriseIdentityQueue.delete(message.enterpriseIdentityRetryKey);
              syncEnterpriseIdentityQueue();
              diagnose(`dws_enterprise_identity_retry_resolved:${hash(message.id)}`);
            }
          } catch (error) {
            errors.push(error);
            targetFailed = true;
            const code = diagnosticCode(error, "message_processing_failed");
            diagnose(
              `dws_sidecar_target_failed:${target.kind}:${index}:${hash(target.id)}:${code}`,
            );
            break;
          }
        }
        if (targetFailed) continue;
        const checkpoints = target.kind === "user"
          ? state.lastUsers
          : target.kind === "group"
            ? state.lastGroups
            : null;
        const last = epoch(target.kind === "enterprise"
          ? state.lastEnterpriseAt
          : checkpoints[target.id]) ?? 0;
        const historySettleMs = Number.isFinite(Number(config.historySettleMs))
          ? Math.max(0, Number(config.historySettleMs))
          : 120_000;
        const nextCheckpoint = new Date(Math.max(
          last,
          end.getTime() - historySettleMs,
        )).toISOString();
        if (target.kind === "enterprise") state.lastEnterpriseAt = nextCheckpoint;
        else checkpoints[target.id] = nextCheckpoint;
      }
      if (config.selfUserId && typeof dws.hasManualReply === "function") {
        for (const [conversationId, active] of activeConversations) {
          if (takeoverReported.has(conversationId)) continue;
          let manual;
          try {
            manual = await probeManualReply({
              conversationId,
              selfUserId: config.selfUserId,
              after: active.after,
              now: end,
              automatedSendEvidence,
            });
          } catch (error) {
            continue;
          }
          if (manual?.known === true && manual.replied === true) {
            const ownerMessageId = String(manual.message?.id ?? "").trim() ||
              `owner:${hash(`${conversationId}:${manual.message?.createTime ?? end.toISOString()}`)}`;
            const priorControl = normalizedControlState(controlStates.get(conversationId));
            if (priorControl.lastOwnerMessageId === ownerMessageId) continue;
            const selfChat = active.participantUserId === config.selfUserId;
            if (selfChat && active.sourceMessageId === ownerMessageId) continue;
            const frozenControl = {
              ...priorControl,
              sendGeneration: Number(priorControl.sendGeneration ?? 0) + 1,
              lastOwnerMessageId: ownerMessageId,
            };
            controlStates.set(conversationId, frozenControl);
            state.controlStates = Object.fromEntries(controlStates);
            const classification = await classifyIntervention(manual.message?.content, {
              selfChat,
              taskActive: true,
              conversationId,
            });
            if (classification.intent === "unrelated_owner_message") {
              controlStates.set(conversationId, priorControl);
              state.controlStates = Object.fromEntries(controlStates);
              continue;
            }
            await dispatchIntervention({
              conversationId,
              active,
              ownerMessageId,
              ownerContent: manual.message?.content,
              createTime: manual.message?.createTime ?? end.toISOString(),
              frozenControl,
              classification,
              emitFrame: dispatch,
            });
          }
        }
      }
      if (controlStore) {
        const controls = await controlStore.snapshot();
        for (const [conversationId, active] of activeConversations) {
          const stableTaskId = taskId(conversationId, active.participantUserId);
          const task = controls.tasks?.[stableTaskId];
          const event = task?.pendingEvent;
          if (!event || event.consumed) continue;
          dispatch({
            type: "event",
            record: {
              control: event.type,
              id: `control:${event.id}`,
              conversationId,
              participantUserId: active.participantUserId,
              chatType: active.chatType,
              enterpriseVerified: active.enterpriseVerified === true,
              sourceMessageId: active.sourceMessageId ?? null,
              ownerMessageId: event.id,
              ownerContent: event.note,
              taskId: stableTaskId,
              controlEventId: event.id,
              ownerRevision: task.ownerRevision,
              sendGeneration: task.sendGeneration,
              createTime: event.createdAt,
            },
          });
        }
      }
      const completedAt = now();
      state.lastCheckAt = completedAt.toISOString();
      state.lastErrorCount = errors.length;
      if (errors.length === 0) state.lastFullSuccessAt = completedAt.toISOString();
      state.checkLifecycle = {
        status: errors.length === 0 ? "completed" : "failed",
        generation,
        operation,
        wakeSource,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        errorCount: errors.length,
      };
      await (deferEmit ? persistCheckHealth() : persistState());
      lifecycleFinished = true;
      if (errors.length > 0) {
        const error = new Error("One or more DWS shadow targets are unavailable");
        error.code = "DWS_SIDECAR_TARGETS_UNAVAILABLE";
        throw error;
      }
      return deferredFrames;
    } catch (error) {
      if (!lifecycleFinished) {
        const completedAt = now();
        state.lastCheckAt = completedAt.toISOString();
        state.lastErrorCount = Math.max(1, Number(state.lastErrorCount ?? 0));
        state.checkLifecycle = {
          status: "failed",
          generation,
          operation,
          wakeSource,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          errorCount: state.lastErrorCount,
        };
        await (deferEmit ? persistCheckHealth() : persistState());
      }
      throw error;
    } finally {
      running = false;
      if (pending) {
        pending = false;
        const source = pendingWakeSource ?? "manual";
        pendingWakeSource = null;
        queueMicrotask(() => check({ wakeSource: source }).catch((error) => {
          diagnose(`dws_sidecar_check_failed:${String(error?.code ?? error?.name ?? "error")}`);
        }));
      }
    }
  };

  const trigger = (wakeSource = "filesystem") => {
    pendingWakeSource = strongerWakeSource(pendingWakeSource, wakeSource);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const source = pendingWakeSource ?? wakeSource;
      pendingWakeSource = null;
      check({ wakeSource: source }).catch((error) => {
      diagnose(`dws_sidecar_check_failed:${String(error?.code ?? error?.name ?? "error")}`);
      });
    }, 250);
  };

  if (config.dingtalkRoot && isAbsolute(config.dingtalkRoot)) {
    for (const directory of await discoverWatchDirectories(config.dingtalkRoot)) {
      const watcher = watch(directory, { persistent: true }, () => trigger("filesystem"));
      watcher.on("error", () => {});
      watchers.push(watcher);
    }
  }
  fallbackTimer = setInterval(() => trigger("fallback"), config.fallbackMs);

  return {
    async start() {
      if (!config.sendEnabled && state.sendBlocked) {
        state.sendBlocked = false;
        state.sendBlockReason = null;
        state.sendBlockedAt = null;
      }
      if (config.responsibilityReactionsEnabled === true) {
        const claimedConversations = new Set([...responsibilityReactions.values()]
          .filter((entry) => !["clearing", "cleared"].includes(entry.status))
          .map((entry) => entry.conversationId));
        if (claimedConversations.size > 0) await resolveOwnerOpenDingTalkId();
        for (const conversationId of claimedConversations) {
          const active = activeConversations.get(conversationId);
          if (!active) continue;
          await ensureReactionWake({
            chatType: active.chatType,
            conversationId,
            participantUserId: active.participantUserId,
            participantOpenDingTalkId: active.participantOpenDingTalkId,
          });
        }
      } else {
        state.reactionWake = {
          enabled: false, readyCount: 0, errorCount: 0,
          lastErrorCode: null, updatedAt: now().toISOString(),
        };
      }
      let initialFrames = [];
      try {
        initialFrames = await check({
          deferEmit: true,
          wakeSource: "startup",
          reconcileLookbackMs: config.initialLookbackMs,
          onStarted: () => emit({
            type: "ready",
            transport: watchers.length > 0 ? "filesystem-events-with-fallback" : "fallback",
            targets: config.userIds.length,
            groups: config.groupIds.length,
            reconciling: true,
          }),
        });
      } catch (error) {
        diagnose(`dws_sidecar_initial_reconcile_failed:${String(error?.code ?? error?.name ?? "error")}`);
      }
      for (const frame of initialFrames) emit(frame);
      await persistState();
      if (
        config.eventWakeEnabled &&
        typeof dws.createPersonalEventWake === "function"
      ) {
        state.eventWake = {
          enabled: true,
          ready: false,
          errorCode: null,
          updatedAt: now().toISOString(),
        };
        await persistState();
        try {
          eventWakeController = dws.createPersonalEventWake({
            onEvent: () => trigger("dws_event"),
            onDiagnostic: (value) => {
              diagnose(value);
              if (String(value).startsWith("dws_event_closed:")) {
                state.eventWake = {
                  enabled: true,
                  ready: false,
                  errorCode: "dws_event_closed",
                  updatedAt: now().toISOString(),
                };
                persistState().catch(() => {});
              }
            },
          });
        } catch (error) {
          state.eventWake = {
            enabled: true,
            ready: false,
            errorCode: String(error?.code ?? "dws_event_unavailable").slice(0, 80),
            updatedAt: now().toISOString(),
          };
          diagnose(`dws_event_wake_unavailable:${state.eventWake.errorCode}`);
          await persistState();
        }
        if (!eventWakeController) return;
        eventWakeController.ready.then(async () => {
          state.eventWake = {
            enabled: true,
            ready: true,
            errorCode: null,
            updatedAt: now().toISOString(),
          };
          await persistState();
        }).catch(async (error) => {
          state.eventWake = {
            enabled: true,
            ready: false,
            errorCode: String(error?.code ?? "dws_event_unavailable").slice(0, 80),
            updatedAt: now().toISOString(),
          };
          diagnose(`dws_event_wake_unavailable:${state.eventWake.errorCode}`);
          await persistState();
        });
      } else {
        state.eventWake = {
          enabled: false,
          ready: false,
          errorCode: null,
          updatedAt: now().toISOString(),
        };
        await persistState();
      }
    },
    async send(payload) {
      const conversationId = String(payload?.conversationId ?? "").trim();
      const route = recipients.get(conversationId);
      if (!route) return { success: false, error: "DWS conversation recipient is unknown" };
      const ownerRevision = Number(payload?.ownerRevision);
      const sendGeneration = Number(payload?.sendGeneration);
      const active = activeConversations.get(conversationId);
      const replyFenceCurrent = async () => {
        const local = controlStates.get(conversationId);
        const external = controlStore && active
          ? await controlStore.snapshot()
          : null;
        const task = active
          ? external?.tasks?.[taskId(conversationId, active.participantUserId)]
          : null;
        const reactionReady = config.responsibilityReactionsEnabled !== true || Boolean(
          ownerOpenDingTalkId && active && reactionWakeReady.has(reactionTargetKey({
            chatType: active.chatType,
            conversationId,
            participantOpenDingTalkId: active.participantOpenDingTalkId,
          }))
        );
        return Boolean(
          Number.isSafeInteger(ownerRevision) &&
          Number.isSafeInteger(sendGeneration) &&
          local && local.ownerRevision === ownerRevision &&
          local.sendGeneration === sendGeneration &&
          external?.global?.state !== "paused" &&
          reactionReady &&
          !["paused", "taken_over"].includes(task?.state) &&
          (!task || (
            task.ownerRevision === ownerRevision &&
            task.sendGeneration === sendGeneration
          ))
        );
      };
      if (
        !await replyFenceCurrent()
      ) {
        return {
          success: false,
          staleGeneration: true,
          error: "DWS reply lost its owner revision or send generation",
        };
      }
      const observedAt = epoch(active?.observedAt);
      const detectionLatencyMs = Number(active?.detectionLatencyMs);
      const adaptiveQuietMs = Math.min(
        config.outboundMaxQuietMs,
        config.outboundQuietMs + (
          Number.isFinite(detectionLatencyMs) ? Math.max(0, detectionLatencyMs) : 0
        ),
      );
      if (observedAt != null && adaptiveQuietMs > 0) {
        const remaining = observedAt + adaptiveQuietMs - clock();
        if (remaining > 0) await wait(remaining);
      }
      if (!await replyFenceCurrent()) {
        return {
          success: false,
          staleGeneration: true,
          error: "DWS reply was replaced during the outbound quiet window",
        };
      }
      if (!config.sendEnabled) {
        return {
          success: false,
          sendDisabled: true,
          error: "DWS personal send is disabled",
        };
      }
      if (state.sendBlocked) {
        return {
          success: false,
          outcomeUnknown: true,
          sendSuspended: true,
          error: "DWS personal sending is suspended after an unknown outcome",
        };
      }
      const sendKey = stableSendKey(payload);
      const existing = sendLedger.get(sendKey);
      if (existing?.status === "completed" && existing.messageId) {
        return {
          success: true,
          messageId: existing.messageId,
          receiptKind: "idempotent_server",
        };
      }
      if (existing) {
        if (existing.status === "unknown" && !state.sendBlocked) {
          await blockSending("unresolved_prior_intent");
        }
        return {
          success: false,
          outcomeUnknown: true,
          error: "DWS send has an unresolved prior intent",
        };
      }
      const deferredDeadlineAt = clock() + deferredReplyRetentionMs;
      state.deferredReply = {
        waiting: true,
        attemptCount: 0,
        errorCode: null,
        expiresAt: new Date(deferredDeadlineAt).toISOString(),
        updatedAt: now().toISOString(),
      };
      await persistState();
      const finishDeferredReply = (errorCode = null) => {
        state.deferredReply = {
          ...state.deferredReply,
          waiting: false,
          errorCode,
          updatedAt: now().toISOString(),
        };
      };
      let manualReply;
      try {
        manualReply = await probeManualReply({
          conversationId,
          selfUserId: config.selfUserId,
          after: active?.after,
          now: now(),
          automatedSendEvidence,
        }, {
          retryDelays: deferredReplyRetryDelays,
          timeoutMs: deferredReplyProbeTimeoutMs,
          deadlineAt: deferredDeadlineAt,
          beforeAttempt: async () => {
            if (
              !config.sendEnabled || state.sendBlocked ||
              !await replyFenceCurrent()
            ) {
              const error = new Error("Foursday deferred reply lost its safety fence");
              error.code = "deferred_reply_stale";
              throw error;
            }
          },
          onFailure: async ({ attemptCount, errorCode }) => {
            state.deferredReply = {
              ...state.deferredReply,
              waiting: true,
              attemptCount,
              errorCode,
              updatedAt: now().toISOString(),
            };
            await persistState();
          },
        });
      } catch (error) {
        const errorCode = manualReplyErrorCode(error);
        finishDeferredReply(errorCode);
        await persistState();
        return {
          success: false,
          staleGeneration: true,
          manualReplyUnknown: !["deferred_reply_stale", "deferred_reply_expired"]
            .includes(errorCode),
          deferredReplyExpired: errorCode === "deferred_reply_expired",
          sendSuspended: true,
          error: "DWS manual-reply verification is unavailable",
        };
      }
      if (manualReply.replied === true) {
        finishDeferredReply("owner_reply_detected");
        await persistState();
        return {
          success: false,
          staleGeneration: true,
          manualReplyDetected: true,
          error: "DWS detected an owner reply before transport",
        };
      }
      if (state.sendBlocked) {
        finishDeferredReply("send_blocked");
        await persistState();
        return {
          success: false,
          outcomeUnknown: true,
          sendSuspended: true,
          error: "DWS personal sending became blocked during verification",
        };
      }
      if (!await replyFenceCurrent()) {
        finishDeferredReply("deferred_reply_stale");
        await persistState();
        return {
          success: false,
          staleGeneration: true,
          error: "DWS reply became stale after manual-reply verification",
        };
      }
      finishDeferredReply(null);
      const idempotencyKey = idempotencyUuid(sendKey);
      const startedAt = now().toISOString();
      const orderedListFingerprint = dwsMessageUsesOrderedList(payload?.content);
      const intent = {
        status: "sending",
        conversationId,
        startedAt,
        idempotencyKey,
        contentDigest: dwsMessageContentDigest(payload?.content),
        contentFingerprint: dwsMessageContentFingerprint(payload?.content),
        fingerprintVersion: 2,
        ...(orderedListFingerprint ? {
          orderedListFingerprint: true,
          contentRenderFingerprint: dwsMessageContentRenderFingerprint(payload?.content),
        } : {}),
      };
      sendLedger.set(sendKey, intent);
      rememberAutomatedSend(intent);
      while (sendLedger.size > 1_000) sendLedger.delete(sendLedger.keys().next().value);
      state.sendLedger = Object.fromEntries(sendLedger);
      await persistState();
      if (!await replyFenceCurrent()) {
        sendLedger.set(sendKey, { ...intent, status: "cancelled_stale" });
        state.sendLedger = Object.fromEntries(sendLedger);
        await persistState();
        return {
          success: false,
          staleGeneration: true,
          error: "DWS reply became stale before transport",
        };
      }
      let receipt;
      try {
        receipt = await dws.sendMessage({
          conversationId,
          recipientId: route.recipientId,
          recipientKind: route.recipientKind ?? null,
          chatType: route.chatType,
          text: String(payload?.content ?? ""),
          idempotencyKey,
        });
      } catch {
        const unknown = { ...intent, status: "unknown" };
        sendLedger.set(sendKey, unknown);
        rememberAutomatedSend(unknown);
        state.sendLedger = Object.fromEntries(sendLedger);
        await blockSending("transport_exception_after_intent");
        return {
          success: false,
          outcomeUnknown: true,
          error: "DWS send failed after intent persistence",
        };
      }
      const evidence = {
        ...intent,
        taskId: idempotencyKey,
        receipt,
      };
      let receiptError = null;
      try {
        dws.verifySendReceipt(receipt);
      } catch (error) {
        receiptError = error;
      }
      if (receiptError?.code === "dws_send_failed") {
        const failed = { ...intent, status: "failed" };
        sendLedger.set(sendKey, failed);
        rememberAutomatedSend({ ...failed, receipt });
        state.sendLedger = Object.fromEntries(sendLedger);
        await persistState();
        return {
          success: false,
          error: "DWS returned an explicit send failure",
        };
      }
      const serverMessageId = messageIdFromReceipt(receipt) ??
        await readBackSentMessage({ dws, route, conversationId, evidence });
      if (!serverMessageId) {
        const unknown = { ...intent, status: "unknown" };
        sendLedger.set(sendKey, unknown);
        rememberAutomatedSend({ ...unknown, receipt });
        state.sendLedger = Object.fromEntries(sendLedger);
        await blockSending("missing_server_message_id");
        return {
          success: false,
          outcomeUnknown: true,
          error: "DWS explicit receipt did not include a server message ID",
        };
      }
      const completed = {
        ...intent,
        status: "completed",
        messageId: serverMessageId,
      };
      sendLedger.set(sendKey, completed);
      rememberAutomatedSend({ ...completed, receipt });
      state.sendLedger = Object.fromEntries(sendLedger);
      await persistState();
      return {
        success: true,
        messageId: serverMessageId,
        receiptKind: "server",
      };
    },
    async ackControl(payload) {
      if (!controlStore) return { success: false, error: "Foursday control store is disabled" };
      const task = String(payload?.taskId ?? "");
      const eventId = String(payload?.eventId ?? "");
      if (!/^[a-f0-9]{64}$/u.test(task) || !/^[A-Za-z0-9-]{1,100}$/u.test(eventId)) {
        return { success: false, error: "Foursday control acknowledgement is invalid" };
      }
      const result = await controlStore.consumeEvent(task, eventId);
      return { success: result.result.consumed === true };
    },
    claimResponsibility,
    releaseResponsibility,
    settleResponsibility,
    groupResponsibilityMessages,
    async stop() {
      clearInterval(fallbackTimer);
      clearTimeout(debounceTimer);
      for (const watcher of watchers) watcher.close();
      if (eventWakeController) await eventWakeController.stop();
      for (const controller of reactionWakeControllers.values()) {
        await controller.stop();
      }
      reactionWakeControllers.clear();
      reactionWakeReady.clear();
      reactionWakeFailed.clear();
      await persistState();
    },
    check,
  };
}

async function runProtocol() {
  const runtime = await createSidecarRuntime();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame?.type !== "request") return;
    const id = String(frame.id ?? "");
    try {
      const result = frame.action === "send"
        ? await runtime.send(frame.payload)
        : frame.action === "ack-control"
          ? await runtime.ackControl(frame.payload)
        : frame.action === "claim-responsibility"
          ? await runtime.claimResponsibility(frame.payload)
        : frame.action === "release-responsibility"
          ? await runtime.releaseResponsibility(frame.payload)
        : frame.action === "settle-responsibility"
          ? await runtime.settleResponsibility(frame.payload)
        : frame.action === "group-responsibility"
          ? await runtime.groupResponsibilityMessages(frame.payload)
        : frame.action === "shutdown"
          ? { success: true }
          : { success: false, error: "Unsupported DWS sidecar action" };
      process.stdout.write(`${JSON.stringify({ type: "response", id, result })}\n`);
      if (frame.action === "shutdown") {
        await runtime.stop();
        process.exit(0);
      }
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        type: "response",
        id,
        result: { success: false, error: String(error?.code ?? error?.name ?? "error") },
      })}\n`);
    }
  });
  await runtime.start();
}

if (isMainModule(import.meta.url)) {
  await runProtocol();
}

export { hash };
