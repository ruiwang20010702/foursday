const digest = /^[a-f0-9]{64}$/u;
const terminalStates = new Set(["completed", "failed", "cancelled"]);

function validGeneration(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createDurableExecutionCoordinator({
  taskLedgerStore,
  controlStore,
  activeConversations,
  emit,
  now = () => new Date(),
  clock = () => Date.now(),
  taskKey,
  sendEnabled = false,
} = {}) {
  if (!(activeConversations instanceof Map)) {
    throw new Error("Foursday durable execution requires active conversations");
  }
  if (typeof emit !== "function" || typeof taskKey !== "function") {
    throw new Error("Foursday durable execution ports are invalid");
  }

  const cancelExecutionGeneration = async ({
    task,
    ownerRevision,
    sendGeneration,
    errorCode,
  }) => {
    if (!taskLedgerStore) return;
    const ledger = await taskLedgerStore.snapshot();
    const execution = ledger.executions?.[task];
    if (
      !execution || execution.ownerRevision !== ownerRevision ||
      execution.sendGeneration !== sendGeneration || terminalStates.has(execution.state)
    ) return;
    await taskLedgerStore.finishExecution({
      taskId: task,
      executionId: execution.executionId,
      ownerRevision,
      sendGeneration,
      outcome: "cancelled",
      errorCode,
    });
  };

  const executionContext = async (payload) => {
    if (!taskLedgerStore || !controlStore) return null;
    const task = String(payload?.taskId ?? "");
    const executionId = String(payload?.executionId ?? "");
    const ownerRevision = Number(payload?.ownerRevision);
    const sendGeneration = Number(payload?.sendGeneration);
    if (
      !digest.test(task) || !digest.test(executionId) ||
      !validGeneration(ownerRevision) || !validGeneration(sendGeneration)
    ) return null;
    const [ledger, control] = await Promise.all([
      taskLedgerStore.snapshot(),
      controlStore.snapshot(),
    ]);
    const execution = ledger.executions?.[task] ?? null;
    const controlTask = control.tasks?.[task] ?? null;
    if (
      !execution || execution.executionId !== executionId ||
      execution.ownerRevision !== ownerRevision || execution.sendGeneration !== sendGeneration ||
      control.global?.state === "paused" || controlTask?.state !== "active" ||
      controlTask.ownerRevision !== ownerRevision || controlTask.sendGeneration !== sendGeneration
    ) return null;
    const route = [...activeConversations.entries()].find(([conversationId, active]) =>
      taskKey(conversationId, active.participantUserId) === task &&
      Number(active.ownerRevision) === ownerRevision &&
      Number(active.sendGeneration) === sendGeneration
    ) ?? null;
    if (!route) return null;
    return { taskId: task, execution, conversationId: route[0], active: route[1] };
  };

  const emitContinuation = ({ taskId: task, execution, conversationId, active }) => {
    const detectedAt = now().toISOString();
    emit({
      type: "event",
      record: {
        id: active.sourceMessageId,
        senderUserId: active.participantUserId,
        senderOpenDingTalkId: active.participantOpenDingTalkId ?? null,
        senderName: active.participantUserId,
        conversationId,
        content: [
          "Continue the durable Foursday task in this same Codex Thread.",
          "Re-read the current task contract and execution plan, complete the remaining reversible work, verify evidence, and return the final user-facing result.",
          "Do not acknowledge again and do not redeclare this execution generation.",
        ].join(" "),
        createTime: detectedAt,
        chatType: active.chatType,
        mentionedSelf: active.chatType === "group",
        isSelf: false,
        enterpriseVerified: active.enterpriseVerified === true,
        attachments: [],
        ownerRevision: execution.ownerRevision,
        sendGeneration: execution.sendGeneration,
        detectedAt,
        detectionLatencyMs: 0,
        wakeSource: "background",
        internalBackground: true,
        taskId: task,
        executionId: execution.executionId,
      },
    });
  };

  const inspect = async (payload) => {
    const context = await executionContext(payload);
    if (!context || !["foreground", "background"].includes(context.execution.mode)) {
      return { success: false, staleGeneration: true };
    }
    if (!sendEnabled) {
      return { success: true, shadow: true, shouldAcknowledge: false };
    }
    return {
      success: true,
      shouldAcknowledge: context.execution.state === "ack_pending",
      acknowledgment: context.execution.state === "ack_pending"
        ? context.execution.acknowledgment : null,
      executionId: context.execution.executionId,
      taskId: context.taskId,
    };
  };

  const acknowledge = async (payload) => {
    const context = await executionContext(payload);
    if (!context) return { success: false, staleGeneration: true };
    const result = await taskLedgerStore.acknowledgeExecution(payload);
    return { success: true, execution: result.result.execution };
  };

  const activate = async (payload) => {
    const context = await executionContext(payload);
    if (!context || context.execution.mode !== "background") {
      return { success: false, staleGeneration: true, activated: false };
    }
    if (!sendEnabled) return { success: true, shadow: true, activated: false };
    if (["queued", "running", "completed"].includes(context.execution.state)) {
      return { success: true, activated: false, idempotent: true };
    }
    if (context.execution.state !== "acknowledged") {
      return { success: true, activated: false, waitingForAcknowledgment: true };
    }
    const queued = await taskLedgerStore.queueExecution(payload);
    emitContinuation({ ...context, execution: queued.result.execution });
    return { success: true, activated: true, executionId: context.execution.executionId };
  };

  const start = async (payload) => {
    const context = await executionContext(payload);
    if (!context) return { success: false, staleGeneration: true };
    const leased = await taskLedgerStore.leaseExecution(payload);
    return { success: true, execution: leased.result.execution };
  };

  const finish = async (payload) => {
    const context = await executionContext(payload);
    if (!context) return { success: false, staleGeneration: true };
    let outcome = payload?.outcome;
    if (outcome === "completed") {
      const ledger = await taskLedgerStore.snapshot();
      if (["escalated", "rework_requested"].includes(
        ledger.tasks?.[context.taskId]?.lifecycleState,
      )) outcome = "blocked";
    }
    const finished = outcome === "retry"
      ? await taskLedgerStore.retryExecution(payload)
      : await taskLedgerStore.finishExecution({ ...payload, outcome });
    if (finished.result.execution.state === "queued") {
      emitContinuation({ ...context, execution: finished.result.execution });
    }
    return { success: true, execution: finished.result.execution };
  };

  const recover = async () => {
    if (!taskLedgerStore || !sendEnabled) return { recovered: 0 };
    const ledger = await taskLedgerStore.snapshot();
    let recovered = 0;
    for (const [task, execution] of Object.entries(ledger.executions ?? {})) {
      const leaseExpired = execution.state === "running" && (
        !execution.leaseExpiresAt || Date.parse(execution.leaseExpiresAt) <= clock()
      );
      if (execution.state !== "queued" && !leaseExpired) continue;
      const context = await executionContext({
        taskId: task,
        executionId: execution.executionId,
        ownerRevision: execution.ownerRevision,
        sendGeneration: execution.sendGeneration,
      });
      if (!context) continue;
      emitContinuation(context);
      recovered += 1;
    }
    return { recovered };
  };

  return {
    cancelExecutionGeneration,
    inspect,
    acknowledge,
    activate,
    start,
    finish,
    recover,
  };
}
