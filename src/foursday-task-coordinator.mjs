import { join } from "node:path";
import { ownerInterventionCandidate } from "./foursday-owner-intervention.mjs";
import {
  boundedReactionValue,
  normalizedControlState,
} from "./foursday-runtime-state.mjs";

export function createTaskCoordinator({
  selfUserId = null,
  mediaRoot = null,
  responsibilityReactionsEnabled = false,
  semanticTimeoutMs = 30_000,
  classifierEnvironment,
  dws,
  state,
  now = () => new Date(),
  diagnose,
  diagnosticHash,
  taskKey,
  taskBoundaryResolver,
  responsibilityGroupingResolver,
  responseDutyResolver,
  controlStore,
  recipients,
  activeConversations,
  takeoverReported,
  controlStates,
  seen,
  ownerIntervention,
  responsibilityControl,
  cancelExecutionGeneration,
  emit,
} = {}) {
  if (
    !state || typeof diagnose !== "function" || typeof diagnosticHash !== "function" ||
    typeof taskKey !== "function" || typeof taskBoundaryResolver !== "function" ||
    typeof responsibilityGroupingResolver !== "function" ||
    typeof responseDutyResolver !== "function" ||
    !(recipients instanceof Map) || !(activeConversations instanceof Map) ||
    !(takeoverReported instanceof Set) || !(controlStates instanceof Map) ||
    !(seen instanceof Set) || !ownerIntervention || !responsibilityControl ||
    typeof cancelExecutionGeneration !== "function" || typeof emit !== "function"
  ) throw new Error("Foursday task coordination ports are invalid");

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
      await responsibilityControl.releaseConversation(conversationId, id);
      emitFrame({
        type: "event",
        record: {
          control: "message_withdrawn",
          id: `withdrawn:${diagnosticHash(id)}`,
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
    const stableTaskId = taskKey(conversationId, senderUserId);
    const externalControl = controlStore ? await controlStore.snapshot() : null;
    let externalTask = externalControl?.tasks?.[stableTaskId] ?? null;
    const priorActive = activeConversations.get(conversationId) ?? null;
    const ownerSelfMessage = Boolean(selfUserId && senderUserId === selfUserId);
    const selfInterventionCandidate = Boolean(
      ownerSelfMessage && priorActive && ownerInterventionCandidate(message.content),
    );
    const globalPaused = externalControl?.global?.state === "paused";
    const taskPaused = externalTask?.state === "paused";
    let taskTakenOver = externalTask?.state === "taken_over";
    let taskBoundaryDecision = null;

    const reopenTakenOverTask = async () => {
      diagnose(`dws_taken_over_boundary_started:${diagnosticHash(id)}`);
      let recentMessages = [];
      if (
        chatType === "direct" && senderOpenDingTalkId &&
        typeof dws?.fetchDirect === "function"
      ) {
        try {
          recentMessages = (await dws.fetchDirect({
            userId: senderOpenDingTalkId,
            identityKind: "open_dingtalk_id",
            before: new Date(createTime),
            limit: 12,
            lookbackMs: 24 * 60 * 60 * 1_000,
            timeoutMs: 12_000,
          })).filter((item) => item.id !== id).slice(-8).map((item) => ({
            isSelf: item.isSelf === true,
            content: String(item.content ?? "").slice(0, 1_000),
          }));
        } catch {}
      }
      diagnose(`dws_taken_over_boundary_context_ready:${diagnosticHash(id)}:${recentMessages.length}`);
      const decision = await taskBoundaryResolver({
        currentMessage: String(message.content ?? ""),
        recentMessages,
        lastTaskInboundAt: externalTask?.lastInboundAt ?? null,
        takenOverAt: externalTask?.updatedAt ?? null,
        currentAt: createTime,
      }, {
        environment: classifierEnvironment,
        timeoutMs: semanticTimeoutMs,
      });
      diagnose(`dws_taken_over_boundary_decided:${diagnosticHash(id)}:${decision.intent}:${decision.source}`);
      taskBoundaryDecision = decision;
      if (decision.intent !== "new_task") return false;
      if (controlStore) {
        const reopened = await controlStore.reopenTakenOverTask({
          taskId: stableTaskId,
          expectedOwnerRevision: externalTask.ownerRevision,
          expectedSendGeneration: externalTask.sendGeneration,
          lastInboundAt: createTime,
        });
        diagnose(`dws_taken_over_boundary_control_reopened:${diagnosticHash(id)}:${
          reopened?.result?.task ? "ready" : "missing"
        }`);
        externalTask = reopened.result.task;
      } else {
        externalTask = {
          ...externalTask,
          state: "active",
          ownerRevision: Number(externalTask?.ownerRevision ?? 0) + 1,
          sendGeneration: Number(externalTask?.sendGeneration ?? 0) + 1,
          lastInboundAt: createTime,
          updatedAt: now().toISOString(),
          pendingEvent: null,
        };
      }
      taskTakenOver = false;
      takeoverReported.delete(conversationId);
      state.takeoverReported = [...takeoverReported];
      diagnose(`dws_taken_over_task_reopened:${diagnosticHash(id)}:${decision.source}`);
      return true;
    };

    if ((globalPaused || taskPaused) && !selfInterventionCandidate) {
      const error = new Error("Foursday control paused this task");
      error.code = "FOURSDAY_CONTROL_PAUSED";
      throw error;
    }
    if (taskTakenOver && !selfInterventionCandidate) {
      if (!await reopenTakenOverTask()) {
        if (!remember(id)) return;
        diagnose(`dws_taken_over_message_suppressed:${diagnosticHash(id)}`);
        return;
      }
      diagnose(`dws_taken_over_boundary_reopen_complete:${diagnosticHash(id)}`);
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
      const classification = await ownerIntervention.classify(message.content, {
        selfChat: true,
        taskActive: !["paused", "taken_over"].includes(externalTask?.state),
        conversationId,
      });
      if (classification.intent !== "unrelated_owner_message") {
        if (!remember(id)) return;
        if (["task_correction", "task_takeover"].includes(classification.intent)) {
          await cancelExecutionGeneration({
            task: stableTaskId,
            ownerRevision: priorControl.ownerRevision,
            sendGeneration: priorControl.sendGeneration,
            errorCode: classification.intent,
          });
        }
        await ownerIntervention.dispatch({
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
          await responsibilityControl.releaseConversation(
            conversationId,
            priorActive?.sourceMessageId ?? null,
          );
        }
        return;
      }
      controlStates.set(conversationId, priorControl);
      state.controlStates = Object.fromEntries(controlStates);
    }
    await cancelExecutionGeneration({
      task: stableTaskId,
      ownerRevision: priorControl.ownerRevision,
      sendGeneration: priorControl.sendGeneration,
      errorCode: "superseded_by_new_generation",
    });
    if (taskTakenOver && !globalPaused && !taskPaused) {
      if (!await reopenTakenOverTask()) {
        if (!remember(id)) return;
        diagnose(`dws_taken_over_message_suppressed:${diagnosticHash(id)}`);
        return;
      }
      diagnose(`dws_taken_over_boundary_reopen_complete:${diagnosticHash(id)}`);
    }
    if (globalPaused || taskPaused) {
      const error = new Error("Foursday control paused this task");
      error.code = "FOURSDAY_CONTROL_PAUSED";
      throw error;
    }
    const attachments = [];
    if (mediaRoot && Array.isArray(message.media)) {
      for (const item of message.media.slice(0, 8)) {
        const resourceType = item.resourceType ?? "mediaId";
        const outputDirectory = join(
          mediaRoot,
          diagnosticHash(`${id}:${resourceType}:${item.resourceId}`),
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
      const requesterName = String(message.senderName ?? "").trim();
      await controlStore.observeTask({
        taskId: stableTaskId,
        projectId: null,
        requester: requesterName && requesterName !== senderUserId &&
            requesterName !== senderOpenDingTalkId
          ? {
              displayName: requesterName,
              channel: chatType === "group" ? "dingtalk_group" : "dingtalk_direct",
            }
          : null,
        ownerRevision: control.ownerRevision,
        sendGeneration: control.sendGeneration,
        lastInboundAt: createTime,
      });
      if (taskBoundaryDecision) {
        diagnose(`dws_taken_over_boundary_observed:${diagnosticHash(id)}`);
      }
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
      checkToDetectionMs: Number.isFinite(Number(message.checkToDetectionMs))
        ? Math.max(0, Number(message.checkToDetectionMs))
        : null,
      wakeSource: String(message.wakeSource ?? "unknown").slice(0, 40),
      enterpriseVerified: message.enterpriseVerified === true,
    });
    controlStates.set(conversationId, control);
    state.controlStates = Object.fromEntries(controlStates);
    takeoverReported.delete(conversationId);
    state.takeoverReported = [...takeoverReported];
    state.activeConversations = Object.fromEntries(activeConversations);
    ownerIntervention.observeTaskText(conversationId, message.content);
    if (responsibilityReactionsEnabled) {
      await responsibilityControl.ensureWake({
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
        checkToDetectionMs: Number.isFinite(Number(message.checkToDetectionMs))
          ? Math.max(0, Number(message.checkToDetectionMs))
          : null,
        wakeSource: String(message.wakeSource ?? "unknown").slice(0, 40),
        taskBoundary: taskBoundaryDecision ? {
          intent: taskBoundaryDecision.intent,
          source: taskBoundaryDecision.source,
          confidence: Number(taskBoundaryDecision.confidence ?? 0),
        } : null,
      },
    });
    if (taskBoundaryDecision) {
      diagnose(`dws_taken_over_boundary_emitted:${diagnosticHash(id)}`);
    }
    await responsibilityControl.replayPending({ conversationId, messageId: id, emitFrame });
  };

  const groupResponsibilityMessages = async (payload) => {
    const messages = Array.isArray(payload?.messages)
      ? payload.messages.slice(0, 32).map((message) => ({
          id: boundedReactionValue(message?.id),
          content: String(message?.content ?? "").slice(0, 2_000),
        }))
      : [];
    if (
      messages.length < 1 || messages.some((message) => !message.id) ||
      new Set(messages.map((message) => message.id)).size !== messages.length
    ) return { success: false, error: "responsibility_grouping_invalid" };
    if (messages.length === 1) {
      return {
        success: true,
        groups: [messages.map((_message, index) => index)],
        source: "single",
      };
    }
    const result = await responsibilityGroupingResolver(messages, {
      environment: classifierEnvironment,
      timeoutMs: Math.min(20_000, semanticTimeoutMs),
    });
    return {
      success: true,
      groups: result.groups,
      source: result.source,
      confidence: result.confidence,
    };
  };

  const classifyResponseDuty = async (payload) => {
    const content = String(payload?.content ?? "").trim().slice(0, 8_000);
    const messageCount = Number(payload?.messageCount ?? 1);
    if (
      !content || !Number.isSafeInteger(messageCount) ||
      messageCount < 1 || messageCount > 32
    ) return { success: false, error: "response_duty_invalid" };
    const result = await responseDutyResolver({ content, messageCount }, {
      environment: classifierEnvironment,
      timeoutMs: Math.min(20_000, semanticTimeoutMs),
    });
    return {
      success: true,
      decision: result.decision,
      source: result.source,
      confidence: result.confidence,
    };
  };

  return { emitMessage, remember, groupResponsibilityMessages, classifyResponseDuty };
}
