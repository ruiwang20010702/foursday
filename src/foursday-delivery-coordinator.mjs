import { createHash } from "node:crypto";
import {
  dwsMessageContentDigest,
  dwsMessageContentFingerprint,
  dwsMessageContentRenderFingerprint,
  dwsMessageUsesOrderedList,
  isAutomatedSelfMessage,
} from "./dws.mjs";
import { diagnosticCode, epoch } from "./foursday-runtime-state.mjs";

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

export function stableSendKey(payload) {
  const deliveryKind = String(payload?.metadata?.foursday_delivery_kind ?? "");
  const executionId = String(payload?.metadata?.foursday_execution_id ?? "");
  if (
    ["interim_ack", "background_final"].includes(deliveryKind) &&
    /^[a-f0-9]{64}$/u.test(executionId)
  ) {
    return createHash("sha256").update(JSON.stringify({
      conversationId: String(payload?.conversationId ?? ""),
      replyTo: String(payload?.replyTo ?? ""),
      ownerRevision: payload?.ownerRevision,
      sendGeneration: payload?.sendGeneration,
      executionId,
      deliveryKind,
    })).digest("hex");
  }
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

function idempotencyUuid(key) {
  const hex = `${key.slice(0, 12)}5${key.slice(13, 16)}8${key.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function manualReplyErrorCode(error) {
  const stderr = String(error?.stderr ?? "").trim();
  if (stderr && stderr.length <= 64 * 1024) {
    try {
      const parsed = JSON.parse(stderr);
      const reason = parsed?.error?.reason ?? parsed?.error?.code;
      if (reason != null) {
        return diagnosticCode({ code: reason }, "dws_manual_reply_probe_failed");
      }
    } catch {}
  }
  return diagnosticCode(error, "dws_manual_reply_probe_failed");
}

function messageIdFromReceipt(receipt) {
  const queue = [receipt];
  for (let depth = 0; queue.length > 0 && depth < 200; depth += 1) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" && /^(?:openMessageId|messageId|msgId)$/u.test(key) &&
        child.trim()
      ) return child.trim();
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

const sleep = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

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
      message.conversationId === conversationId && isAutomatedSelfMessage(message, [evidence])
    );
    if (matched.length === 1 && String(matched[0].id ?? "").trim()) {
      return String(matched[0].id).trim();
    }
  }
  return null;
}

export function createDeliveryCoordinator({
  sendEnabled = false,
  selfUserId = null,
  outboundQuietMs = 8_000,
  outboundMaxQuietMs = 20_000,
  dws,
  state,
  persist,
  diagnose,
  now = () => new Date(),
  clock = () => Date.now(),
  wait = sleep,
  recipients,
  activeConversations,
  replyFenceCurrent,
} = {}) {
  if (
    !state || typeof persist !== "function" || typeof diagnose !== "function" ||
    !(recipients instanceof Map) || !(activeConversations instanceof Map) ||
    typeof replyFenceCurrent !== "function"
  ) throw new Error("Foursday delivery ports are invalid");
  const sendLedger = new Map(Object.entries(state.sendLedger ?? {}));
  const automatedEvidence = [...sendLedger.values()]
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      conversationId: entry.conversationId,
      startedAt: entry.startedAt,
      contentDigest: entry.contentDigest,
      idempotencyKey: entry.idempotencyKey,
      receipt: entry.messageId ? { messageId: entry.messageId } : undefined,
    }));

  const rememberAutomatedSend = (evidence) => {
    const index = automatedEvidence.findIndex((item) =>
      item?.idempotencyKey === evidence?.idempotencyKey
    );
    if (index >= 0) automatedEvidence[index] = evidence;
    else automatedEvidence.push(evidence);
    if (automatedEvidence.length > 1_000) automatedEvidence.shift();
  };

  const syncLedger = () => {
    state.sendLedger = Object.fromEntries(sendLedger);
  };

  const blockSending = async (reason) => {
    state.sendBlocked = true;
    state.sendBlockReason = String(reason ?? "send_outcome_unknown").slice(0, 80);
    state.sendBlockedAt = now().toISOString();
    await persist();
  };

  const probeManualReply = async (input, {
    retryDelays = [250],
    timeoutMs = 10_000,
    deadlineAt = Number.POSITIVE_INFINITY,
    beforeAttempt = async () => {},
    onFailure = async () => {},
  } = {}) => {
    if (!selfUserId || typeof dws?.hasManualReply !== "function") {
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
        const result = await dws.hasManualReply({ ...input, now: now(), timeoutMs });
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
        if (attempt >= retryDelays.length || !retryableManualReplyCodes.has(code)) break;
        const remaining = deadlineAt - clock();
        const delay = Math.min(retryDelays[attempt], remaining);
        if (!(delay > 0)) break;
        await wait(delay);
      }
    }
    if (state.manualReplyProbe.ready === false && state.manualReplyProbe.errorCode) {
      diagnose(`dws_sidecar_manual_reply_probe_failed:${state.manualReplyProbe.errorCode}`);
    }
    throw lastError;
  };

  const start = async () => {
    if (!sendEnabled && state.sendBlocked) {
      state.sendBlocked = false;
      state.sendBlockReason = null;
      state.sendBlockedAt = null;
      await persist();
    }
  };

  const send = async (payload) => {
    const conversationId = String(payload?.conversationId ?? "").trim();
    const route = recipients.get(conversationId);
    if (!route) return { success: false, error: "DWS conversation recipient is unknown" };
    const ownerRevision = Number(payload?.ownerRevision);
    const sendGeneration = Number(payload?.sendGeneration);
    const active = activeConversations.get(conversationId);
    const fence = () => replyFenceCurrent({
      conversationId,
      active,
      ownerRevision,
      sendGeneration,
    });
    if (!await fence()) {
      return {
        success: false,
        staleGeneration: true,
        error: "DWS reply lost its owner revision or send generation",
      };
    }
    const observedAt = epoch(active?.observedAt);
    const detectionLatencyMs = Number(active?.detectionLatencyMs);
    const adaptiveQuietMs = Math.min(
      outboundMaxQuietMs,
      outboundQuietMs + (
        Number.isFinite(detectionLatencyMs) ? Math.max(0, detectionLatencyMs) : 0
      ),
    );
    if (observedAt != null && adaptiveQuietMs > 0) {
      const remaining = observedAt + adaptiveQuietMs - clock();
      if (remaining > 0) await wait(remaining);
    }
    if (!await fence()) {
      return {
        success: false,
        staleGeneration: true,
        error: "DWS reply was replaced during the outbound quiet window",
      };
    }
    if (!sendEnabled) {
      return { success: false, sendDisabled: true, error: "DWS personal send is disabled" };
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
    await persist();
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
        selfUserId,
        after: active?.after,
        now: now(),
        automatedSendEvidence: automatedEvidence,
      }, {
        retryDelays: deferredReplyRetryDelays,
        timeoutMs: deferredReplyProbeTimeoutMs,
        deadlineAt: deferredDeadlineAt,
        beforeAttempt: async () => {
          if (!sendEnabled || state.sendBlocked || !await fence()) {
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
          await persist();
        },
      });
    } catch (error) {
      const errorCode = manualReplyErrorCode(error);
      finishDeferredReply(errorCode);
      await persist();
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
      await persist();
      return {
        success: false,
        staleGeneration: true,
        manualReplyDetected: true,
        error: "DWS detected an owner reply before transport",
      };
    }
    if (state.sendBlocked) {
      finishDeferredReply("send_blocked");
      await persist();
      return {
        success: false,
        outcomeUnknown: true,
        sendSuspended: true,
        error: "DWS personal sending became blocked during verification",
      };
    }
    if (!await fence()) {
      finishDeferredReply("deferred_reply_stale");
      await persist();
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
    syncLedger();
    await persist();
    if (!await fence()) {
      sendLedger.set(sendKey, { ...intent, status: "cancelled_stale" });
      syncLedger();
      await persist();
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
      syncLedger();
      await blockSending("transport_exception_after_intent");
      return {
        success: false,
        outcomeUnknown: true,
        error: "DWS send failed after intent persistence",
      };
    }
    const evidence = { ...intent, taskId: idempotencyKey, receipt };
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
      syncLedger();
      await persist();
      return { success: false, error: "DWS returned an explicit send failure" };
    }
    const serverMessageId = messageIdFromReceipt(receipt) ??
      await readBackSentMessage({ dws, route, conversationId, evidence });
    if (!serverMessageId) {
      const unknown = { ...intent, status: "unknown" };
      sendLedger.set(sendKey, unknown);
      rememberAutomatedSend({ ...unknown, receipt });
      syncLedger();
      await blockSending("missing_server_message_id");
      return {
        success: false,
        outcomeUnknown: true,
        error: "DWS explicit receipt did not include a server message ID",
      };
    }
    const completed = { ...intent, status: "completed", messageId: serverMessageId };
    sendLedger.set(sendKey, completed);
    rememberAutomatedSend({ ...completed, receipt });
    syncLedger();
    await persist();
    return { success: true, messageId: serverMessageId, receiptKind: "server" };
  };

  return {
    start,
    send,
    probeManualReply,
    automatedEvidence: () => automatedEvidence,
  };
}
