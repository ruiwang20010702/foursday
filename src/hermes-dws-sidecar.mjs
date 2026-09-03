import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { access, chmod, mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DwsAdapter } from "./dws.mjs";
import { discoverWatchDirectories } from "./dingtalk-watch-directories.mjs";
import { isMainModule } from "./main-module.mjs";
import { FoursdayControlStore } from "./foursday-control-store.mjs";
import { FoursdayTaskLedgerStore } from "./foursday-task-ledger.mjs";
import {
  resolveOwnerIntervention,
} from "./foursday-owner-intervention.mjs";
import { resolveResponsibilityGroups } from "./foursday-message-groups.mjs";
import { resolveResponseDuty } from "./foursday-response-duty.mjs";
import { resolveTakenOverTaskBoundary } from "./foursday-task-boundary.mjs";
import { createDurableExecutionCoordinator } from "./foursday-durable-execution.mjs";
import { createEnterpriseIdentityCoordinator } from "./foursday-enterprise-identity.mjs";
import {
  createCheckpointCoordinator,
  startPersonalEventWake,
} from "./foursday-checkpoint-coordinator.mjs";
import { createResponsibilityCoordinator } from "./foursday-responsibility-control.mjs";
import { createOwnerInterventionCoordinator } from "./foursday-owner-intervention-coordinator.mjs";
import { createDeliveryCoordinator } from "./foursday-delivery-coordinator.mjs";
import { createTaskCoordinator } from "./foursday-task-coordinator.mjs";
import { createMessageIngress } from "./foursday-message-ingress.mjs";
import { syncFoursdayCodexProjects } from "./foursday-codex-project-sync.mjs";
import { createHermesPersonalMemoryClient } from "./hermes-personal-memory-context.mjs";
import { createTaskReconciliationCoordinator } from "./foursday-task-reconciliation.mjs";
export { stableSendKey } from "./foursday-delivery-coordinator.mjs";
import {
  diagnosticCode,
  enterpriseIdentityRetryDefaults,
  createRuntimeStatePersistence,
  loadFoursdayRuntimeState as loadState,
  normalizedControlState,
} from "./foursday-runtime-state.mjs";

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


