import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const digest = /^[a-f0-9]{64}$/u;
const projectId = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const lifecycleStates = new Set([
  "intake", "planning", "working", "verifying", "waiting_acceptance",
  "rework_requested", "escalated", "failed", "completed", "accepted",
]);
const agentLifecycleStates = new Set([...lifecycleStates].filter((value) => value !== "accepted"));
const evidenceKinds = new Set([
  "message", "memory", "source", "file", "tool", "test", "delivery", "runtime",
]);
const evidenceStates = new Set(["observed", "verified", "missing"]);
const activityKinds = new Set([
  "analyze", "read", "search", "tool", "edit", "test", "verify", "complete", "failed",
]);
const maximumActivityEvents = 2_000;
const executionModes = new Set(["instant", "foreground", "background"]);
const executionStates = new Set([
  "foreground", "ack_pending", "acknowledged", "queued", "running",
  "blocked", "completed", "failed", "cancelled",
]);
const secretMaterial = /(?:password|secret|token|authorization|private[ _-]?key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{10,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)?:\/\/\S+|\bfctx_[a-f0-9]{64}\b/iu;
const noWrite = (result) => ({ __noWrite: true, result });

function boundedText(value, maximum, name, { required = true } = {}) {
  const text = String(value ?? "").replace(/\0/gu, "").trim();
  if (
    (required && !text) || text.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
    secretMaterial.test(text)
  ) throw new Error(`Foursday task ledger ${name} is invalid`);
  return text;
}

function boundedList(value, maximumItems, maximumLength, name) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`Foursday task ledger ${name} is invalid`);
  }
  return value.map((item) => boundedText(item, maximumLength, name));
}

function normalizeEvidence(value) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("Foursday task ledger evidence is invalid");
  }
  return value.map((item) => {
    if (
      !item || typeof item !== "object" || Array.isArray(item) ||
      !evidenceKinds.has(item.kind) || !evidenceStates.has(item.status)
    ) throw new Error("Foursday task ledger evidence is invalid");
    return {
      kind: item.kind,
      status: item.status,
      summary: boundedText(item.summary, 240, "evidence summary"),
    };
  });
}

function normalizeTask(value, key) {
  if (
    !value || typeof value !== "object" || !digest.test(key) || value.taskId !== key ||
    !agentLifecycleStates.has(value.lifecycleState) && value.lifecycleState !== "accepted" ||
    !Number.isSafeInteger(value.ownerRevision) || value.ownerRevision < 0 ||
    !Number.isSafeInteger(value.sendGeneration) || value.sendGeneration < 0 ||
    !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
  ) throw new Error("Foursday task ledger task is invalid");
  if (value.projectId != null && !projectId.test(String(value.projectId))) {
    throw new Error("Foursday task ledger project is invalid");
  }
  return {
    taskId: key,
    projectId: value.projectId == null ? null : String(value.projectId),
    title: boundedText(value.title, 120, "title"),
    goal: boundedText(value.goal, 1_000, "goal"),
    deliverables: boundedList(value.deliverables, 8, 200, "deliverables"),
    acceptanceCriteria: boundedList(value.acceptanceCriteria, 8, 240, "acceptance criteria"),
    lifecycleState: value.lifecycleState,
    confidence: Number(value.confidence),
    evidence: normalizeEvidence(value.evidence),
    ownerRevision: value.ownerRevision,
    sendGeneration: value.sendGeneration,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

function normalizeActivity(value) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !digest.test(String(value.eventId ?? "")) || !activityKinds.has(value.kind) ||
    typeof value.occurredAt !== "string" || !Number.isFinite(new Date(value.occurredAt).getTime())
  ) throw new Error("Foursday task ledger activity is invalid");
  return {
    eventId: value.eventId,
    kind: value.kind,
    summary: boundedText(value.summary, 140, "activity summary"),
    detail: boundedText(value.detail, 160, "activity detail", { required: false }),
    occurredAt: value.occurredAt,
  };
}

function normalizeSummary(value, key) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) || !digest.test(key) ||
    !Number.isSafeInteger(value.ownerRevision) || value.ownerRevision < 0 ||
    !Number.isSafeInteger(value.sendGeneration) || value.sendGeneration < 0 ||
    typeof value.updatedAt !== "string" || !Number.isFinite(new Date(value.updatedAt).getTime())
  ) throw new Error("Foursday task ledger summary is invalid");
  return {
    title: boundedText(value.title, 120, "summary title"),
    ownerRevision: value.ownerRevision,
    sendGeneration: value.sendGeneration,
    updatedAt: value.updatedAt,
  };
}

