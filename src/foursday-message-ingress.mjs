import { isAutomatedSelfMessage } from "./dws.mjs";
import {
  diagnosticCode,
  epoch,
  normalizedControlState,
} from "./foursday-runtime-state.mjs";

export function createMessageIngress({
  userIds = [],
  groupIds = [],
  enterpriseUsersEnabled = false,
  selfUserId = null,
  initialLookbackMs = 120_000,
  historySettleMs = 120_000,
  dws,
  state,
  persist,
  persistCheckHealth,
  now = () => new Date(),
  emit,
  diagnose,
  diagnosticHash,
  taskKey,
  enterpriseIdentity,
  deliveryControl,
  taskControl,
  activeConversations,
  takeoverReported,
  controlStates,
  controlStore,
  ownerIntervention,
} = {}) {
  if (
    !state || typeof persist !== "function" || typeof persistCheckHealth !== "function" ||
    typeof emit !== "function" || typeof diagnose !== "function" ||
    typeof diagnosticHash !== "function" || typeof taskKey !== "function" ||
    !enterpriseIdentity || !deliveryControl || !taskControl ||
    !(activeConversations instanceof Map) || !(takeoverReported instanceof Set) ||
    !(controlStates instanceof Map) || !ownerIntervention
  ) throw new Error("Foursday message ingress ports are invalid");

  const fetchEnterpriseHistoryWindow = async ({ start, end }) => {
    const maximumSliceMs = 60 * 60 * 1_000;
    const output = { messages: [], pending: [], rejected: [] };
    const seen = new Set();
    for (let cursor = start.getTime(); cursor < end.getTime(); cursor += maximumSliceMs) {
      const sliceStart = new Date(cursor);
      const sliceEnd = new Date(Math.min(end.getTime(), cursor + maximumSliceMs));
      if (typeof dws.fetchEnterpriseDirectScan === "function") {
        const scan = await dws.fetchEnterpriseDirectScan({
          start: sliceStart,
          end: sliceEnd,
          selfUserId,
        });
        output.pending.push(...(scan.pending ?? []));
        output.rejected.push(...(scan.rejected ?? []));
        for (const message of scan.messages ?? []) {
          const id = String(message?.id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          output.messages.push(message);
        }
      } else {
        const messages = await dws.fetchEnterpriseDirect({
          start: sliceStart,
          end: sliceEnd,
          selfUserId,
        });
        for (const message of messages ?? []) {
          const id = String(message?.id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          output.messages.push(message);
        }
      }
    }
    return output;
  };

  const performCheck = async ({
    deferEmit = false,
    wakeSource = "manual",
    reconcileLookbackMs = null,
    onStarted = null,
  } = {}) => {
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
      await persist();
      if (typeof onStarted === "function") await onStarted();
      const end = startedAt;
      const deferredFrames = [];
      const dispatch = deferEmit ? (frame) => deferredFrames.push(frame) : emit;
      const targets = [
        ...userIds.map((id) => ({ kind: "user", id })),
        ...groupIds.map((id) => ({ kind: "group", id })),
        ...(enterpriseUsersEnabled ? [{ kind: "enterprise", id: "current_org" }] : []),
      ];
      const results = await Promise.allSettled(targets.map(async (target) => {
        const checkpoints = target.kind === "user"
          ? state.lastUsers : target.kind === "group" ? state.lastGroups : null;
        const last = epoch(target.kind === "enterprise"
          ? state.lastEnterpriseAt : checkpoints[target.id]);
        const settleMs = Number.isFinite(Number(historySettleMs))
          ? Math.max(0, Number(historySettleMs)) : 120_000;
        const requestedLookbackMs = Number.isFinite(Number(reconcileLookbackMs))
          ? Math.max(settleMs, Number(reconcileLookbackMs)) : settleMs;
        const safeHistoryBoundary = Math.max(0, end.getTime() - requestedLookbackMs);
        const start = new Date(last == null
          ? end.getTime() - initialLookbackMs
          : Math.max(0, Math.min(last, safeHistoryBoundary) - 5_000));
        const targetEnd = target.kind === "enterprise"
          ? new Date(Math.max(start.getTime() + 1_000, end.getTime() - 10_000))
          : end;
        let messages;
        if (target.kind === "enterprise") {
          if (
            typeof dws.fetchEnterpriseDirect !== "function" &&
            typeof dws.fetchEnterpriseDirectScan !== "function"
          ) throw new Error("DWS enterprise message scan is unavailable");
          const recovered = await enterpriseIdentity.retry(end);
          if (typeof dws.fetchEnterpriseDirectScan === "function") {
            const scan = await fetchEnterpriseHistoryWindow({ start, end: targetEnd });
            for (const candidate of scan.pending ?? []) enterpriseIdentity.enqueue(candidate, end);
            for (const rejected of scan.rejected ?? []) {
              enterpriseIdentity.reject(rejected.message, rejected.errorCode);
            }
            messages = [
              ...recovered,
              ...(scan.messages ?? []).map(enterpriseIdentity.attachRetryKey),
            ];
          } else {
            messages = [
              ...recovered,
              ...(await fetchEnterpriseHistoryWindow({ start, end: targetEnd })).messages,
            ];
          }
        } else if (target.kind === "user" && target.id === selfUserId) {
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
            !isAutomatedSelfMessage(message, deliveryControl.automatedEvidence())
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
          const code = String(result.reason?.code ?? result.reason?.name ?? "error")
            .replaceAll(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) || "error";
          diagnose(`dws_sidecar_target_failed:${target.kind}:${index}:${diagnosticHash(target.id)}:${code}`);
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
              ? null : Math.max(0, end.getTime() - createdAt);
            state.lastDetection = {
              detectedAt: end.toISOString(), latencyMs: detectionLatencyMs, wakeSource,
            };
            await taskControl.emitMessage({
              ...message,
              detectedAt: end.toISOString(),
              detectionLatencyMs,
              wakeSource,
            }, target.kind === "group" ? "group" : "direct", target.kind === "group", dispatch);
            if (message.enterpriseIdentityRetryKey) {
              enterpriseIdentity.resolve(message.enterpriseIdentityRetryKey, message.id);
            }
          } catch (error) {
            errors.push(error);
            targetFailed = true;
            const code = diagnosticCode(error, "message_processing_failed");
            diagnose(`dws_sidecar_target_failed:${target.kind}:${index}:${diagnosticHash(target.id)}:${code}`);
            break;
          }
        }
        if (targetFailed) continue;
        const checkpoints = target.kind === "user"
          ? state.lastUsers : target.kind === "group" ? state.lastGroups : null;
        const last = epoch(target.kind === "enterprise"
          ? state.lastEnterpriseAt : checkpoints[target.id]) ?? 0;
        const settleMs = Number.isFinite(Number(historySettleMs))
          ? Math.max(0, Number(historySettleMs)) : 120_000;
        const nextCheckpoint = new Date(Math.max(last, end.getTime() - settleMs)).toISOString();
        if (target.kind === "enterprise") state.lastEnterpriseAt = nextCheckpoint;
        else checkpoints[target.id] = nextCheckpoint;
      }
      if (selfUserId && typeof dws.hasManualReply === "function") {
        for (const [conversationId, active] of activeConversations) {
          if (takeoverReported.has(conversationId)) continue;
          let manual;
          try {
            manual = await deliveryControl.probeManualReply({
              conversationId,
              selfUserId,
              after: active.after,
              now: end,
              automatedSendEvidence: deliveryControl.automatedEvidence(),
            });
          } catch {
            continue;
          }
          if (manual?.known !== true || manual.replied !== true) continue;
          const ownerMessageId = String(manual.message?.id ?? "").trim() ||
            `owner:${diagnosticHash(`${conversationId}:${manual.message?.createTime ?? end.toISOString()}`)}`;
          const priorControl = normalizedControlState(controlStates.get(conversationId));
          if (priorControl.lastOwnerMessageId === ownerMessageId) continue;
          const selfChat = active.participantUserId === selfUserId;
          if (selfChat && active.sourceMessageId === ownerMessageId) continue;
          const frozenControl = {
            ...priorControl,
            sendGeneration: Number(priorControl.sendGeneration ?? 0) + 1,
            lastOwnerMessageId: ownerMessageId,
          };
          controlStates.set(conversationId, frozenControl);
          state.controlStates = Object.fromEntries(controlStates);
          const classification = await ownerIntervention.classify(manual.message?.content, {
            selfChat, taskActive: true, conversationId,
          });
          if (classification.intent === "unrelated_owner_message") {
            controlStates.set(conversationId, priorControl);
            state.controlStates = Object.fromEntries(controlStates);
            continue;
          }
          await ownerIntervention.dispatch({
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
      if (controlStore) {
        const controls = await controlStore.snapshot();
        for (const [conversationId, active] of activeConversations) {
          const stableTaskId = taskKey(conversationId, active.participantUserId);
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
      await (deferEmit ? persistCheckHealth() : persist());
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
        await (deferEmit ? persistCheckHealth() : persist());
      }
      throw error;
    }
  };

  return { performCheck };
}
