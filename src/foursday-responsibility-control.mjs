import { createHash } from "node:crypto";
import {
  diagnosticCode,
  epoch,
  responsibilityReactionKey,
  pendingOwnerReactionKey,
} from "./foursday-runtime-state.mjs";

const activeReactionStates = new Set([
  "claiming", "claimed", "handled_no_reply", "clearing", "shadow", "unavailable",
]);

export function createResponsibilityCoordinator({
  enabled = false,
  sendEnabled = false,
  reactionName = "OK",
  groupIds = [],
  selfUserId = null,
  dws,
  state,
  persist,
  diagnose,
  diagnosticHash,
  now = () => new Date(),
  clock = () => Date.now(),
  activeConversations,
  isTakenOver,
  currentControl,
  takeoverForReaction,
} = {}) {
  if (
    !state || typeof persist !== "function" || typeof diagnose !== "function" ||
    typeof diagnosticHash !== "function" || !(activeConversations instanceof Map) ||
    typeof isTakenOver !== "function" || typeof currentControl !== "function" ||
    typeof takeoverForReaction !== "function"
  ) throw new Error("Foursday responsibility control ports are invalid");

  const reactions = new Map(Object.entries(state.responsibilityReactions ?? {}));
  const pendingOwnerReactions = new Map(Object.entries(state.pendingOwnerReactions ?? {}));
  const seenReactionEvents = new Set(state.recentReactionEventIds ?? []);
  let automationOps = [...(state.reactionAutomationOps ?? [])];
  const wakeControllers = new Map();
  const wakeReady = new Set();
  const wakeFailed = new Set();
  let ownerOpenDingTalkId = null;

  const sync = () => {
    state.responsibilityReactions = Object.fromEntries(reactions);
    state.reactionAutomationOps = automationOps.slice(-200);
    state.pendingOwnerReactions = Object.fromEntries(pendingOwnerReactions);
    state.recentReactionEventIds = [...seenReactionEvents].slice(-5_000);
  };
  sync();

  const targetKey = ({ chatType, conversationId, participantOpenDingTalkId }) =>
    chatType === "group" ? `group:${conversationId}` : `direct:${participantOpenDingTalkId}`;

  const updateWakeState = () => {
    state.reactionWake = {
      enabled,
      readyCount: wakeReady.size,
      errorCount: wakeFailed.size,
      lastErrorCode: state.reactionWake?.lastErrorCode ?? null,
      updatedAt: now().toISOString(),
    };
  };

  const rememberEvent = (eventId) => {
    if (seenReactionEvents.has(eventId)) return false;
    seenReactionEvents.add(eventId);
    if (seenReactionEvents.size > 5_000) {
      seenReactionEvents.delete(seenReactionEvents.values().next().value);
    }
    sync();
    return true;
  };

  const resolveOwnerOpenDingTalkId = async () => {
    if (ownerOpenDingTalkId) return ownerOpenDingTalkId;
    if (!selfUserId || typeof dws?.resolveUserOpenDingTalkId !== "function") {
      wakeFailed.add("owner_identity");
      state.reactionWake.lastErrorCode = "reaction_owner_identity_unavailable";
      updateWakeState();
      await persist();
      return null;
    }
    try {
      ownerOpenDingTalkId = typeof dws.resolveCurrentUserOpenDingTalkId === "function"
        ? await dws.resolveCurrentUserOpenDingTalkId(selfUserId)
        : await dws.resolveUserOpenDingTalkId(selfUserId, null, { allowPolicyFallback: false });
      wakeFailed.delete("owner_identity");
      updateWakeState();
      await persist();
      return ownerOpenDingTalkId;
    } catch (error) {
      wakeFailed.add("owner_identity");
      state.reactionWake.lastErrorCode = diagnosticCode(error, "owner_identity_failed");
      updateWakeState();
      await persist();
      diagnose(`dws_reaction_owner_identity_failed:${diagnosticCode(error, "owner_identity_failed")}`);
      return null;
    }
  };

  const ensureWake = async ({
    chatType,
    conversationId,
    participantUserId = null,
    participantOpenDingTalkId = null,
    participantName = null,
  }) => {
    if (!enabled || typeof dws?.createReactionEventWake !== "function") return false;
    let openId = String(participantOpenDingTalkId ?? "").trim() || null;
    const targetFailureKey = `target:${diagnosticHash(
      participantUserId ?? participantName ?? "unknown",
    )}`;
    if (chatType === "direct" && !openId && typeof dws.resolveUserOpenDingTalkId === "function") {
      try {
        openId = await dws.resolveUserOpenDingTalkId(participantUserId, participantName, {
          allowPolicyFallback: false,
        });
        wakeFailed.delete(targetFailureKey);
      } catch (error) {
        wakeFailed.add(targetFailureKey);
        state.reactionWake.lastErrorCode = diagnosticCode(error, "reaction_target_unavailable");
        updateWakeState();
        await persist();
        return false;
      }
    }
    if (openId) wakeFailed.delete(targetFailureKey);
    const target = {
      chatType,
      conversationId: String(conversationId ?? "").trim(),
      participantOpenDingTalkId: openId,
    };
    const key = targetKey(target);
    if (wakeReady.has(key)) return true;
    if (wakeControllers.has(key)) {
      try {
        await wakeControllers.get(key).ready;
        return wakeReady.has(key);
      } catch {
        return false;
      }
    }
    if (wakeControllers.size >= 128) {
      wakeFailed.add(key);
      state.reactionWake.lastErrorCode = "reaction_watcher_capacity_exceeded";
      updateWakeState();
      await persist();
      diagnose("dws_reaction_event_unavailable:reaction_watcher_capacity_exceeded");
      return false;
    }
    let controller;
    try {
      controller = dws.createReactionEventWake({
        ...target,
        readyTimeoutMs: 8_000,
        onEvent: (event) => {
          Promise.resolve(handleEvent(event)).catch((error) => {
            diagnose(`dws_reaction_event_failed:${diagnosticCode(error, "reaction_event_failed")}`);
          });
        },
        onDiagnostic: (value) => {
          diagnose(value);
          if (String(value).startsWith("dws_event_closed:")) {
            wakeReady.delete(key);
            wakeFailed.add(key);
            state.reactionWake.lastErrorCode = "reaction_event_closed";
            updateWakeState();
            persist().catch(() => {});
          }
        },
      });
      wakeControllers.set(key, controller);
      updateWakeState();
      await persist();
      await controller.ready;
      wakeReady.add(key);
      wakeFailed.delete(key);
      state.reactionWake.lastErrorCode = null;
      updateWakeState();
      await persist();
      return true;
    } catch (error) {
      wakeControllers.delete(key);
      wakeReady.delete(key);
      wakeFailed.add(key);
      state.reactionWake.lastErrorCode = diagnosticCode(error, "reaction_event_unavailable");
      updateWakeState();
      await persist();
      diagnose(`dws_reaction_event_unavailable:${state.reactionWake.lastErrorCode}`);
      return false;
    }
  };

  const pruneAutomationOps = (at = clock()) => {
    automationOps = automationOps.filter((entry) =>
      (epoch(entry?.expiresAt) ?? 0) > at
    ).slice(-200);
    sync();
  };

  const beginAutomation = ({ action, conversationId, messageId, reactionName: emoji }) => {
    pruneAutomationOps();
    const startedAt = now().toISOString();
    const entry = {
      id: createHash("sha256").update(
        `${action}\0${conversationId}\0${messageId}\0${emoji}\0${startedAt}`,
      ).digest("hex"),
      action,
      conversationId,
      messageId,
      reactionName: emoji,
      startedAt,
      expiresAt: new Date(clock() + 30_000).toISOString(),
      status: "intent",
    };
    automationOps.push(entry);
    sync();
    return entry;
  };

  const consumeAutomatedEvent = (event) => {
    pruneAutomationOps(epoch(event?.occurredAt) ?? clock());
    const index = automationOps.findIndex((entry) =>
      entry.conversationId === event.conversationId &&
      entry.messageId === event.messageId &&
      entry.reactionName === event.reactionName &&
      entry.action === event.action
    );
    if (index < 0) return false;
    automationOps.splice(index, 1);
    sync();
    return true;
  };

  const writeReaction = async ({ action, entry }) => {
    if (!enabled || !sendEnabled) return { success: true, sendDisabled: true };
    const method = action === "added" ? dws?.addEmojiReaction : dws?.removeEmojiReaction;
    if (typeof method !== "function") {
      return { success: false, error: "dws_reaction_write_unavailable" };
    }
    const operation = beginAutomation({
      action,
      conversationId: entry.conversationId,
      messageId: entry.messageId,
      reactionName: entry.reactionName,
    });
    await persist();
    try {
      const result = await method.call(dws, {
        conversationId: entry.conversationId,
        messageId: entry.messageId,
        emoji: entry.reactionName,
      });
      operation.status = result?.success === true ? "completed" : "failed";
      sync();
      await persist();
      return result?.success === true
        ? { success: true }
        : { success: false, error: "dws_reaction_write_failed" };
    } catch (error) {
      operation.status = "unknown";
      sync();
      await persist();
      diagnose(`dws_reaction_write_failed:${diagnosticCode(error, "reaction_write_failed")}`);
      return { success: false, error: diagnosticCode(error, "reaction_write_failed") };
    }
  };

  const release = async (payload) => {
    if (!enabled) return { success: true, disabled: true };
    const conversationId = String(payload?.conversationId ?? "").trim();
    const messageId = String(payload?.messageId ?? "").trim();
    const entry = reactions.get(responsibilityReactionKey(conversationId, messageId));
    if (!entry || entry.status === "cleared") return { success: true, idempotent: true };
    if (!["claimed", "handled_no_reply"].includes(entry.status)) {
      entry.status = "cleared";
      entry.clearedAt = now().toISOString();
      sync();
      await persist();
      return { success: true, idempotent: true };
    }
    entry.status = "clearing";
    sync();
    await persist();
    const result = await writeReaction({ action: "removed", entry });
    entry.status = result.success === true ? "cleared" : "claimed";
    if (result.success === true) entry.clearedAt = now().toISOString();
    sync();
    await persist();
    return result;
  };

  const releaseConversation = async (conversationId, messageId = null) => {
    for (const entry of [...reactions.values()]) {
      if (
        entry.conversationId === conversationId &&
        (!messageId || entry.sourceMessageIds.includes(messageId)) &&
        activeReactionStates.has(entry.status)
      ) await release({ conversationId: entry.conversationId, messageId: entry.messageId });
    }
  };

  const claim = async (payload) => {
    if (!enabled) return { success: true, disabled: true };
    const conversationId = String(payload?.conversationId ?? "").trim();
    const messageId = String(payload?.messageId ?? "").trim();
    const sourceMessageIds = Array.isArray(payload?.sourceMessageIds)
      ? [...new Set(payload.sourceMessageIds.map(String).filter(Boolean))].slice(0, 32)
      : [];
    const ownerRevision = Number(payload?.ownerRevision);
    const sendGeneration = Number(payload?.sendGeneration);
    const active = activeConversations.get(conversationId);
    if (isTakenOver(conversationId)) {
      await releaseConversation(conversationId);
      return { success: false, error: "responsibility_claim_stale" };
    }
    const latestControl = currentControl(conversationId);
    if (
      !active || !conversationId || conversationId.length > 500 ||
      !messageId || messageId.length > 500 || !sourceMessageIds.includes(messageId) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0 ||
      ownerRevision !== Number(active.ownerRevision ?? 0) ||
      sendGeneration !== Number(active.sendGeneration ?? 0) ||
      ownerRevision !== latestControl.ownerRevision ||
      sendGeneration !== latestControl.sendGeneration
    ) return { success: false, error: "responsibility_claim_stale" };
    if (!await resolveOwnerOpenDingTalkId()) {
      return { success: false, error: "reaction_owner_identity_unavailable" };
    }
    if (!wakeReady.has(targetKey({
      chatType: active.chatType,
      conversationId,
      participantOpenDingTalkId: active.participantOpenDingTalkId,
    })) && !await ensureWake({
      chatType: active.chatType,
      conversationId,
      participantUserId: active.participantUserId,
      participantOpenDingTalkId: active.participantOpenDingTalkId,
    })) return { success: false, error: "reaction_event_not_ready" };
    const key = responsibilityReactionKey(conversationId, messageId);
    const existing = reactions.get(key);
    if (
      existing && existing.ownerRevision === ownerRevision &&
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
    for (const previous of [...reactions.values()]) {
      if (
        previous.conversationId === conversationId && previous.messageId !== messageId &&
        ["claiming", "claimed", "clearing", "shadow"].includes(previous.status) &&
        Number(previous.sendGeneration) < sendGeneration
      ) await release({ conversationId: previous.conversationId, messageId: previous.messageId });
    }
    const entry = {
      conversationId,
      messageId,
      sourceMessageIds,
      reactionName,
      ownerRevision,
      sendGeneration,
      status: "claiming",
      claimedAt: now().toISOString(),
      clearedAt: null,
    };
    reactions.set(key, entry);
    while (reactions.size > 1_000) reactions.delete(reactions.keys().next().value);
    sync();
    await persist();
    const result = await writeReaction({ action: "added", entry });
    entry.status = result.sendDisabled === true
      ? "shadow" : result.success === true ? "claimed" : "unavailable";
    sync();
    await persist();
    return result;
  };

  const settle = async (payload) => {
    if (!enabled) return { success: true, disabled: true };
    const entry = reactions.get(responsibilityReactionKey(
      String(payload?.conversationId ?? "").trim(),
      String(payload?.messageId ?? "").trim(),
    ));
    if (!entry || entry.status === "cleared") return { success: true, idempotent: true };
    if (entry.status === "shadow") return { success: true, sendDisabled: true, idempotent: true };
    if (entry.status === "claimed") {
      entry.status = "handled_no_reply";
      sync();
      await persist();
      return { success: true };
    }
    return { success: false, error: "responsibility_reaction_not_settleable" };
  };

  const prunePending = (at = clock()) => {
    for (const [key, entry] of pendingOwnerReactions) {
      if ((epoch(entry.expiresAt) ?? 0) > at) continue;
      pendingOwnerReactions.delete(key);
      rememberEvent(entry.eventId);
    }
    sync();
  };

  const deferOwnerReaction = async (event) => {
    prunePending();
    const key = pendingOwnerReactionKey(event.eventId);
    pendingOwnerReactions.set(key, {
      eventId: String(event.eventId),
      conversationId: String(event.conversationId),
      messageId: String(event.messageId),
      operatorOpenDingTalkId: String(event.operatorOpenDingTalkId),
      senderOpenDingTalkId: String(event.senderOpenDingTalkId ?? "") || null,
      reactionName: String(event.reactionName),
      action: "added",
      occurredAt: new Date(event.occurredAt).toISOString(),
      expiresAt: new Date(clock() + 5 * 60_000).toISOString(),
    });
    while (pendingOwnerReactions.size > 128) {
      const [oldestKey, oldest] = pendingOwnerReactions.entries().next().value;
      pendingOwnerReactions.delete(oldestKey);
      rememberEvent(oldest.eventId);
    }
    sync();
    await persist();
    diagnose(`dws_owner_reaction_deferred:${diagnosticHash(event.eventId)}`);
  };

  async function handleEvent(event, emitFrame, { fromPending = false } = {}) {
    const pendingKey = pendingOwnerReactionKey(event?.eventId);
    if (
      !enabled || !event || typeof event !== "object" || Array.isArray(event) ||
      !String(event.eventId ?? "").trim() || seenReactionEvents.has(String(event.eventId)) ||
      (!fromPending && pendingOwnerReactions.has(pendingKey))
    ) return;
    if (fromPending) pendingOwnerReactions.delete(pendingKey);
    const eventId = String(event.eventId);
    if (consumeAutomatedEvent(event)) {
      rememberEvent(eventId);
      await persist();
      return;
    }
    const ownerOpenId = await resolveOwnerOpenDingTalkId();
    if (!ownerOpenId || event.operatorOpenDingTalkId !== ownerOpenId) {
      rememberEvent(eventId);
      await persist();
      return;
    }
    const active = activeConversations.get(event.conversationId);
    if (!active) {
      if (event.action === "added") await deferOwnerReaction(event);
      else {
        rememberEvent(eventId);
        await persist();
      }
      return;
    }
    const messageResponsibilities = [...reactions.values()].filter((entry) =>
      entry.conversationId === event.conversationId &&
      Array.isArray(entry.sourceMessageIds) && entry.sourceMessageIds.includes(event.messageId)
    );
    const claims = messageResponsibilities.filter((entry) =>
      ["claiming", "claimed", "clearing", "shadow", "unavailable"].includes(entry.status)
    );
    const terminalResponsibility = messageResponsibilities.some((entry) =>
      ["cleared", "handled_no_reply"].includes(entry.status)
    );
    const removesHandledLabel = event.action === "removed" && messageResponsibilities.some((entry) =>
      entry.status === "handled_no_reply" && entry.messageId === event.messageId &&
      entry.reactionName === event.reactionName
    );
    if (removesHandledLabel) {
      if (!rememberEvent(eventId)) return;
      for (const entry of messageResponsibilities) {
        if (
          entry.status === "handled_no_reply" && entry.messageId === event.messageId &&
          entry.reactionName === event.reactionName
        ) {
          entry.status = "cleared";
          entry.clearedAt = event.occurredAt;
        }
      }
      sync();
      await persist();
      return;
    }
    const currentAnchor = active.sourceMessageId === event.messageId && !terminalResponsibility;
    if (claims.length === 0 && !currentAnchor) {
      if (event.action === "added") await deferOwnerReaction(event);
      else {
        rememberEvent(eventId);
        await persist();
      }
      return;
    }
    if (
      event.senderOpenDingTalkId && active.participantOpenDingTalkId &&
      event.senderOpenDingTalkId !== active.participantOpenDingTalkId
    ) {
      rememberEvent(eventId);
      await persist();
      return;
    }
    const removesResponsibility = event.action === "removed" && claims.some((entry) =>
      entry.messageId === event.messageId && entry.reactionName === event.reactionName
    );
    if (event.action === "removed" && !removesResponsibility) {
      rememberEvent(eventId);
      await persist();
      return;
    }
    if (!rememberEvent(eventId)) return;
    await takeoverForReaction({ event, active, emitFrame });
    for (const entry of claims) {
      if (
        event.action === "removed" && event.reactionName === entry.reactionName &&
        entry.messageId === event.messageId
      ) {
        entry.status = "cleared";
        entry.clearedAt = event.occurredAt;
      } else {
        await release({ conversationId: entry.conversationId, messageId: entry.messageId });
      }
    }
    sync();
    await persist();
  }

  const replayPending = async ({ conversationId, messageId, emitFrame }) => {
    prunePending();
    const pendingEvents = [...pendingOwnerReactions.values()].filter((entry) =>
      entry.conversationId === conversationId && entry.messageId === messageId
    );
    for (const event of pendingEvents) {
      await handleEvent(event, emitFrame, { fromPending: true });
    }
  };

  const start = async ({ takenOverConversationIds = [] } = {}) => {
    if (!enabled) {
      state.reactionWake = {
        enabled: false, readyCount: 0, errorCount: 0,
        lastErrorCode: null, updatedAt: now().toISOString(),
      };
      await persist();
      return;
    }
    for (const conversationId of takenOverConversationIds) {
      await releaseConversation(conversationId);
    }
    for (const [conversationId, active] of activeConversations) {
      if (
        active.chatType === "direct" && active.participantOpenDingTalkId ||
        active.chatType === "group" && groupIds.includes(conversationId)
      ) await ensureWake({
        chatType: active.chatType,
        conversationId,
        participantOpenDingTalkId: active.participantOpenDingTalkId,
      });
    }
    const claimedConversations = new Set([...reactions.values()]
      .filter((entry) => !["clearing", "cleared"].includes(entry.status))
      .map((entry) => entry.conversationId));
    if (claimedConversations.size > 0) await resolveOwnerOpenDingTalkId();
    else {
      state.reactionWake.lastErrorCode = null;
      updateWakeState();
      await persist();
    }
    for (const conversationId of claimedConversations) {
      const active = activeConversations.get(conversationId);
      if (!active) continue;
      await ensureWake({
        chatType: active.chatType,
        conversationId,
        participantUserId: active.participantUserId,
        participantOpenDingTalkId: active.participantOpenDingTalkId,
      });
    }
  };

  const stop = async () => {
    for (const controller of wakeControllers.values()) await controller.stop();
    wakeControllers.clear();
    wakeReady.clear();
    wakeFailed.clear();
  };

  return {
    claim,
    release,
    settle,
    releaseConversation,
    ensureWake,
    replayPending,
    start,
    stop,
    handleEvent,
    isReadyFor: (active, conversationId) => !enabled || Boolean(
      ownerOpenDingTalkId && active && wakeReady.has(targetKey({
        chatType: active.chatType,
        conversationId,
        participantOpenDingTalkId: active.participantOpenDingTalkId,
      })),
    ),
  };
}
