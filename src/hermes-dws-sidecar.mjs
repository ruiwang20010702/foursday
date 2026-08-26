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
    recipients: {}, activeConversations: {}, takeoverReported: [],
    controlStates: {},
    sendLedger: {}, lastCheckAt: null, lastFullSuccessAt: null, lastErrorCount: 0,
    checkLifecycle: normalizeDwsCheckLifecycle(),
    sendBlocked: false, sendBlockReason: null, sendBlockedAt: null,
    manualReplyProbe: { ready: null, errorCode: null, updatedAt: null },
    deferredReply: {
      waiting: false, attemptCount: 0, errorCode: null,
      expiresAt: null, updatedAt: null,
    },
    lastWakeSource: null,
    lastDetection: null,
    eventWake: { enabled: false, ready: false, errorCode: null, updatedAt: null },
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
      recentMessageIds: Array.isArray(parsed?.recentMessageIds)
        ? parsed.recentMessageIds.map(String).filter(Boolean).slice(-5_000)
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
  const seen = new Set(state.recentMessageIds);
  const recipients = new Map(Object.entries(state.recipients));
  const activeConversations = new Map(Object.entries(state.activeConversations));
  const takeoverReported = new Set(state.takeoverReported);
  const controlStates = new Map(Object.entries(state.controlStates).map(([key, value]) => [
    key,
    normalizedControlState(value),
  ]));
  const sendLedger = new Map(Object.entries(state.sendLedger));
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
  let fallbackTimer = null;
  let debounceTimer = null;
  let running = false;
  let pending = false;
  let pendingWakeSource = null;
  let stateWrite = Promise.resolve();
  const persistState = () => {
    const snapshot = structuredClone(state);
    const current = stateWrite.catch(() => {}).then(() => saveState(config.stateFile, snapshot));
    stateWrite = current;
    return current;
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

  const emitMessage = async (message, chatType, mentionedSelf, emitFrame = emit) => {
    const id = String(message.id ?? "").trim();
    const conversationId = String(message.conversationId ?? "").trim();
    const senderUserId = String(message.senderUserId ?? "").trim();
    const senderOpenDingTalkId = String(message.senderOpenDingTalkId ?? "").trim();
    const createTime = new Date(message.createTime).toISOString();
    if (!id || !conversationId || !senderUserId || seen.has(id)) return;
    if (message.isWithdrawn === true) {
      if (!remember(id)) return;
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
    if (
      externalControl?.global?.state === "paused" ||
      ["paused", "taken_over"].includes(externalTask?.state)
    ) {
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
            throw new Error("DWS enterprise message scan is unavailable");
          }
          messages = await dws.fetchEnterpriseDirect({
            start,
            end: targetEnd,
            selfUserId: config.selfUserId,
          });
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
          } catch (error) {
            errors.push(error);
            targetFailed = true;
            diagnose(
              `dws_sidecar_target_failed:${target.kind}:${index}:${hash(target.id)}:message_processing_failed`,
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
            const intervention = classifyOwnerIntervention(manual.message?.content, {
              active: true,
              explicitOnly: active.participantUserId === config.selfUserId,
            });
            if (intervention === "unrelated_owner_message") continue;
            const ownerMessageId = String(manual.message?.id ?? "").trim() ||
              `owner:${hash(`${conversationId}:${manual.message?.createTime ?? end.toISOString()}`)}`;
            const priorControl = normalizedControlState(controlStates.get(conversationId));
            if (priorControl.lastOwnerMessageId === ownerMessageId) continue;
            const control = {
              ...priorControl,
              ownerRevision: Number(priorControl.ownerRevision ?? 0) + 1,
              sendGeneration: Number(priorControl.sendGeneration ?? 0) + 1,
              lastOwnerMessageId: ownerMessageId,
            };
            controlStates.set(conversationId, control);
            state.controlStates = Object.fromEntries(controlStates);
            takeoverReported.add(conversationId);
            state.takeoverReported = [...takeoverReported];
            dispatch({
              type: "event",
              record: {
                control: intervention,
                id: `takeover:${hash(conversationId)}:${end.getTime()}`,
                conversationId,
                participantUserId: active.participantUserId,
                chatType: active.chatType,
                enterpriseVerified: active.enterpriseVerified === true,
                sourceMessageId: active.sourceMessageId ?? null,
                ownerMessageId,
                ownerContent: String(manual.message?.content ?? "").slice(0, 20_000),
                ownerRevision: control.ownerRevision,
                sendGeneration: control.sendGeneration,
                createTime: manual.message?.createTime
                  ? new Date(manual.message.createTime).toISOString()
                  : end.toISOString(),
              },
            });
            if (controlStore) {
              await controlStore.recordIntervention({
                taskId: taskId(conversationId, active.participantUserId),
                type: intervention,
                ownerRevision: control.ownerRevision,
                sendGeneration: control.sendGeneration,
                occurredAt: manual.message?.createTime ?? end.toISOString(),
              });
            }
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
        return Boolean(
          Number.isSafeInteger(ownerRevision) &&
          Number.isSafeInteger(sendGeneration) &&
          local && local.ownerRevision === ownerRevision &&
          local.sendGeneration === sendGeneration &&
          external?.global?.state !== "paused" &&
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
    async stop() {
      clearInterval(fallbackTimer);
      clearTimeout(debounceTimer);
      for (const watcher of watchers) watcher.close();
      if (eventWakeController) await eventWakeController.stop();
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
