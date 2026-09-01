import { epoch } from "./foursday-runtime-state.mjs";

export function createOwnerInterventionCoordinator({
  semanticEnabled = true,
  semanticTimeoutMs = 30_000,
  semanticClassifier,
  classifierEnvironment,
  legacyClassifier,
  diagnosticHash,
  clock = () => Date.now(),
  emit,
  applyControl,
  recordIntervention,
} = {}) {
  if (
    typeof semanticClassifier !== "function" || typeof legacyClassifier !== "function" ||
    typeof diagnosticHash !== "function" || typeof emit !== "function" ||
    typeof applyControl !== "function" || typeof recordIntervention !== "function"
  ) throw new Error("Foursday owner intervention ports are invalid");
  const recentTaskText = new Map();

  const observeTaskText = (conversationId, text) => {
    recentTaskText.set(
      String(conversationId),
      String(text ?? "").trim().slice(0, 2_000),
    );
    if (recentTaskText.size > 1_000) recentTaskText.delete(recentTaskText.keys().next().value);
  };

  const classify = async (text, { selfChat, taskActive, conversationId }) => {
    if (semanticEnabled) {
      try {
        return await semanticClassifier(text, {
          selfChat,
          taskActive,
          recentTaskText: recentTaskText.get(conversationId) ?? "",
          environment: classifierEnvironment,
          timeoutMs: semanticTimeoutMs,
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
      intent: legacyClassifier(text, { active: taskActive, explicitOnly: selfChat }),
      source: "legacy_fallback",
      confidence: 1,
    };
  };

  const dispatch = async ({
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
    await applyControl({ conversationId, control });
    emitFrame({
      type: "event",
      record: {
        control: classification.intent,
        id: `takeover:${diagnosticHash(conversationId)}:${epoch(createTime) ?? clock()}`,
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
    await recordIntervention({
      conversationId,
      active,
      classification,
      control,
      createTime,
    });
    return control;
  };

  return { observeTaskText, classify, dispatch };
}
