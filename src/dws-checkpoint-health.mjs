const lifecycleStates = new Set(["idle", "running", "completed", "failed"]);

function timestamp(value) {
  const parsed = new Date(typeof value === "string" ? value : "").getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedFallback(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30_000;
  return Math.min(5 * 60_000, Math.max(5_000, Math.trunc(parsed)));
}

export function normalizeDwsCheckLifecycle(value = {}) {
  const status = lifecycleStates.has(value?.status) ? value.status : "idle";
  const generation = Number(value?.generation ?? 0);
  return {
    status,
    generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    operation: typeof value?.operation === "string"
      ? value.operation.slice(0, 40)
      : null,
    wakeSource: typeof value?.wakeSource === "string"
      ? value.wakeSource.slice(0, 40)
      : null,
    startedAt: timestamp(value?.startedAt) == null ? null : value.startedAt,
    completedAt: timestamp(value?.completedAt) == null ? null : value.completedAt,
    errorCount: Number.isSafeInteger(value?.errorCount) && value.errorCount >= 0
      ? value.errorCount
      : 0,
  };
}

export function evaluateDwsCheckpointHealth({
  state,
  now = Date.now(),
  fallbackMs = 30_000,
  modifiedAt = null,
} = {}) {
  const currentTime = Number(now);
  const fallback = boundedFallback(fallbackMs);
  const normalMaxAgeMs = Math.max(60_000, fallback * 2);
  const busyMaxAgeMs = Math.max(
    normalMaxAgeMs,
    Math.min(15 * 60_000, Math.max(120_000, fallback * 4)),
  );
  const lifecycle = normalizeDwsCheckLifecycle(state?.checkLifecycle);
  const successAt = timestamp(state?.lastFullSuccessAt);
  const startedAt = timestamp(lifecycle.startedAt);
  const fileAt = modifiedAt == null ? null : Number(modifiedAt);
  const age = (value) => (
    Number.isFinite(currentTime) && Number.isFinite(value)
      ? currentTime - value
      : Number.POSITIVE_INFINITY
  );
  const successAgeMs = age(successAt);
  const startedAgeMs = age(startedAt);
  const fileAgeMs = fileAt == null ? null : age(fileAt);
  const clockSkewToleranceMs = 5_000;
  const fresh = (value, limit) => value >= -clockSkewToleranceMs && value <= limit;
  const fileFresh = (limit) => fileAgeMs == null || fresh(fileAgeMs, limit);
  const errorCount = Number.isSafeInteger(state?.lastErrorCount) && state.lastErrorCount >= 0
    ? state.lastErrorCount
    : 1;

  let checkpointState = "stale";
  if (errorCount > 0 || lifecycle.status === "failed" || lifecycle.errorCount > 0) {
    checkpointState = "failed";
  } else if (
    lifecycle.status === "running" &&
    lifecycle.generation > 0 &&
    fresh(startedAgeMs, busyMaxAgeMs) &&
    fresh(successAgeMs, busyMaxAgeMs) &&
    fileFresh(busyMaxAgeMs)
  ) {
    checkpointState = "busy_but_bounded";
  } else if (
    lifecycle.status !== "running" &&
    fresh(successAgeMs, normalMaxAgeMs) &&
    fileFresh(normalMaxAgeMs)
  ) {
    checkpointState = "healthy";
  }

  return {
    checkpointState,
    checkpointHealthy: checkpointState === "healthy" || checkpointState === "busy_but_bounded",
    checkpointBusy: checkpointState === "busy_but_bounded",
    checkpointGeneration: lifecycle.generation,
    checkpointOperation: lifecycle.operation,
    normalMaxAgeMs,
    busyMaxAgeMs,
  };
}