function normalizeExecution(value, key) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) || !digest.test(key) ||
    !digest.test(String(value.executionId ?? "")) || !executionModes.has(value.mode) ||
    !executionStates.has(value.state) ||
    !Number.isSafeInteger(value.ownerRevision) || value.ownerRevision < 0 ||
    !Number.isSafeInteger(value.sendGeneration) || value.sendGeneration < 0 ||
    !Number.isSafeInteger(value.stepCount) || value.stepCount < 0 || value.stepCount > 32 ||
    !Number.isSafeInteger(value.activityCount) || value.activityCount < 0 || value.activityCount > 10_000 ||
    !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0 || value.attemptCount > 20 ||
    typeof value.updatedAt !== "string" || !Number.isFinite(new Date(value.updatedAt).getTime())
  ) throw new Error("Foursday task ledger execution is invalid");
  const optionalTime = (time, name) => {
    if (time == null) return null;
    if (typeof time !== "string" || !Number.isFinite(new Date(time).getTime())) {
      throw new Error(`Foursday task ledger execution ${name} is invalid`);
    }
    return time;
  };
  return {
    executionId: value.executionId,
    mode: value.mode,
    state: value.state,
    decisionSource: ["codex", "runtime"].includes(value.decisionSource)
      ? value.decisionSource : "codex",
    planSummary: boundedText(value.planSummary, 500, "execution plan"),
    acknowledgment: boundedText(value.acknowledgment, 500, "execution acknowledgment", {
      required: value.mode !== "instant",
    }),
    stepCount: value.stepCount,
    requiresExternalWait: value.requiresExternalWait === true,
    requiresDurability: value.requiresDurability === true,
    activityCount: value.activityCount,
    ownerRevision: value.ownerRevision,
    sendGeneration: value.sendGeneration,
    attemptCount: value.attemptCount,
    startedAt: optionalTime(value.startedAt, "startedAt"),
    acknowledgedAt: optionalTime(value.acknowledgedAt, "acknowledgedAt"),
    queuedAt: optionalTime(value.queuedAt, "queuedAt"),
    leaseExpiresAt: optionalTime(value.leaseExpiresAt, "leaseExpiresAt"),
    completedAt: optionalTime(value.completedAt, "completedAt"),
    updatedAt: value.updatedAt,
    lastErrorCode: boundedText(value.lastErrorCode, 80, "execution error", { required: false }),
  };
}

function emptyDocument() {
  return {
    schema: "foursday-task-ledger/v1", revision: 0,
    tasks: {}, activities: {}, summaries: {}, executions: {},
  };
}

function normalizeDocument(value) {
  if (
    !value || value.schema !== "foursday-task-ledger/v1" ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    !value.tasks || typeof value.tasks !== "object" || Array.isArray(value.tasks) ||
    Object.keys(value.tasks).length > 1_000 ||
    (value.activities != null && (
      typeof value.activities !== "object" || Array.isArray(value.activities) ||
      Object.keys(value.activities).length > 1_000
    )) ||
    (value.summaries != null && (
      typeof value.summaries !== "object" || Array.isArray(value.summaries) ||
      Object.keys(value.summaries).length > 1_000
    )) ||
    (value.executions != null && (
      typeof value.executions !== "object" || Array.isArray(value.executions) ||
      Object.keys(value.executions).length > 1_000
    ))
  ) throw new Error("Foursday task ledger file is invalid");
  const activities = value.activities ?? {};
  if (Object.values(activities).reduce((sum, rows) =>
    sum + (Array.isArray(rows) ? rows.length : maximumActivityEvents + 1), 0) > maximumActivityEvents) {
    throw new Error("Foursday task ledger activity capacity is invalid");
  }
  return {
    schema: value.schema,
    revision: value.revision,
    tasks: Object.fromEntries(Object.entries(value.tasks).map(([key, task]) => [
      key, normalizeTask(task, key),
    ])),
    activities: Object.fromEntries(Object.entries(activities).map(([key, rows]) => {
      if (!digest.test(key) || !Array.isArray(rows) || rows.length > 20) {
        throw new Error("Foursday task ledger activities are invalid");
      }
      return [key, rows.map(normalizeActivity)];
    })),
    summaries: Object.fromEntries(Object.entries(value.summaries ?? {}).map(([key, summary]) => [
      key, normalizeSummary(summary, key),
    ])),
    executions: Object.fromEntries(Object.entries(value.executions ?? {}).map(([key, execution]) => [
      key, normalizeExecution(execution, key),
    ])),
  };
}

