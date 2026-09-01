import {
  diagnosticCode,
  enterpriseIdentityRetryDefaults,
  enterpriseIdentityRetryKey,
  epoch,
  normalizeEnterpriseRetryMessage,
} from "./foursday-runtime-state.mjs";

export function createEnterpriseIdentityCoordinator({
  dws,
  state,
  seen,
  diagnose,
  diagnosticHash,
  now = () => new Date(),
  retryTtlMs = enterpriseIdentityRetryDefaults.ttlMs,
  retryMaxAttempts = enterpriseIdentityRetryDefaults.maxAttempts,
  retryCapacity = enterpriseIdentityRetryDefaults.capacity,
} = {}) {
  if (!state || typeof state !== "object" || !(seen instanceof Set)) {
    throw new Error("Foursday enterprise identity state ports are invalid");
  }
  if (typeof diagnose !== "function" || typeof diagnosticHash !== "function") {
    throw new Error("Foursday enterprise identity diagnostic ports are invalid");
  }
  const queue = new Map(Object.entries(state.enterpriseIdentityQueue ?? {}));
  while (queue.size > retryCapacity) queue.delete(queue.keys().next().value);
  const rejectedIds = new Set(state.enterpriseIdentityRejectedIds ?? []);

  const sync = () => {
    state.enterpriseIdentityQueue = Object.fromEntries(queue);
    state.enterpriseIdentityRejectedIds = [...rejectedIds];
  };
  sync();

  const retryDelayMs = (attempts) => Math.min(
    5 * 60_000,
    5_000 * (2 ** Math.max(0, attempts - 1)),
  );

  const failure = (error) => {
    if (typeof dws?.enterpriseIdentityFailure === "function") {
      return dws.enterpriseIdentityFailure(error);
    }
    const code = diagnosticCode(error, "dws_enterprise_identity_check_failed");
    return {
      errorCode: code,
      retryable: !/(?:identity_(?:required|unavailable|mismatch)|auth|unauthorized|forbidden)/iu
        .test(`${code} ${String(error?.message ?? "")}`),
    };
  };

  const reject = (message, errorCode, reason = "identity_rejected") => {
    const rejectionId = enterpriseIdentityRetryKey(
      message?.id ?? `${message?.conversationId ?? "unknown"}:${message?.createTime ?? "unknown"}:${errorCode}`,
    );
    if (rejectedIds.has(rejectionId)) return false;
    rejectedIds.add(rejectionId);
    if (rejectedIds.size > 1_000) rejectedIds.delete(rejectedIds.values().next().value);
    state.enterpriseIdentityRejections = {
      count: Number(state.enterpriseIdentityRejections?.count ?? 0) + 1,
      lastAt: now().toISOString(),
      lastErrorCode: diagnosticCode({ code: errorCode }, reason),
    };
    sync();
    diagnose(
      `dws_enterprise_${reason}:${diagnosticHash(message?.id)}:${state.enterpriseIdentityRejections.lastErrorCode}`,
    );
    return true;
  };

  const enqueue = (candidate, observedAt) => {
    const message = normalizeEnterpriseRetryMessage(candidate?.message);
    const errorCode = diagnosticCode(
      { code: candidate?.errorCode },
      "dws_enterprise_identity_check_failed",
    );
    if (!message || seen.has(message?.id)) {
      if (!message) reject(candidate?.message, "invalid_retry_envelope");
      return null;
    }
    const key = enterpriseIdentityRetryKey(message.id);
    if (queue.has(key)) return key;
    const identity = message.senderOpenDingTalkId || message.senderUserId;
    const sameIdentity = [...queue.values()].filter((entry) =>
      (entry.message.senderOpenDingTalkId || entry.message.senderUserId) === identity
    ).length;
    if (
      queue.size >= retryCapacity ||
      sameIdentity >= enterpriseIdentityRetryDefaults.perIdentityCapacity
    ) {
      reject(message, "identity_retry_capacity_exceeded", "identity_retry_dropped");
      return null;
    }
    const observed = epoch(observedAt) ?? now().getTime();
    queue.set(key, {
      message,
      firstSeenAt: new Date(observed).toISOString(),
      lastAttemptAt: new Date(observed).toISOString(),
      nextAttemptAt: new Date(observed + retryDelayMs(1)).toISOString(),
      expiresAt: new Date(observed + retryTtlMs).toISOString(),
      attempts: 1,
      lastErrorCode: errorCode,
    });
    sync();
    diagnose(`dws_enterprise_identity_retry_queued:${diagnosticHash(message.id)}:${errorCode}`);
    return key;
  };

  const retry = async (at) => {
    if (typeof dws?.retryEnterpriseDirectMessage !== "function") return [];
    const recovered = [];
    for (const [key, entry] of queue) {
      if (seen.has(entry.message.id)) {
        queue.delete(key);
        continue;
      }
      const currentTime = at.getTime();
      if (
        currentTime >= (epoch(entry.expiresAt) ?? 0) ||
        entry.attempts >= retryMaxAttempts
      ) {
        queue.delete(key);
        reject(entry.message, entry.lastErrorCode, "identity_retry_expired");
        continue;
      }
      if (currentTime < (epoch(entry.nextAttemptAt) ?? 0)) continue;
      try {
        const message = await dws.retryEnterpriseDirectMessage(entry.message);
        recovered.push({ ...message, enterpriseIdentityRetryKey: key });
      } catch (error) {
        const result = failure(error);
        const attempts = entry.attempts + 1;
        if (!result.retryable || attempts >= retryMaxAttempts) {
          queue.delete(key);
          reject(
            entry.message,
            result.errorCode,
            result.retryable ? "identity_retry_expired" : "identity_rejected",
          );
          continue;
        }
        queue.set(key, {
          ...entry,
          attempts,
          lastAttemptAt: at.toISOString(),
          nextAttemptAt: new Date(currentTime + retryDelayMs(attempts)).toISOString(),
          lastErrorCode: result.errorCode,
        });
      }
    }
    sync();
    return recovered;
  };

  const attachRetryKey = (message) => {
    const key = enterpriseIdentityRetryKey(message?.id);
    return queue.has(key) ? { ...message, enterpriseIdentityRetryKey: key } : message;
  };

  const resolve = (key, messageId) => {
    if (!key || !queue.delete(key)) return false;
    sync();
    diagnose(`dws_enterprise_identity_retry_resolved:${diagnosticHash(messageId)}`);
    return true;
  };

  return {
    enqueue,
    reject,
    retry,
    attachRetryKey,
    resolve,
    pendingCount: () => queue.size,
  };
}
