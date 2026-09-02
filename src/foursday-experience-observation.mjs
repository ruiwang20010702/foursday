import { createHash } from "node:crypto";

const observationKeys = new Set([
  "schema",
  "sourceHash",
  "taskClass",
  "wakeSource",
  "detectionMs",
  "internalDetectionMs",
  "acknowledgmentMs",
  "firstEffectiveReplyMs",
  "responsibilityCorrect",
  "duplicated",
  "takeoverObserved",
  "repliedAfterTakeover",
  "completed",
]);
const taskClasses = new Set(["instant", "normal", "long"]);
const wakeSources = new Set([
  "dws_event", "filesystem", "fallback", "startup", "manual", "unknown",
]);
const evidenceHash = /^[a-f0-9]{16,64}$/u;

function duration(value, name, { optional = false } = {}) {
  if (optional && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 24 * 60 * 60_000) {
    throw new Error(`${name} must be an integer between 0 and 86400000`);
  }
  return value;
}

function boolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

export function normalizeFoursdayExperienceObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Foursday experience observation must be an object");
  }
  const unknown = Object.keys(value).filter((key) => !observationKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(`Foursday experience observation contains unknown fields: ${unknown.join(",")}`);
  }
  if (value.schema !== "foursday-experience-observation/v1") {
    throw new Error("Foursday experience observation schema is invalid");
  }
  const sourceHash = String(value.sourceHash ?? "").trim().toLowerCase();
  if (!evidenceHash.test(sourceHash)) {
    throw new Error("Foursday experience sourceHash must be a 16-64 character lowercase hex digest");
  }
  const taskClass = String(value.taskClass ?? "").trim();
  if (!taskClasses.has(taskClass)) throw new Error("Foursday experience taskClass is invalid");
  const wakeSource = String(value.wakeSource ?? "").trim();
  if (!wakeSources.has(wakeSource)) throw new Error("Foursday experience wakeSource is invalid");
  const takeoverObserved = boolean(value.takeoverObserved, "takeoverObserved");
  if (takeoverObserved && typeof value.repliedAfterTakeover !== "boolean") {
    throw new Error("repliedAfterTakeover must be boolean when takeoverObserved is true");
  }
  if (!takeoverObserved && value.repliedAfterTakeover != null) {
    throw new Error("repliedAfterTakeover must be omitted when takeoverObserved is false");
  }
  return {
    schema: value.schema,
    sourceHash,
    taskClass,
    wakeSource,
    detectionMs: duration(value.detectionMs, "detectionMs"),
    internalDetectionMs: duration(value.internalDetectionMs, "internalDetectionMs", { optional: true }),
    acknowledgmentMs: duration(value.acknowledgmentMs, "acknowledgmentMs", { optional: true }),
    firstEffectiveReplyMs: duration(value.firstEffectiveReplyMs, "firstEffectiveReplyMs", { optional: true }),
    responsibilityCorrect: boolean(value.responsibilityCorrect, "responsibilityCorrect"),
    duplicated: boolean(value.duplicated, "duplicated"),
    takeoverObserved,
    repliedAfterTakeover: takeoverObserved ? value.repliedAfterTakeover : null,
    completed: boolean(value.completed, "completed"),
  };
}

export function foursdayExperienceTaskHash(sourceHash) {
  if (!evidenceHash.test(String(sourceHash ?? ""))) {
    throw new Error("Foursday experience source hash is invalid");
  }
  return createHash("sha256")
    .update(`foursday-real-task/v1\0${sourceHash}`)
    .digest("hex");
}

export function foursdayExperienceObservationEvents(value, { recordedAt = new Date().toISOString() } = {}) {
  const observation = normalizeFoursdayExperienceObservation(value);
  const taskHash = foursdayExperienceTaskHash(observation.sourceHash);
  const common = { taskHash, recordedAt };
  const events = [{
    ...common,
    type: "message_detected",
    durationMs: observation.detectionMs,
    checkToDetectionMs: observation.internalDetectionMs,
    wakeSource: observation.wakeSource,
  }];
  if (observation.acknowledgmentMs != null) {
    events.push({ ...common, type: "ack_sent", durationMs: observation.acknowledgmentMs });
  }
  if (observation.firstEffectiveReplyMs != null) {
    events.push({
      ...common,
      type: "first_effective_reply",
      taskClass: observation.taskClass,
      durationMs: observation.firstEffectiveReplyMs,
    });
  }
  events.push(
    { ...common, type: "responsibility_check", correct: observation.responsibilityCorrect },
    { ...common, type: "duplicate_send_check", duplicated: observation.duplicated },
  );
  if (observation.takeoverObserved) {
    events.push({
      ...common,
      type: "takeover_reply_check",
      repliedAfterTakeover: observation.repliedAfterTakeover,
    });
  }
  events.push({ ...common, type: "task_result", completed: observation.completed });
  return { taskHash, events };
}