async function privateParent(path) {
  const parent = resolve(dirname(path));
  const prior = await lstat(parent).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!prior) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
  }
  const metadata = await lstat(parent);
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || await realpath(parent) !== parent ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) throw new Error("Foursday task ledger parent is unsafe");
  return parent;
}

async function readDocument(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return emptyDocument();
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 2 * 1024 * 1024 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) throw new Error("Foursday task ledger file is unsafe");
    return normalizeDocument(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

export class FoursdayTaskLedgerStore {
  constructor({ path }) {
    if (!isAbsolute(path)) throw new Error("Foursday task ledger path must be absolute");
    this.path = resolve(path);
    this.parent = null;
  }

  async open({ createParent = false } = {}) {
    if (createParent) this.parent = await privateParent(this.path);
    return this;
  }

  async snapshot() {
    return readDocument(this.path);
  }

  async upsertFromAgent({
    taskId,
    projectId: project,
    title,
    goal,
    deliverables = [],
    acceptanceCriteria = [],
    lifecycleState,
    confidence,
    evidence = [],
    ownerRevision,
    sendGeneration,
  }) {
    if (
      !digest.test(String(taskId ?? "")) ||
      (project != null && !projectId.test(String(project))) ||
      !agentLifecycleStates.has(lifecycleState) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0
    ) throw new Error("Foursday task ledger update is invalid");
    const candidate = normalizeTask({
      taskId,
      projectId: project,
      title,
      goal,
      deliverables,
      acceptanceCriteria,
      lifecycleState,
      confidence: Number(confidence),
      evidence,
      ownerRevision,
      sendGeneration,
      updatedAt: new Date().toISOString(),
    }, taskId);
    if (
      lifecycleState === "waiting_acceptance" &&
      !candidate.evidence.some((item) => item.status === "verified")
    ) throw new Error("Foursday task ledger waiting acceptance requires verified evidence");
    return this.#mutate((document, timestamp) => {
      const prior = document.tasks[taskId];
      if (
        prior && (
          ownerRevision < prior.ownerRevision ||
          (ownerRevision === prior.ownerRevision && sendGeneration < prior.sendGeneration)
        )
      ) throw new Error("foursday_task_ledger_revision_conflict");
      document.tasks[taskId] = { ...candidate, updatedAt: timestamp };
      return { task: { ...document.tasks[taskId] } };
    });
  }

  async appendActivity({ taskId, activity, ownerRevision, sendGeneration }) {
    if (
      !digest.test(String(taskId ?? "")) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0
    ) throw new Error("Foursday task ledger activity update is invalid");
    const normalized = normalizeActivity(activity);
    return this.#mutate((document) => {
      const task = document.tasks[taskId];
      if (task && (
        ownerRevision < task.ownerRevision ||
        (ownerRevision === task.ownerRevision && sendGeneration < task.sendGeneration)
      )) throw new Error("foursday_task_ledger_revision_conflict");
      const rows = document.activities[taskId] ?? [];
      if (rows.some((item) => item.eventId === normalized.eventId)) {
        return noWrite({ activity: { ...normalized }, appended: false });
      }
      document.activities[taskId] = [...rows, normalized].slice(-20);
      let total = Object.values(document.activities).reduce((sum, items) => sum + items.length, 0);
      while (total > maximumActivityEvents) {
        const oldest = Object.entries(document.activities)
          .filter(([, items]) => items.length > 0)
          .sort((left, right) => left[1][0].occurredAt.localeCompare(right[1][0].occurredAt))[0];
        if (!oldest) break;
        document.activities[oldest[0]].shift();
        if (document.activities[oldest[0]].length === 0) delete document.activities[oldest[0]];
        total -= 1;
      }
      return { activity: { ...normalized }, appended: true };
    });
  }

  async recordSummary({ taskId, title, ownerRevision, sendGeneration }) {
    if (!digest.test(String(taskId ?? ""))) {
      throw new Error("Foursday task ledger summary update is invalid");
    }
    return this.#mutate((document, timestamp) => {
      const summary = normalizeSummary({
        title,
        ownerRevision,
        sendGeneration,
        updatedAt: timestamp,
      }, taskId);
      const prior = document.summaries[taskId];
      if (prior && (
        ownerRevision < prior.ownerRevision ||
        (ownerRevision === prior.ownerRevision && sendGeneration < prior.sendGeneration)
      )) throw new Error("foursday_task_ledger_revision_conflict");
      if (
        prior?.title === summary.title && prior.ownerRevision === ownerRevision &&
        prior.sendGeneration === sendGeneration
      ) return noWrite({ summary: { ...prior }, updated: false });
      document.summaries[taskId] = summary;
      return { summary: { ...summary }, updated: true };
    });
  }

  async setExecutionPlan({
    taskId,
    expectedClass,
    planSummary,
    stepCount,
    requiresExternalWait = false,
    requiresDurability = false,
    acknowledgment = "",
    ownerRevision,
    sendGeneration,
  }) {
    if (
      !digest.test(String(taskId ?? "")) ||
      !["instant", "foreground", "background"].includes(expectedClass) ||
      !Number.isSafeInteger(stepCount) || stepCount < 0 || stepCount > 32 ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0
    ) throw new Error("Foursday task ledger execution plan is invalid");
    return this.#mutate((document, timestamp) => {
      const prior = document.executions[taskId];
      if (prior && (
        ownerRevision < prior.ownerRevision ||
        (ownerRevision === prior.ownerRevision && sendGeneration < prior.sendGeneration)
      )) throw new Error("foursday_task_ledger_revision_conflict");
      const inferredBackground = expectedClass === "background" || requiresExternalWait === true ||
        requiresDurability === true || stepCount >= 4;
      const requestedMode = inferredBackground
        ? "background" : expectedClass === "instant" ? "instant" : "foreground";
      const sameGeneration = prior?.ownerRevision === ownerRevision &&
        prior?.sendGeneration === sendGeneration;
      if (sameGeneration && ["completed", "failed", "cancelled"].includes(prior.state)) {
        return noWrite({ execution: { ...prior }, updated: false });
      }
      const mode = sameGeneration && prior.mode === "background" ? "background" : requestedMode;
      const state = sameGeneration && prior.mode === "background"
        ? prior.state : mode === "background" ? "ack_pending" : "foreground";
      let execution = normalizeExecution({
        executionId: createHash("sha256")
          .update(`${taskId}\0${ownerRevision}\0${sendGeneration}`).digest("hex"),
        mode,
        state,
        decisionSource: sameGeneration && prior?.decisionSource === "runtime" ? "runtime" : "codex",
        planSummary,
        acknowledgment,
        stepCount,
        requiresExternalWait,
        requiresDurability,
        activityCount: sameGeneration ? prior.activityCount : 0,
        ownerRevision,
        sendGeneration,
        attemptCount: sameGeneration ? prior.attemptCount : 0,
        startedAt: sameGeneration ? prior.startedAt : null,
        acknowledgedAt: sameGeneration ? prior.acknowledgedAt : null,
        queuedAt: sameGeneration ? prior.queuedAt : null,
        leaseExpiresAt: sameGeneration ? prior.leaseExpiresAt : null,
        completedAt: sameGeneration ? prior.completedAt : null,
        updatedAt: sameGeneration ? prior.updatedAt : timestamp,
        lastErrorCode: sameGeneration ? prior.lastErrorCode : "",
      }, taskId);
      if (sameGeneration && JSON.stringify(prior) === JSON.stringify(execution)) {
        return noWrite({ execution: { ...prior }, updated: false });
      }
      if (sameGeneration) execution = { ...execution, updatedAt: timestamp };
      document.executions[taskId] = execution;
      return { execution: { ...execution }, updated: true };
    });
  }

  async observeExecutionActivity({
    taskId,
    ownerRevision,
    sendGeneration,
    elapsedMs,
    kind,
  }) {
    if (
      !digest.test(String(taskId ?? "")) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0 ||
      !Number.isFinite(elapsedMs) || elapsedMs < 0 ||
      !activityKinds.has(kind)
    ) throw new Error("Foursday task ledger execution activity is invalid");
    return this.#mutate((document, timestamp) => {
      const prior = document.executions[taskId];
      if (!prior) {
        const contract = document.tasks[taskId];
        const activityCount = document.activities[taskId]?.length ?? 0;
        if (
          !contract || contract.ownerRevision !== ownerRevision ||
          contract.sendGeneration !== sendGeneration || elapsedMs < 15_000 || activityCount < 1
        ) return noWrite({ execution: null, promoted: false });
        const promoted = elapsedMs >= 20_000 && activityCount >= 2;
        const execution = normalizeExecution({
          executionId: createHash("sha256")
            .update(`${taskId}\0${ownerRevision}\0${sendGeneration}`).digest("hex"),
          mode: promoted ? "background" : "foreground",
          state: "ack_pending",
          decisionSource: "runtime",
          planSummary: contract.goal,
          acknowledgment: `收到，我正在处理“${contract.title}”，完成并验证后会同步结果。`,
          stepCount: Math.min(32, Math.max(2, contract.deliverables.length + 1)),
          requiresExternalWait: false,
          requiresDurability: promoted,
          activityCount,
          ownerRevision,
          sendGeneration,
          attemptCount: 0,
          startedAt: null,
          acknowledgedAt: null,
          queuedAt: null,
          leaseExpiresAt: null,
          completedAt: null,
          updatedAt: timestamp,
          lastErrorCode: "",
        }, taskId);
        document.executions[taskId] = execution;
        return { execution: { ...execution }, promoted, acknowledgmentPending: true };
      }
      if (prior.ownerRevision !== ownerRevision || prior.sendGeneration !== sendGeneration) {
        return noWrite({ execution: null, promoted: false });
      }
      if (["completed", "failed", "cancelled"].includes(prior.state)) {
        return noWrite({ execution: { ...prior }, promoted: false });
      }
      const activityCount = Math.min(10_000, prior.activityCount + 1);
      const promoted = prior.mode !== "background" && elapsedMs >= 20_000 && activityCount >= 2;
      const normalAcknowledgment = prior.mode === "foreground" && prior.state === "foreground" &&
        elapsedMs >= 15_000 && activityCount >= 1;
      const execution = normalizeExecution({
        ...prior,
        mode: promoted ? "background" : prior.mode,
        state: promoted
          ? (prior.state === "acknowledged" ? "acknowledged" : "ack_pending")
          : normalAcknowledgment ? "ack_pending" : prior.state,
        decisionSource: promoted ? "runtime" : prior.decisionSource,
        requiresDurability: promoted ? true : prior.requiresDurability,
        activityCount,
        updatedAt: timestamp,
      }, taskId);
      document.executions[taskId] = execution;
      return { execution: { ...execution }, promoted, acknowledgmentPending: normalAcknowledgment };
    });
  }

  async acknowledgeExecution({ taskId, executionId, ownerRevision, sendGeneration }) {
    return this.#transitionExecution({
      taskId, executionId, ownerRevision, sendGeneration,
      allowed: new Set(["ack_pending", "acknowledged"]),
      update: (execution, timestamp) => ({
        ...execution,
        state: "acknowledged",
        acknowledgedAt: execution.acknowledgedAt ?? timestamp,
        updatedAt: timestamp,
      }),
    });
  }

  async queueExecution({ taskId, executionId, ownerRevision, sendGeneration }) {
    return this.#transitionExecution({
      taskId, executionId, ownerRevision, sendGeneration,
      allowed: new Set(["acknowledged", "queued"]),
      update: (execution, timestamp) => ({
        ...execution,
        state: "queued",
        queuedAt: execution.queuedAt ?? timestamp,
        leaseExpiresAt: null,
        updatedAt: timestamp,
      }),
    });
  }

  async leaseExecution({ taskId, executionId, ownerRevision, sendGeneration, leaseMs = 120_000 }) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 15 * 60_000) {
      throw new Error("Foursday task ledger execution lease is invalid");
    }
    return this.#transitionExecution({
      taskId, executionId, ownerRevision, sendGeneration,
      allowed: new Set(["queued", "running"]),
      update: (execution, timestamp) => {
        const now = Date.parse(timestamp);
        if (
          execution.state === "running" && execution.leaseExpiresAt &&
          Date.parse(execution.leaseExpiresAt) > now
        ) return execution;
        if (execution.attemptCount >= 8) {
          return {
            ...execution,
            state: "failed",
            leaseExpiresAt: null,
            completedAt: timestamp,
            updatedAt: timestamp,
            lastErrorCode: "background_attempts_exhausted",
          };
        }
        return {
          ...execution,
          state: "running",
          startedAt: execution.startedAt ?? timestamp,
          leaseExpiresAt: new Date(now + leaseMs).toISOString(),
          attemptCount: execution.attemptCount + 1,
          updatedAt: timestamp,
          lastErrorCode: "",
        };
      },
    });
  }

  async finishExecution({
    taskId,
    executionId,
    ownerRevision,
    sendGeneration,
    outcome,
    errorCode = "",
  }) {
    if (!["blocked", "completed", "failed", "cancelled"].includes(outcome)) {
      throw new Error("Foursday task ledger execution outcome is invalid");
    }
    return this.#transitionExecution({
      taskId, executionId, ownerRevision, sendGeneration,
      allowed: new Set(["foreground", "ack_pending", "acknowledged", "queued", "running", "blocked"]),
      update: (execution, timestamp) => ({
        ...execution,
        state: outcome,
        leaseExpiresAt: null,
        completedAt: ["completed", "failed", "cancelled"].includes(outcome) ? timestamp : null,
        updatedAt: timestamp,
        lastErrorCode: errorCode,
      }),
    });
  }

  async retryExecution({
    taskId,
    executionId,
    ownerRevision,
    sendGeneration,
    errorCode = "background_turn_failed",
  }) {
    return this.#transitionExecution({
      taskId, executionId, ownerRevision, sendGeneration,
      allowed: new Set(["running", "queued"]),
      update: (execution, timestamp) => execution.attemptCount >= 3
        ? {
            ...execution,
            state: "failed",
            leaseExpiresAt: null,
            completedAt: timestamp,
            updatedAt: timestamp,
            lastErrorCode: "background_retry_exhausted",
          }
        : {
            ...execution,
            state: "queued",
            queuedAt: timestamp,
            leaseExpiresAt: null,
            updatedAt: timestamp,
            lastErrorCode: errorCode,
          },
    });
  }

  async #transitionExecution({
    taskId, executionId, ownerRevision, sendGeneration, allowed, update,
  }) {
    if (
      !digest.test(String(taskId ?? "")) || !digest.test(String(executionId ?? "")) ||
      !Number.isSafeInteger(ownerRevision) || ownerRevision < 0 ||
      !Number.isSafeInteger(sendGeneration) || sendGeneration < 0
    ) throw new Error("Foursday task ledger execution transition is invalid");
    return this.#mutate((document, timestamp) => {
      const prior = document.executions[taskId];
      if (
        !prior || prior.executionId !== executionId ||
        prior.ownerRevision !== ownerRevision || prior.sendGeneration !== sendGeneration
      ) throw new Error("foursday_task_ledger_revision_conflict");
      if (!allowed.has(prior.state)) {
        if (["completed", "failed", "cancelled"].includes(prior.state)) {
          return noWrite({ execution: { ...prior }, updated: false });
        }
        throw new Error("foursday_task_ledger_execution_state_conflict");
      }
      const execution = normalizeExecution(update(prior, timestamp), taskId);
      if (JSON.stringify(prior) === JSON.stringify(execution)) {
        return noWrite({ execution: { ...prior }, updated: false });
      }
      document.executions[taskId] = execution;
      return { execution: { ...execution }, updated: true };
    });
  }

  async #mutate(callback) {
    if (!this.parent) this.parent = await privateParent(this.path);
    const lockPath = `${this.path}.lock`;
    let lock;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const metadata = await lstat(lockPath).catch(() => null);
        if (metadata && Date.now() - metadata.mtimeMs > 60_000) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    if (!lock) throw new Error("Foursday task ledger is busy");
    try {
      const document = await readDocument(this.path);
      const result = callback(document, new Date().toISOString());
      if (result?.__noWrite === true) {
        return { revision: document.revision, result: result.result, document };
      }
      document.revision += 1;
      const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        await rename(temporary, this.path);
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        throw error;
      }
      return { revision: document.revision, result, document };
    } finally {
      await lock.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }
}