function taskId(conversationId, participantUserId) {
  return createHash("sha256")
    .update(`${String(conversationId)}:${String(participantUserId)}`)
    .digest("hex");
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

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function boundedPromise(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("bounded_operation_timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const taskLedgerFile = String(environment.FOURSDAY_TASK_LEDGER_FILE ?? "").trim();
  if (taskLedgerFile && !isAbsolute(taskLedgerFile)) {
    throw new Error("FOURSDAY_TASK_LEDGER_FILE must be absolute");
  }
  const workContextFile = String(environment.FOURSDAY_WORK_CONTEXT_FILE ?? "").trim();
  if (workContextFile && !isAbsolute(workContextFile)) {
    throw new Error("FOURSDAY_WORK_CONTEXT_FILE must be absolute");
  }
  const projectRegistryFile = String(environment.FOURSDAY_PROJECT_REGISTRY ?? "").trim();
  const productionConfigFile = String(environment.FOURSDAY_PRODUCTION_CONFIG ?? "").trim();
  const codexProjectStateFile = String(environment.FOURSDAY_CODEX_PROJECT_STATE_FILE ?? "").trim();
  const projectSyncEnabled = String(
    environment.DWS_PERSONAL_PROJECT_SYNC_ENABLED ?? (
      projectRegistryFile && codexProjectStateFile ? "true" : "false"
    ),
  ).toLowerCase() === "true";
  if (projectSyncEnabled && (
    !isAbsolute(projectRegistryFile) || !isAbsolute(codexProjectStateFile)
  )) throw new Error("Foursday project sync paths must be absolute");
  if (productionConfigFile && !isAbsolute(productionConfigFile)) {
    throw new Error("Foursday production config path must be absolute");
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
    taskLedgerFile: taskLedgerFile ? resolve(taskLedgerFile) : null,
    workContextFile: workContextFile ? resolve(workContextFile) : null,
    projectRegistryFile: projectRegistryFile ? resolve(projectRegistryFile) : null,
    codexProjectStateFile: codexProjectStateFile ? resolve(codexProjectStateFile) : null,
    projectSyncEnabled,
    projectUserHome: String(environment.HOME ?? "").trim(),
    productionConfigFile: productionConfigFile ? resolve(productionConfigFile) : null,
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
  taskLedgerStore = config.taskLedgerFile
    ? new FoursdayTaskLedgerStore({ path: config.taskLedgerFile })
    : null,
  semanticInterventionClassifier = resolveOwnerIntervention,
  responsibilityGroupingResolver = resolveResponsibilityGroups,
  responseDutyResolver = resolveResponseDuty,
  taskBoundaryResolver = resolveTakenOverTaskBoundary,
  classifierEnvironment = process.env,
  projectRegistrySynchronizer = syncFoursdayCodexProjects,
  memoryClientFactory = createHermesPersonalMemoryClient,
  projectWatchFactory = watch,
  projectSyncDebounceMs = 1_000,
} = {}) {
  if (config.outboundQuietMs > config.outboundMaxQuietMs) {
    throw new Error("DWS outbound quiet window exceeds its maximum");
  }
  if (!Number.isSafeInteger(projectSyncDebounceMs) || projectSyncDebounceMs < 1 || projectSyncDebounceMs > 60_000) {
    throw new Error("Foursday project sync debounce is invalid");
  }
  await access(config.dwsPath);
  if (config.mediaRoot) {
    await mkdir(config.mediaRoot, { recursive: true, mode: 0o700 });
    await chmod(config.mediaRoot, 0o700);
  }
  const state = await loadState(config.stateFile);
  const {
    persist: persistState,
    persistCheckHealth,
  } = createRuntimeStatePersistence({ path: config.stateFile, state });
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
  const enterpriseIdentity = createEnterpriseIdentityCoordinator({
    dws,
    state,
    seen,
    diagnose,
    diagnosticHash: hash,
    now,
    retryTtlMs: enterpriseIdentityRetryTtlMs,
    retryMaxAttempts: enterpriseIdentityRetryMaxAttempts,
    retryCapacity: enterpriseIdentityRetryCapacity,
  });
  const recipients = new Map(Object.entries(state.recipients));
  const activeConversations = new Map(Object.entries(state.activeConversations));
  const takeoverReported = new Set(state.takeoverReported);
  const controlStates = new Map(Object.entries(state.controlStates).map(([key, value]) => [
    key,
    normalizedControlState(value),
  ]));
  const durableExecution = createDurableExecutionCoordinator({
    taskLedgerStore,
    controlStore,
    activeConversations,
    emit,
    now,
    clock,
    taskKey: taskId,
    sendEnabled: config.sendEnabled,
  });
  const { cancelExecutionGeneration } = durableExecution;
  const taskReconciliation = createTaskReconciliationCoordinator({
    enabled: true,
    workContextFile: config.workContextFile,
    projectRegistryFile: config.projectRegistryFile,
    taskLedgerStore,
    controlStore,
    activeConversations,
    state,
    persist: persistState,
    emit,
    taskKey: taskId,
    now,
  });
  const watchers = [];
  let eventWakeController = null;
  let projectSyncTimer = null;
  let projectSyncStopped = false;
  let projectStateWatcherStarted = false;
  let projectSyncQueue = Promise.resolve();
  let taskReconciliationStarted = false;
  let responsibilityControl;
  const ownerIntervention = createOwnerInterventionCoordinator({
    semanticEnabled: config.semanticInterventionEnabled === true,
    semanticTimeoutMs: config.semanticInterventionTimeoutMs,
    semanticClassifier: semanticInterventionClassifier,
    classifierEnvironment,
    legacyClassifier: classifyOwnerIntervention,
    diagnosticHash: hash,
    clock,
    emit,
    applyControl: async ({ conversationId, control }) => {
      controlStates.set(conversationId, control);
      state.controlStates = Object.fromEntries(controlStates);
      takeoverReported.add(conversationId);
      state.takeoverReported = [...takeoverReported];
      await persistState();
    },
    recordIntervention: async ({ conversationId, active, classification, control, createTime }) => {
      if (!controlStore) return;
      await controlStore.recordIntervention({
        taskId: taskId(conversationId, active.participantUserId),
        type: classification.intent,
        ownerRevision: control.ownerRevision,
        sendGeneration: control.sendGeneration,
        occurredAt: createTime,
      });
    },
  });

  responsibilityControl = createResponsibilityCoordinator({
    enabled: config.responsibilityReactionsEnabled === true,
    sendEnabled: config.sendEnabled === true,
    reactionName: config.responsibilityReactionName,
    groupIds: config.groupIds,
    selfUserId: config.selfUserId,
    dws,
    state,
    persist: persistState,
    diagnose,
    diagnosticHash: hash,
    now,
    clock,
    activeConversations,
    isTakenOver: (conversationId) => takeoverReported.has(conversationId),
    currentControl: (conversationId) => normalizedControlState(
      controlStates.get(conversationId),
    ),
    takeoverForReaction: async ({ event, active, emitFrame }) => {
      const stableTaskId = taskId(event.conversationId, active.participantUserId);
      const externalControl = controlStore ? await controlStore.snapshot() : null;
      const externalTask = externalControl?.tasks?.[stableTaskId] ?? null;
      const localControl = normalizedControlState(controlStates.get(event.conversationId));
      const frozenControl = {
        ownerRevision: Math.max(localControl.ownerRevision, externalTask?.ownerRevision ?? 0),
        sendGeneration: Math.max(
          localControl.sendGeneration,
          externalTask?.sendGeneration ?? 0,
        ) + 1,
        lastOwnerMessageId: localControl.lastOwnerMessageId,
      };
      controlStates.set(event.conversationId, frozenControl);
      state.controlStates = Object.fromEntries(controlStates);
      await persistState();
      await ownerIntervention.dispatch({
        conversationId: event.conversationId,
        active,
        ownerMessageId: String(event.eventId),
        ownerContent: "",
        createTime: event.occurredAt,
        frozenControl,
        classification: {
          intent: "communication_takeover",
          source: "owner_reaction",
          confidence: 1,
        },
        emitFrame,
      });
    },
  });

  const deliveryControl = createDeliveryCoordinator({
    sendEnabled: config.sendEnabled === true,
    selfUserId: config.selfUserId,
    outboundQuietMs: config.outboundQuietMs,
    outboundMaxQuietMs: config.outboundMaxQuietMs,
    dws,
    state,
    persist: persistState,
    diagnose,
    now,
    clock,
    wait,
    recipients,
    activeConversations,
    replyFenceCurrent: async ({
      conversationId,
      active,
      ownerRevision,
      sendGeneration,
    }) => {
      const local = controlStates.get(conversationId);
      const external = controlStore && active ? await controlStore.snapshot() : null;
      const task = active
        ? external?.tasks?.[taskId(conversationId, active.participantUserId)]
        : null;
      return Boolean(
        Number.isSafeInteger(ownerRevision) && Number.isSafeInteger(sendGeneration) &&
        local && local.ownerRevision === ownerRevision &&
        local.sendGeneration === sendGeneration && external?.global?.state !== "paused" &&
        responsibilityControl.isReadyFor(active, conversationId) &&
        !["paused", "taken_over"].includes(task?.state) &&
        (!task || (
          task.ownerRevision === ownerRevision && task.sendGeneration === sendGeneration
        ))
      );
    },
  });

  const taskControl = createTaskCoordinator({
    selfUserId: config.selfUserId,
    mediaRoot: config.mediaRoot,
    responsibilityReactionsEnabled: config.responsibilityReactionsEnabled === true,
    semanticTimeoutMs: config.semanticInterventionTimeoutMs,
    classifierEnvironment,
    dws,
    state,
    now,
    diagnose,
    diagnosticHash: hash,
    taskKey: taskId,
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
  });

  const messageIngress = createMessageIngress({
    userIds: config.userIds,
    groupIds: config.groupIds,
    enterpriseUsersEnabled: config.enterpriseUsersEnabled,
    selfUserId: config.selfUserId,
    initialLookbackMs: config.initialLookbackMs,
    historySettleMs: config.historySettleMs,
    dws,
    state,
    persist: persistState,
    persistCheckHealth,
    now,
    emit,
    diagnose,
    diagnosticHash: hash,
    taskKey: taskId,
    enterpriseIdentity,
    deliveryControl,
    taskControl,
    activeConversations,
    takeoverReported,
    controlStates,
    controlStore,
    ownerIntervention,
  });

  const checkpoint = createCheckpointCoordinator({
    performCheck: messageIngress.performCheck,
    diagnose,
    fallbackMs: config.fallbackMs,
  });

  if (config.dingtalkRoot && isAbsolute(config.dingtalkRoot)) {
    for (const directory of await discoverWatchDirectories(config.dingtalkRoot)) {
      const watcher = watch(directory, { persistent: true }, () => checkpoint.request("filesystem"));
      watcher.on("error", () => {});
      watchers.push(watcher);
    }
  }
  checkpoint.startFallback();

  const synchronizeProjects = async () => {
    let gbrainProjects = [];
    if (config.productionConfigFile) {
      try {
        const client = await memoryClientFactory({ configPath: config.productionConfigFile });
        const catalog = await boundedPromise(
          client.listProjects({ maximum: 1_000 }),
          5_000,
        );
        if (catalog?.sourceId === "default" && Array.isArray(catalog.projects)) {
          gbrainProjects = catalog.projects.slice(0, 1_000);
        }
      } catch {}
    }
    try {
      const synchronized = await projectRegistrySynchronizer({
        registryPath: config.projectRegistryFile,
        codexStatePath: config.codexProjectStateFile,
        userHome: config.projectUserHome,
        gbrainProjects,
        apply: true,
      });
      if (synchronized.changed) diagnose(
        `foursday_project_registry_synced:${synchronized.addedProjectCount}`,
      );
      if (taskReconciliationStarted && synchronized.changed) {
        queueMicrotask(() => taskReconciliation.run().catch(() => {}));
      }
    } catch {
      diagnose("foursday_project_registry_sync_failed:project_registry_sync_unavailable");
    }
  };

  const queueProjectSync = () => {
    if (projectSyncStopped) return;
    if (projectSyncTimer) clearTimeout(projectSyncTimer);
    projectSyncTimer = setTimeout(() => {
      projectSyncTimer = null;
      projectSyncQueue = projectSyncQueue.then(synchronizeProjects, synchronizeProjects);
    }, projectSyncDebounceMs);
    projectSyncTimer.unref?.();
  };

  const startProjectWatcher = () => {
    if (
      projectStateWatcherStarted || config.projectSyncEnabled !== true ||
      !config.codexProjectStateFile
    ) return;
    projectStateWatcherStarted = true;
    try {
      const target = basename(config.codexProjectStateFile);
      const watcher = projectWatchFactory(
        dirname(config.codexProjectStateFile),
        { persistent: true },
        (_event, filename) => {
          if (filename == null || String(filename) === target) queueProjectSync();
        },
      );
      watcher.on?.("error", () => {
        diagnose("foursday_project_registry_watch_failed:project_registry_sync_unavailable");
      });
      watchers.push(watcher);
    } catch {
      diagnose("foursday_project_registry_watch_failed:project_registry_sync_unavailable");
    }
  };

  return {
    async start({ deferStartupReconcile = false } = {}) {
      if (config.projectSyncEnabled === true) {
        await synchronizeProjects();
        startProjectWatcher();
      }
      await deliveryControl.start();
      await durableExecution.recover();
      await responsibilityControl.start({
        takenOverConversationIds: [...takeoverReported],
      });
      if (deferStartupReconcile) {
        emit({
          type: "ready",
          transport: watchers.length > 0 ? "filesystem-events-with-fallback" : "fallback",
          targets: config.userIds.length,
          groups: config.groupIds.length,
          reconciling: false,
        });
      } else {
        let initialFrames = [];
        try {
          initialFrames = await checkpoint.check({
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
      }
      await persistState();
      eventWakeController = await startPersonalEventWake({
        enabled: config.eventWakeEnabled,
        dws,
        state,
        persist: persistState,
        now,
        diagnose,
        onEvent: (event) => {
          if (
            config.responsibilityReactionsEnabled === true &&
            event?.conversationId && event?.senderOpenDingTalkId
          ) {
            responsibilityControl.ensureWake({
              chatType: "direct",
              conversationId: event.conversationId,
              participantOpenDingTalkId: event.senderOpenDingTalkId,
            }).catch((error) => {
              diagnose(`dws_reaction_event_unavailable:${diagnosticCode(
                error,
                "reaction_event_unavailable",
              )}`);
            });
          }
          checkpoint.request("dws_event");
        },
      });
      taskReconciliationStarted = true;
      taskReconciliation.start();
      if (
        config.eventWakeEnabled &&
        typeof dws.createPersonalEventWake === "function" &&
        !eventWakeController
      ) return;
    },
    send: deliveryControl.send,
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
    inspectBackground: durableExecution.inspect,
    acknowledgeBackground: durableExecution.acknowledge,
    activateBackground: durableExecution.activate,
    startBackground: durableExecution.start,
    finishBackground: durableExecution.finish,
    claimResponsibility: responsibilityControl.claim,
    releaseResponsibility: responsibilityControl.release,
    settleResponsibility: responsibilityControl.settle,
    groupResponsibilityMessages: taskControl.groupResponsibilityMessages,
    classifyResponseDuty: taskControl.classifyResponseDuty,
    async reconcile() {
      await checkpoint.check({
        deferEmit: false,
        wakeSource: "startup",
        reconcileLookbackMs: config.initialLookbackMs,
      });
      return { success: true };
    },
    async stop() {
      projectSyncStopped = true;
      if (projectSyncTimer) clearTimeout(projectSyncTimer);
      projectSyncTimer = null;
      checkpoint.stop();
      for (const watcher of watchers) watcher.close();
      await projectSyncQueue.catch(() => {});
      if (eventWakeController) await eventWakeController.stop();
      taskReconciliation.stop();
      await responsibilityControl.stop();
      await persistState();
    },
    check: checkpoint.check,
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
        : frame.action === "inspect-background"
          ? await runtime.inspectBackground(frame.payload)
        : frame.action === "acknowledge-background"
          ? await runtime.acknowledgeBackground(frame.payload)
        : frame.action === "activate-background"
          ? await runtime.activateBackground(frame.payload)
        : frame.action === "start-background"
          ? await runtime.startBackground(frame.payload)
        : frame.action === "finish-background"
          ? await runtime.finishBackground(frame.payload)
        : frame.action === "claim-responsibility"
          ? await runtime.claimResponsibility(frame.payload)
        : frame.action === "release-responsibility"
          ? await runtime.releaseResponsibility(frame.payload)
        : frame.action === "settle-responsibility"
          ? await runtime.settleResponsibility(frame.payload)
        : frame.action === "group-responsibility"
          ? await runtime.groupResponsibilityMessages(frame.payload)
        : frame.action === "classify-response-duty"
          ? await runtime.classifyResponseDuty(frame.payload)
        : frame.action === "reconcile"
          ? await runtime.reconcile()
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
  await runtime.start({ deferStartupReconcile: true });
}

if (isMainModule(import.meta.url)) {
  await runProtocol();
}

export { hash };
