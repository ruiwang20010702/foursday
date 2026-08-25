import { createHash } from "node:crypto";

const fullSha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evaluateHermesShadowAcceptance({
  releaseSha,
  events,
  restartEvidence,
  codeWorkEvidence,
  now = new Date(),
}) {
  if (!fullSha.test(String(releaseSha ?? ""))) {
    throw new Error("Foursday shadow acceptance requires an exact release SHA");
  }
  if (!Array.isArray(events) || events.length > 100_000) {
    throw new Error("Foursday shadow events must be a bounded array");
  }
  const scopedEvents = events.filter((event) => event?.releaseSha === releaseSha);
  const inbound = scopedEvents.filter((event) => event?.type === "inbound");
  const replies = scopedEvents.filter((event) => event?.type === "reply_attempt");
  const interventions = scopedEvents.filter((event) => [
    "communication_takeover",
    "task_correction",
    "task_takeover",
    "resume_requested",
    "unrelated_owner_message",
  ].includes(event?.type));
  const messageHashes = inbound.flatMap((event) =>
    Array.isArray(event.messageHashes) ? event.messageHashes : []
  );
  const replyKeys = replies.map((event) => [
    String(event.conversationHash ?? ""),
    String(event.replyToHash ?? ""),
    String(event.deliveryContextHash ?? ""),
    String(event.contentHash ?? ""),
  ].join(":"));
  const conversationCounts = new Map();
  for (const event of inbound) {
    const key = String(event.conversationHash ?? "");
    if (key) conversationCounts.set(key, (conversationCounts.get(key) ?? 0) + 1);
  }
  const inboundConversations = new Set(inbound.map(
    (event) => String(event.conversationHash ?? ""),
  ).filter(Boolean));
  const scenarios = {
    allowlistedMessage: inbound.length > 0,
    projectRoute: inbound.some((event) =>
      ["matched", "bound"].includes(event.routeStatus) && Boolean(event.projectId)
    ),
    personalMemory: inbound.some((event) => event.memoryStatus === "available"),
    naturalReply: replies.some((event) =>
      inboundConversations.has(String(event.conversationHash ?? "")) &&
      Number(event.contentBytes) > 0 &&
      digest.test(String(event.contentHash ?? ""))
    ),
    followup: [...conversationCounts.values()].some((count) => count >= 2),
    codeWork: Boolean(
      codeWorkEvidence?.passed === true &&
      digest.test(String(codeWorkEvidence?.evidenceDigest ?? "")) &&
      codeWorkEvidence?.releaseSha === releaseSha
    ),
    ownerIntervention: interventions.some((event) =>
      Boolean(event.conversationHash) && Boolean(event.participantHash)
    ),
    restartRecovery: Boolean(
      restartEvidence?.passed === true &&
      digest.test(String(restartEvidence?.evidenceDigest ?? "")) &&
      restartEvidence?.releaseSha === releaseSha
    ),
    sendDisabled: replies.length > 0 && replies.every((event) =>
      event.mode === "shadow" &&
      event.bridgeSuccess === false &&
      event.outcomeUnknown === false
    ),
    noDuplicate:
      messageHashes.length > 0 &&
      new Set(messageHashes).size === messageHashes.length &&
      new Set(replyKeys).size === replyKeys.length,
  };
  const missing = Object.entries(scenarios)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const summary = {
    releaseSha,
    ignoredEventCount: events.length - scopedEvents.length,
    counts: {
      inbound: inbound.length,
      replyAttempts: replies.length,
      conversations: inboundConversations.size,
      ownerInterventions: interventions.length,
      uniqueMessages: new Set(messageHashes).size,
    },
    scenarios,
    restartEvidenceDigest: restartEvidence?.evidenceDigest ?? null,
    codeWorkEvidenceDigest: codeWorkEvidence?.evidenceDigest ?? null,
  };
  const evidenceDigest = sha256(sortedJson(summary));
  return {
    valid: missing.length === 0,
    missing,
    summary,
    receipt: missing.length === 0
      ? {
          schema: "foursday-shadow-acceptance/v1",
          releaseSha,
          evidenceDigest,
          createdAt: now.toISOString(),
          scenarios,
        }
      : null,
  };
}
