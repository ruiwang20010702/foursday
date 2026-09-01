const targets = Object.freeze({
  setupDurationMs: 10 * 60_000,
  setupInputCount: 3,
  detectionP95Ms: 10_000,
  acknowledgmentP95Ms: 15_000,
  instantReplyP50Ms: 30_000,
  responsibilityAccuracy: 0.9,
  duplicateSendRate: 0,
  takeoverReplyRate: 0,
  taskCompletionRate: 0.9,
});

function finite(values) {
  return values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
}

function percentile(values, ratio) {
  const sorted = finite(values).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return Math.round(sorted[index]);
}

function rate(rows, predicate) {
  if (rows.length === 0) return null;
  return rows.filter(predicate).length / rows.length;
}

function metric(value, sampleSize, target, pass) {
  return { value, sampleSize, target, passed: sampleSize > 0 ? pass : null };
}

export function analyzeFoursdayExperience(events = []) {
  if (!Array.isArray(events) || events.length > 100_000) {
    throw new Error("Foursday experience evidence is invalid");
  }
  const rows = events.filter((event) => event && typeof event === "object" && !Array.isArray(event));
  const setup = rows.filter((event) => event.type === "setup_completed" && event.success === true);
  const detections = rows.flatMap((event) => {
    if (event.type === "message_detected") return finite([event.durationMs ?? event.latencyMs]);
    if (event.type === "reply_attempt") return finite([event.detectionLatencyMs]);
    return [];
  });
  const acknowledgments = rows.flatMap((event) => {
    if (event.type === "ack_sent") return finite([event.durationMs]);
    if (event.type === "reply_attempt" && event.deliveryKind === "interim_ack") {
      return finite([event.agentDurationMs]);
    }
    return [];
  });
  const instantReplies = rows.flatMap((event) => {
    if (event.type === "first_effective_reply" && event.taskClass === "instant") return finite([event.durationMs]);
    if (event.type === "reply_attempt" && event.deliveryKind === "final" && event.taskClass === "instant") {
      return finite([event.agentDurationMs]);
    }
    return [];
  });
  const responsibility = rows.filter((event) => event.type === "responsibility_check" && typeof event.correct === "boolean");
  const duplicates = rows.filter((event) => event.type === "duplicate_send_check" && typeof event.duplicated === "boolean");
  const takeovers = rows.filter((event) => event.type === "takeover_reply_check" && typeof event.repliedAfterTakeover === "boolean");
  const completions = rows.filter((event) => event.type === "task_result" && typeof event.completed === "boolean");
  const setupDuration = percentile(setup.map((event) => event.durationMs), 0.5);
  const setupInputs = percentile(setup.map((event) => event.inputCount), 0.5);
  const detectionP95 = percentile(detections, 0.95);
  const acknowledgmentP95 = percentile(acknowledgments, 0.95);
  const instantP50 = percentile(instantReplies, 0.5);
  const responsibilityRate = rate(responsibility, (event) => event.correct);
  const duplicateRate = rate(duplicates, (event) => event.duplicated);
  const takeoverRate = rate(takeovers, (event) => event.repliedAfterTakeover);
  const completionRate = rate(completions, (event) => event.completed);
  const uniqueTasks = new Set(rows.map((event) => event.taskHash).filter((value) => /^[a-f0-9]{16,64}$/u.test(String(value))));
  return {
    schema: "foursday-experience-report/v1",
    sample: {
      eventCount: rows.length,
      taskCount: uniqueTasks.size,
      sufficient: uniqueTasks.size >= 30,
    },
    metrics: {
      setupDurationP50Ms: metric(setupDuration, setup.length, targets.setupDurationMs, setupDuration <= targets.setupDurationMs),
      setupInputP50: metric(setupInputs, setup.length, targets.setupInputCount, setupInputs <= targets.setupInputCount),
      detectionP95Ms: metric(detectionP95, detections.length, targets.detectionP95Ms, detectionP95 <= targets.detectionP95Ms),
      acknowledgmentP95Ms: metric(acknowledgmentP95, acknowledgments.length, targets.acknowledgmentP95Ms, acknowledgmentP95 <= targets.acknowledgmentP95Ms),
      instantReplyP50Ms: metric(instantP50, instantReplies.length, targets.instantReplyP50Ms, instantP50 <= targets.instantReplyP50Ms),
      responsibilityAccuracy: metric(responsibilityRate, responsibility.length, targets.responsibilityAccuracy, responsibilityRate >= targets.responsibilityAccuracy),
      duplicateSendRate: metric(duplicateRate, duplicates.length, targets.duplicateSendRate, duplicateRate === targets.duplicateSendRate),
      takeoverReplyRate: metric(takeoverRate, takeovers.length, targets.takeoverReplyRate, takeoverRate === targets.takeoverReplyRate),
      taskCompletionRate: metric(completionRate, completions.length, targets.taskCompletionRate, completionRate >= targets.taskCompletionRate),
    },
  };
}

export { targets as foursdayExperienceTargets };
