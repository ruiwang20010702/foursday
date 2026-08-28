import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { adapterContractVersion, assertNormalizedMessage } from "./adapter-contracts.mjs";
import { safeCodexEnvironment } from "./codex-environment.mjs";
import { withDwsCommandLock } from "./dws-command-lock.mjs";

const execFileAsync = promisify(execFile);

function localTimestamp(date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function isoWithOffset(date) {
  return `${localTimestamp(date).replace(" ", "T")}+08:00`;
}

export function normalizeDwsIdentity(value) {
  const normalized = String(value ?? "").trim();
  return normalized === "" ? null : normalized;
}

export function extractDwsMediaDescriptors(raw) {
  const output = [];
  const seen = new Set();
  const queue = [{ value: raw, depth: 0, trustedResource: false }];
  while (queue.length > 0 && output.length < 8) {
    const { value, depth, trustedResource } = queue.shift();
    if (depth > 5 || value == null) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 256 * 1024) {
        try { queue.push({ value: JSON.parse(trimmed), depth: depth + 1, trustedResource }); } catch {}
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) {
        queue.push({ value: item, depth: depth + 1, trustedResource });
      }
      continue;
    }
    if (typeof value !== "object") continue;
    const mediaId = normalizeDwsIdentity(value.mediaId ?? value.media_id);
    const explicitType = String(
      value.resourceType ?? value.resource_type ?? value.type ??
      value.download?.arguments?.type ?? "",
    ).trim();
    const resourceType = mediaId
      ? "mediaId"
      : trustedResource && ["mediaId", "fileId"].includes(explicitType)
        ? explicitType
        : null;
    const resourceId = mediaId ?? (
      resourceType ? normalizeDwsIdentity(value.resourceId ?? value.resource_id) : null
    );
    const key = resourceId && resourceType ? `${resourceType}\0${resourceId}` : null;
    if (resourceId && resourceId.length <= 500 && key && !seen.has(key)) {
      seen.add(key);
      const candidateMimeType = String(
        value.mimeType ?? value.contentType ??
        (String(value.type ?? "").includes("/") ? value.type : ""),
      ).trim().slice(0, 120) || null;
      output.push({
        resourceId,
        resourceType,
        name: String(value.fileName ?? value.filename ?? value.name ?? "").trim().slice(0, 255) || null,
        mimeType: candidateMimeType,
      });
    }
    for (const [keyName, child] of Object.entries(value).slice(0, 100)) {
      queue.push({
        value: child,
        depth: depth + 1,
        trustedResource: trustedResource || keyName === "resourceRefs",
      });
    }
  }
  return output;
}

const dwsStructuredResourceHint = /^\[(?:文件|图片|视频|语音)\][\s\S]{0,1000}\b(?:fileId|mediaId)\s*:/iu;

export function mergeDwsMessageResourceDetails(messages, payload) {
  const result = payload?.result ?? payload ?? {};
  const failures = result.failures ?? payload?.failures ?? [];
  const complete = result.complete ?? payload?.complete ?? true;
  if (complete !== true || (Array.isArray(failures) && failures.length > 0)) {
    const error = new Error("DWS message resource enrichment was incomplete");
    error.code = "dws_resource_enrichment_incomplete";
    throw error;
  }
  const details = Array.isArray(result.messages)
    ? result.messages
    : Array.isArray(payload?.messages)
      ? payload.messages
      : [];
  const detailById = new Map(details.map((detail) => [
    String(detail?.openMessageId ?? detail?.messageId ?? detail?.id ?? ""),
    extractDwsMediaDescriptors(detail),
  ]).filter(([id]) => id));
  return messages.map((message) => {
    const combined = [...(message.media ?? []), ...(detailById.get(String(message.id)) ?? [])];
    const seen = new Set();
    return {
      ...message,
      media: combined.filter((item) => {
        const key = `${item.resourceType ?? "mediaId"}\0${item.resourceId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  });
}

export function collectMessages(payload, senderUserId) {
  const result = payload?.result ?? payload ?? {};
  const conversations =
    result.conversationMessagesList ?? payload?.conversationMessagesList ?? [];
  const nested = conversations.flatMap((conversation) =>
    (conversation.messages ?? []).map((message) => ({
      ...message,
      singleChat: conversation.singleChat,
      conversationTitle: conversation.title,
      openConversationId:
        message.openConversationId ?? conversation.openConversationId,
    })),
  );
  const direct = Array.isArray(result) ? result : result.messages ?? [];
  return [...nested, ...direct]
    .map((message) => {
      const payloadSenderUserId = normalizeDwsIdentity(
        message.senderUserId ??
        message.sender?.userId ??
        message.sender?.staffId,
      );
      const openDingTalkId = normalizeDwsIdentity(
        message.senderOpenDingTalkId ?? message.sender?.openDingTalkId,
      );
      return {
        id: message.openMessageId ?? message.messageId ?? message.id,
        senderUserId: payloadSenderUserId ??
          normalizeDwsIdentity(senderUserId) ?? openDingTalkId,
        senderOpenDingTalkId: openDingTalkId,
        senderIdentitySource: payloadSenderUserId
          ? "payload_user_id"
          : normalizeDwsIdentity(senderUserId)
            ? "query_fallback"
            : openDingTalkId
              ? "payload_open_id"
              : "missing",
        senderName:
          typeof message.sender === "string"
            ? message.sender
            : message.senderName ?? message.sender?.name,
        conversationId:
          message.openConversationId ??
          message.conversationId ??
          message.openCid,
        singleChat: message.singleChat,
        createTime:
          message.createTime ?? message.createdAt ?? message.sendTime ?? "",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content?.text ?? JSON.stringify(message.content ?? ""),
        isSelf:
          message.isSelf === true ||
          message.direction === "outgoing" ||
          message.sendType === "send",
        isWithdrawn:
          message.isWithdrawn === true ||
          message.recalled === true ||
          message.revoked === true ||
          /^(?:RECALLED|REVOKED|WITHDRAWN)$/iu.test(String(message.status ?? "")),
        withdrawnAt:
          message.withdrawnAt ?? message.recalledAt ?? message.revokedAt ?? null,
        media: extractDwsMediaDescriptors(message),
        raw: message,
      };
    })
    .filter((message) => message.id && message.conversationId);
}

export function bindMessagesToSender(
  messages,
  senderUserId,
  expectedOpenDingTalkId = null,
) {
  const expectedSenderUserId = normalizeDwsIdentity(senderUserId);
  const expectedOpenId = normalizeDwsIdentity(expectedOpenDingTalkId);
  if (!expectedSenderUserId) {
    const error = new Error("DWS list-by-sender requires a sender identity");
    error.code = "dws_sender_identity_required";
    throw error;
  }
  return messages.map((message) => {
    const actualSender = message.senderIdentitySource === "query_fallback"
      ? null
      : normalizeDwsIdentity(message.senderUserId);
    const actualOpenId = normalizeDwsIdentity(message.senderOpenDingTalkId);
    if (
      actualSender !== expectedSenderUserId &&
      (!expectedOpenId || actualOpenId !== expectedOpenId)
    ) {
      const error = new Error(
        "DWS list-by-sender returned a message for a different sender",
      );
      error.code = "dws_sender_identity_mismatch";
      throw error;
    }
    return { ...message, senderUserId: expectedSenderUserId };
  });
}

export function normalizeDwsMessage(message, { mentionedSelf = false } = {}) {
  const chatType = message.singleChat === false ? "group" : "direct";
  const occurredAt = new Date(message.createTime).toISOString();
  const normalized = {
    id: String(message.id ?? ""),
    senderId: normalizeDwsIdentity(message.senderUserId) ?? "",
    conversationId: String(message.conversationId ?? ""),
    content: String(message.content ?? ""),
    occurredAt,
    chatType,
    mentionedSelf: chatType === "group" ? mentionedSelf : undefined,
    isSelf: message.isSelf === true,
    platform: "dingtalk",
    raw: message.raw,
  };
  assertNormalizedMessage(normalized);
  return {
    ...message,
    ...normalized,
    senderUserId: normalized.senderId,
    createTime: normalized.occurredAt,
    singleChat: normalized.chatType === "direct",
  };
}

export function assertSuccessfulSendReceipt(receipt) {
  const values = [];
  const addKnownReceiptFields = (value) => {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of ["sendStatus", "send_status", "status", "success"]) {
      if (Object.hasOwn(value, key)) values.push({ key, value: value[key] });
    }
  };
  addKnownReceiptFields(receipt);
  if (Array.isArray(receipt?.result)) {
    for (const item of receipt.result) addKnownReceiptFields(item);
  } else {
    addKnownReceiptFields(receipt?.result);
  }

  const explicitFailure = values.some(({ key, value }) => (
    (key === "success" && value !== true) ||
    (key !== "success" && /^(?:FAIL|FAILED|ERROR|REJECTED|CANCELLED)$/iu.test(String(value)))
  ));
  const explicitSuccess = values.some(({ key, value }) => (
    (key === "success" && value === true) ||
    (key !== "success" && /^(?:SUCCESS|SENT|DELIVERED)$/iu.test(String(value)))
  ));
  if (explicitFailure || !explicitSuccess) {
    const error = new Error("DWS send did not return an explicit success receipt");
    error.code = explicitFailure ? "dws_send_failed" : "dws_send_receipt_unknown";
    throw error;
  }
  return receipt;
}

function pagination(payload) {
  const result = payload?.result ?? payload ?? {};
  const nextCursor =
    result.nextCursor ?? result.next_cursor ?? payload?.nextCursor ?? null;
  const hasMore =
    result.hasMore ?? result.has_more ?? payload?.hasMore ?? nextCursor != null;
  return {
    hasMore: Boolean(hasMore) && String(nextCursor ?? "") !== "",
    nextCursor: nextCursor == null ? null : String(nextCursor),
  };
}

function epoch(value) {
  if (typeof value === "number") {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== "") {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizedReactionAction(value) {
  const action = String(value ?? "").trim().toLowerCase();
  if (["add", "added", "reply", "create", "created"].includes(action)) return "added";
  if (["remove", "removed", "recall", "recalled", "delete", "deleted"].includes(action)) {
    return "removed";
  }
  return null;
}

export function normalizeDwsReactionEvent(value) {
  const event = value && !Array.isArray(value) && typeof value === "object" ? value : {};
  const data = event.data && !Array.isArray(event.data) && typeof event.data === "object"
    ? event.data
    : {};
  const read = (...names) => {
    for (const name of names) {
      const candidate = event[name] ?? data[name];
      if (candidate != null && String(candidate).trim() !== "") return candidate;
    }
    return null;
  };
  const type = String(read("event_type", "type") ?? "").trim();
  if (!/^user_im_message_reaction_(?:o2o|group)$/u.test(type)) return null;
  const eventId = String(read("event_id", "eventId") ?? "").trim();
  const conversationId = String(read("conversation_id", "conversationId") ?? "").trim();
  const messageId = String(read("message_id", "messageId") ?? "").trim();
  const operatorOpenDingTalkId = normalizeDwsIdentity(
    read("operator_open_dingtalk_id", "operatorOpenDingTalkId"),
  );
  const senderOpenDingTalkId = normalizeDwsIdentity(
    read("sender_open_dingtalk_id", "senderOpenDingTalkId"),
  );
  const reactionName = String(read("reaction_name", "reactionName", "reaction_text") ?? "")
    .trim().slice(0, 100);
  const action = normalizedReactionAction(read("operation_type", "operationType"));
  const occurredAtMs = epoch(
    read("operation_time", "operationTime", "event_time", "eventTime", "timestamp"),
  );
  if (
    !eventId || eventId.length > 500 ||
    !conversationId || conversationId.length > 500 ||
    !messageId || messageId.length > 500 ||
    !operatorOpenDingTalkId || operatorOpenDingTalkId.length > 500 ||
    !reactionName || !action || occurredAtMs == null
  ) return null;
  return {
    eventId,
    type,
    conversationId,
    messageId,
    operatorOpenDingTalkId,
    senderOpenDingTalkId,
    reactionName,
    action,
    occurredAt: new Date(occurredAtMs).toISOString(),
  };
}

function normalizedText(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
}

export function dwsMessageContentDigest(value) {
  return createHash("sha256").update(normalizedText(value)).digest("hex");
}

function canonicalDwsMessageContent(value, { normalizeOrderedLists = false } = {}) {
  let canonical = String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .normalize("NFKC")
    .replaceAll(
      /\[([^\]\n]{1,500})\]\(((?:file:\/\/)?(?:\/|~\/)[^)\n]+)\)/gu,
      (_match, label, destination) => {
        const line = String(destination).match(/:(\d+)(?::\d+)?$/u);
        return `[${label}](${line ? `:${line[1]}` : ""})`;
      },
    );
  if (normalizeOrderedLists) {
    canonical = canonical
      .replaceAll(
        /(^|\n)[ \t]*\d+\.[ \t]+/gu,
        (_match, prefix) => `${prefix}1. `,
      )
      .replaceAll(
        /([。！？；：])\d+\.(?=\s|\p{Script=Han})/gu,
        (_match, prefix) => `${prefix}1.`,
      );
  }
  return canonical
    .replaceAll(/[`*_~]/gu, "")
    .replaceAll(/\s+/gu, "");
}

export function dwsMessageUsesOrderedList(value) {
  return [...String(value ?? "").replace(/\r\n?/gu, "\n").matchAll(
    /(?:^|\n)[ \t]*\d+\.[ \t]+/gu,
  )].length >= 2;
}

export function dwsMessageContentFingerprint(value) {
  const canonical = canonicalDwsMessageContent(value);
  return createHash("sha256").update(canonical).digest("hex");
}

export function dwsMessageContentRenderFingerprint(value) {
  const canonical = canonicalDwsMessageContent(value, { normalizeOrderedLists: true });
  return createHash("sha256").update(canonical).digest("hex");
}

function explicitAiMarker(raw) {
  const values = [
    raw?.aiTag,
    raw?.ai_tag,
    raw?.isAiGenerated,
    raw?.aiGenerated,
    raw?.generatedByAi,
  ];
  return values.some((value) =>
    value === true || value === 1 || String(value).toLowerCase() === "true",
  );
}

function evidenceMarkerValues(evidence) {
  const values = new Set([evidence.taskId, evidence.idempotencyKey]);
  const visit = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        /(?:message|msg|task|query|process|uuid|idempotency).*(?:id|key)|^(?:openTaskId|openMessageId|processQueryKey|uuid)$/iu.test(key)
      ) {
        values.add(child);
      }
      visit(child, depth + 1);
    }
  };
  visit(evidence.receipt);
  return values;
}

function rawMarkerValues(raw) {
  const values = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 3 || value == null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        typeof child === "string" &&
        /(?:message|msg|task|query|process|uuid|idempotency).*(?:id|key)|^(?:openTaskId|openMessageId|processQueryKey|uuid)$/iu.test(key)
      ) {
        values.add(child);
      }
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(raw);
  return values;
}

export function isAutomatedSelfMessage(message, evidence = []) {
  if (explicitAiMarker(message?.raw)) return true;
  const messageTime = epoch(message?.createTime);
  const messageMarkers = new Set([message?.id, ...rawMarkerValues(message?.raw)]);
  const messageText = normalizedText(message?.content);
  const messageContentDigest = messageText
    ? dwsMessageContentDigest(message?.content)
    : null;
  const messageContentFingerprint = messageText
    ? dwsMessageContentFingerprint(message?.content)
    : null;
  let messageContentRenderFingerprint = null;
  const renderedFingerprint = () => {
    if (messageContentRenderFingerprint == null && messageText) {
      messageContentRenderFingerprint = dwsMessageContentRenderFingerprint(message?.content);
    }
    return messageContentRenderFingerprint;
  };
  for (const item of evidence) {
    if (item.conversationId !== message?.conversationId) continue;
    const knownMarkers = evidenceMarkerValues(item);
    if ([...messageMarkers].some((value) => value && knownMarkers.has(value))) {
      return true;
    }
    const startedAt = epoch(item.startedAt);
    const contentDigest = String(item.contentDigest ?? "").trim();
    const contentFingerprint = String(item.contentFingerprint ?? "").trim();
    const contentRenderFingerprint = String(item.contentRenderFingerprint ?? "").trim();
    const fingerprintVersion = Number(item.fingerprintVersion ?? 1);
    const strictFingerprintMatches =
      /^[a-f0-9]{64}$/u.test(contentFingerprint) &&
      messageContentFingerprint === contentFingerprint;
    const renderFingerprintMatches = fingerprintVersion >= 2
      ? (
          item.orderedListFingerprint === true &&
          /^[a-f0-9]{64}$/u.test(contentRenderFingerprint) &&
          renderedFingerprint() === contentRenderFingerprint
        )
      : (
          /^[a-f0-9]{64}$/u.test(contentFingerprint) &&
          renderedFingerprint() === contentFingerprint
        );
    if (
      messageTime != null &&
      startedAt != null &&
      messageTime >= startedAt - 5_000 &&
      messageTime <= startedAt + 10 * 60 * 1_000 &&
      messageText !== "" &&
      (
        messageText === normalizedText(item.content) ||
        (/^[a-f0-9]{64}$/u.test(contentDigest) &&
          messageContentDigest === contentDigest) ||
        strictFingerprintMatches || renderFingerprintMatches
      )
    ) {
      return true;
    }
  }
  return false;
}

export class DwsAdapter {
  constructor({
    dwsPath,
    dwsMock = false,
    commandRunner = execFileAsync,
    processSpawner = spawn,
    environment = process.env,
  }) {
    this.id = "dingtalk-dws";
    this.platform = "dingtalk";
    this.deliveryMode = "pull";
    this.contractVersion = adapterContractVersion;
    this.dwsPath = dwsPath;
    this.dwsMock = dwsMock;
    this.commandRunner = commandRunner;
    this.processSpawner = processSpawner;
    this.environment = environment;
    this.commandLockPath = String(environment.DWS_PERSONAL_COMMAND_LOCK ?? "").trim() || null;
    this.userIdentityCache = new Map();
    this.openIdentityCache = new Map();
    this.commandQueue = Promise.resolve();
  }

  _createEventWake({
    args,
    onEvent,
    onDiagnostic = () => {},
    readyTimeoutMs = 30_000,
    normalizeEvent = (event) => event,
  } = {}) {
    if (typeof onEvent !== "function") {
      throw new Error("DWS personal event wake requires an event callback");
    }
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string" || !item)) {
      throw new Error("DWS personal event wake requires fixed arguments");
    }
    const child = this.processSpawner(this.dwsPath, [...args, "--format", "ndjson"], {
      env: safeCodexEnvironment(this.dwsPath, this.environment),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let ready = false;
    let stopping = false;
    let acceptReady;
    let rejectReady;
    const readyPromise = new Promise((accept, reject) => {
      acceptReady = accept;
      rejectReady = reject;
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error("DWS personal event wake did not become ready");
      error.code = "dws_event_ready_timeout";
      rejectReady(error);
      child.kill("SIGTERM");
    }, readyTimeoutMs);
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      if (/\[event\]\s+ready\b/u.test(line) && !settled) {
        settled = true;
        ready = true;
        clearTimeout(timeout);
        acceptReady({ ready: true });
      } else if (/\b(?:error|failed|timeout)\b/iu.test(line)) {
        onDiagnostic("dws_event_stderr");
      }
    });
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => {
      if (!ready) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || Array.isArray(event) || typeof event !== "object") return;
      const normalized = normalizeEvent(event);
      if (normalized) onEvent(normalized);
    });
    child.once("error", (failure) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        failure.code = failure.code ?? "dws_event_process_error";
        rejectReady(failure);
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        const error = new Error("DWS personal event wake exited before ready");
        error.code = "dws_event_unavailable";
        rejectReady(error);
      } else if (ready && !stopping) {
        ready = false;
        onDiagnostic(`dws_event_closed:${String(code ?? signal ?? "unknown")}`);
      }
    });
    return {
      ready: readyPromise,
      async stop() {
        stopping = true;
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          const error = new Error("DWS personal event wake stopped before ready");
          error.code = "dws_event_stopped";
          rejectReady(error);
        }
        if (child.exitCode != null || child.signalCode != null) return;
        const closed = new Promise((accept) => child.once("close", accept));
        child.kill("SIGTERM");
        await Promise.race([
          closed,
          new Promise((accept) => setTimeout(accept, 5_000)),
        ]);
      },
    };
  }

  createPersonalEventWake(options = {}) {
    return this._createEventWake({
      ...options,
      args: [
        "event", "+listen-im",
        "--kind", "all-direct",
        "--events", "message",
      ],
      normalizeEvent: (event) => {
        const data = event.data && !Array.isArray(event.data) && typeof event.data === "object"
          ? event.data
          : {};
        const eventId = String(
          event.event_id ?? event.eventId ?? event.message_id ?? event.messageId ??
          data.event_id ?? data.eventId ?? data.message_id ?? data.messageId ?? "",
        ).trim();
        if (!eventId || eventId.length > 500) return null;
        return {
          eventId,
          type: String(event.event_type ?? data.event_type ?? data.type ?? event.type ?? "message"),
        };
      },
    });
  }

  createReactionEventWake({
    chatType,
    participantOpenDingTalkId = null,
    conversationId = null,
    ...options
  } = {}) {
    const direct = chatType === "direct";
    const group = chatType === "group";
    const participant = normalizeDwsIdentity(participantOpenDingTalkId);
    const conversation = normalizeDwsIdentity(conversationId);
    if ((!direct && !group) || (direct && !participant) || (group && !conversation)) {
      throw new Error("DWS reaction event wake requires one exact conversation target");
    }
    return this._createEventWake({
      ...options,
      args: direct
        ? [
            "event", "+listen-im", "--kind", "sender",
            "--open-dingtalk-id", participant, "--events", "reaction",
          ]
        : [
            "event", "+listen-im", "--kind", "group",
            "--chat-id", conversation, "--events", "reaction",
          ],
      normalizeEvent: normalizeDwsReactionEvent,
    });
  }

  async run(args, options = {}) {
    const execute = async () => {
      const { env: ignoredEnvironment, ...commandOptions } = options;
      const { stdout } = await withDwsCommandLock(
        this.commandLockPath,
        () => this.commandRunner(
          this.dwsPath,
          [...args, ...(this.dwsMock ? ["--mock"] : []), "--format", "json"],
          {
            maxBuffer: 8 * 1024 * 1024,
            timeout: 60_000,
            ...commandOptions,
            env: safeCodexEnvironment(this.dwsPath, this.environment),
          },
        ),
        { timeoutMs: 65_000 },
      );
      return JSON.parse(stdout);
    };
    const request = this.commandQueue.catch(() => {}).then(execute);
    this.commandQueue = request.then(() => undefined, () => undefined);
    return request;
  }

  async downloadMedia({
    resourceId,
    resourceType = "mediaId",
    messageId = null,
    conversationId = null,
    outputDirectory,
  }) {
    if (!new Set(["mediaId", "fileId"]).has(resourceType)) {
      throw new Error("DWS media resourceType is invalid");
    }
    const required = resourceType === "mediaId"
      ? { resourceId, messageId, conversationId }
      : { resourceId };
    for (const [label, value] of Object.entries(required)) {
      if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error(`DWS media ${label} is invalid`);
      }
    }
    if (!isAbsolute(outputDirectory)) throw new Error("DWS media output directory must be absolute");
    const target = resolve(outputDirectory);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const metadata = await lstat(target);
    if (
      !metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0 || await realpath(target) !== target
    ) throw new Error("DWS media output directory is unsafe");
    const before = new Set(await readdir(target));
    const receipt = await this.run([
      "chat", "+messages-resource-download",
      "--type", resourceType,
      "--resource-id", resourceId,
      ...(resourceType === "mediaId" ? [
        "--message-id", messageId,
        "--open-conversation-id", conversationId,
      ] : []),
      "--output", ".",
    ], { cwd: target });
    const candidates = [];
    const visit = (value, depth = 0) => {
      if (depth > 5 || value == null) return;
      if (Array.isArray(value)) return value.slice(0, 50).forEach((item) => visit(item, depth + 1));
      if (typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string" && /(?:path|file)$/iu.test(key) && isAbsolute(child)) candidates.push(child);
        else visit(child, depth + 1);
      }
    };
    visit(receipt);
    const after = await readdir(target);
    for (const name of after) if (!before.has(name)) candidates.push(join(target, name));
    const valid = [];
    for (const candidate of [...new Set(candidates)]) {
      const canonical = await realpath(candidate).catch(() => null);
      if (!canonical || !(canonical === target || canonical.startsWith(`${target}${sep}`))) continue;
      const file = await lstat(canonical);
      if (file.isFile() && !file.isSymbolicLink() && file.size > 0 && file.size <= 128 * 1024 * 1024) {
        await chmod(canonical, 0o600);
        valid.push(canonical);
      }
    }
    if (valid.length !== 1) throw new Error("DWS media download did not produce one safe file");
    return { path: valid[0], receipt };
  }

  async fetchBySenderAll({ senderUserId, start, end, timeoutMs = 60_000 }) {
    const expectedSenderUserId = normalizeDwsIdentity(senderUserId);
    if (!expectedSenderUserId) {
      const error = new Error("DWS list-by-sender requires a sender identity");
      error.code = "dws_sender_identity_required";
      throw error;
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("DWS sender lookup timeout must be between 1 and 60 seconds");
    }
    const messages = [];
    let expectedOpenDingTalkId = this.userIdentityCache.get(
      expectedSenderUserId,
    ) ?? null;
    const seenCursors = new Set();
    let cursor = "0";

    for (let page = 0; page < 100; page += 1) {
      if (seenCursors.has(cursor)) {
        throw new Error(`DWS pagination cursor repeated: ${cursor}`);
      }
      seenCursors.add(cursor);
      const payload = await this.run([
        "chat",
        "message",
        "list-by-sender",
        "--sender-user-id",
        expectedSenderUserId,
        "--start",
        isoWithOffset(start),
        "--end",
        isoWithOffset(end),
        "--limit",
        "50",
        "--cursor",
        cursor,
      ], { timeout: timeoutMs });
      const pageMessages = collectMessages(payload);
      const messagesNeedingOpenIdentity = pageMessages.filter(
        (message) => message.senderIdentitySource !== "payload_user_id",
      );
      if (!expectedOpenDingTalkId && messagesNeedingOpenIdentity.length > 0) {
        const names = [...new Set(messagesNeedingOpenIdentity.map((message) =>
          String(message.senderName ?? "").trim()
        ).filter(Boolean))];
        if (names.length !== 1) {
          const error = new Error("DWS sender display name is ambiguous or unavailable");
          error.code = "dws_contact_identity_unavailable";
          throw error;
        }
        expectedOpenDingTalkId = await this.resolveUserOpenDingTalkId(
          expectedSenderUserId,
          names[0],
        );
      }
      messages.push(
        ...bindMessagesToSender(
          pageMessages,
          expectedSenderUserId,
          expectedOpenDingTalkId,
        ),
      );
      const pageInfo = pagination(payload);
      if (!pageInfo.hasMore) return this.enrichMessageResources(messages, { timeoutMs });
      cursor = pageInfo.nextCursor;
    }
    throw new Error("DWS pagination exceeded 100 pages");
  }

  async enrichMessageResources(messages, { timeoutMs = 60_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("DWS resource enrichment timeout must be between 1 and 60 seconds");
    }
    const ids = [...new Set(messages.filter((message) =>
      dwsStructuredResourceHint.test(String(message.content ?? ""))
    ).map((message) => String(message.id)))];
    let enriched = messages;
    for (let offset = 0; offset < ids.length; offset += 50) {
      const chunk = ids.slice(offset, offset + 50);
      let merged = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const payload = await this.run([
            "chat", "+messages-mget",
            "--msg-ids", chunk.join(","),
          ], { timeout: timeoutMs });
          merged = mergeDwsMessageResourceDetails(enriched, payload);
          break;
        } catch {
          if (attempt === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
      }
      if (!merged) {
        const pending = new Set(chunk);
        enriched = enriched.map((message) => pending.has(String(message.id))
          ? { ...message, resourceEnrichmentUnavailable: true }
          : message);
        continue;
      }
      enriched = merged;
    }
    return enriched;
  }

  async resolveUserOpenDingTalkId(expectedUserId, displayName = null, {
    allowPolicyFallback = true,
  } = {}) {
    const userId = normalizeDwsIdentity(expectedUserId);
    if (!userId) {
      const error = new Error("DWS contact identity requires a user ID");
      error.code = "dws_contact_identity_required";
      throw error;
    }
    if (this.userIdentityCache.has(userId)) {
      return this.userIdentityCache.get(userId);
    }
    let payload;
    try {
      payload = await this.run([
        "contact",
        "user",
        "get",
        "--ids",
        userId,
      ]);
    } catch (error) {
      const marker = `${String(error?.stdout ?? "")} ${String(error?.stderr ?? "")} ${String(error?.message ?? "")}`;
      if (
        !allowPolicyFallback &&
        /PAT_ORG_POLICY_DENIED|OPEN_SOURCE_ORG_SCOPE_FORBIDDEN/u.test(marker)
      ) {
        throw error;
      }
      const name = String(displayName ?? "").trim();
      if (!name) throw error;
      payload = await this.run([
        "aisearch",
        "person",
        "--keyword",
        name,
        "--dimension",
        "name",
      ]);
    }
    const candidates = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.items)
        ? payload.items
        : payload?.result && typeof payload.result === "object"
          ? [payload.result]
          : [];
    const exact = candidates.filter((candidate) =>
      normalizeDwsIdentity(
        candidate?.userId ?? candidate?.orgEmployeeModel?.userId,
      ) === userId
    );
    const openDingTalkId = normalizeDwsIdentity(
      exact[0]?.openDingTalkId ??
      exact[0]?.openDingtalkId ??
      exact[0]?.orgEmployeeModel?.openDingTalkId,
    );
    if (exact.length !== 1 || !openDingTalkId) {
      const error = new Error("DWS contact identity is ambiguous or unavailable");
      error.code = "dws_contact_identity_unavailable";
      throw error;
    }
    this.userIdentityCache.set(userId, openDingTalkId);
    this.openIdentityCache.set(openDingTalkId, userId);
    return openDingTalkId;
  }

  async resolveCurrentUserOpenDingTalkId(expectedUserId) {
    const expected = normalizeDwsIdentity(expectedUserId);
    if (!expected) {
      const error = new Error("DWS current identity requires a user ID");
      error.code = "dws_current_identity_required";
      throw error;
    }
    const payload = await this.run(["auth", "status"]);
    const result = payload?.result ?? payload ?? {};
    const currentUserId = normalizeDwsIdentity(result.user_id ?? result.userId);
    const currentUserName = String(result.user_name ?? result.userName ?? "").trim();
    if (
      result.success !== true || result.authenticated !== true ||
      currentUserId !== expected || !currentUserName
    ) {
      const error = new Error("DWS authenticated identity does not match the configured owner");
      error.code = "dws_current_identity_mismatch";
      throw error;
    }
    return this.resolveUserOpenDingTalkId(expected, currentUserName, {
      allowPolicyFallback: true,
    });
  }

  async resolveEnterpriseOpenDingTalkId(expectedOpenDingTalkId, displayName = null) {
    const openDingTalkId = normalizeDwsIdentity(expectedOpenDingTalkId);
    const name = String(displayName ?? "").trim();
    if (!openDingTalkId || !name) {
      const error = new Error("DWS enterprise OpenID identity requires an exact display name");
      error.code = "dws_enterprise_identity_required";
      throw error;
    }
    if (this.openIdentityCache.has(openDingTalkId)) {
      return {
        userId: this.openIdentityCache.get(openDingTalkId),
        openDingTalkId,
      };
    }
    const payload = await this.run([
      "aisearch",
      "person",
      "--query",
      name,
      "--dimension",
      "name",
    ]);
    const candidates = Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.items)
        ? payload.items
        : payload?.result && typeof payload.result === "object"
          ? [payload.result]
          : [];
    const exactByIdentity = new Map();
    for (const candidate of candidates) {
      const identity = {
        userId: normalizeDwsIdentity(
          candidate?.userId ?? candidate?.meta?.staffId ??
          candidate?.orgEmployeeModel?.userId,
        ),
        openDingTalkId: normalizeDwsIdentity(
          candidate?.openDingTalkId ?? candidate?.openDingtalkId ??
          candidate?.orgEmployeeModel?.openDingTalkId,
        ),
      };
      if (identity.userId && identity.openDingTalkId === openDingTalkId) {
        exactByIdentity.set(`${identity.userId}\0${identity.openDingTalkId}`, identity);
      }
    }
    const exact = [...exactByIdentity.values()];
    if (exact.length !== 1) {
      const error = new Error("DWS enterprise OpenID is not a unique current-organization identity");
      error.code = "dws_enterprise_identity_unavailable";
      throw error;
    }
    this.userIdentityCache.set(exact[0].userId, openDingTalkId);
    this.openIdentityCache.set(openDingTalkId, exact[0].userId);
    return exact[0];
  }

  async verifyEnterpriseUser(expectedUserId, displayName = null) {
    const userId = normalizeDwsIdentity(expectedUserId);
    if (!userId) {
      const error = new Error("DWS enterprise identity requires a user ID");
      error.code = "dws_enterprise_identity_required";
      throw error;
    }
    try {
      const openDingTalkId = await this.resolveUserOpenDingTalkId(userId, displayName, {
        allowPolicyFallback: false,
      });
      return { userId, openDingTalkId };
    } catch (error) {
      const marker = `${String(error?.stdout ?? "")} ${String(error?.stderr ?? "")}`;
      if (/PAT_ORG_POLICY_DENIED|OPEN_SOURCE_ORG_SCOPE_FORBIDDEN/u.test(marker)) {
        const unavailable = new Error("DWS sender is not a verified current-enterprise user");
        unavailable.code = "dws_enterprise_identity_unavailable";
        throw unavailable;
      }
      throw error;
    }
  }

  enterpriseIdentityFailure(error) {
    const marker = [
      error?.code,
      error?.name,
      error?.message,
      error?.stdout,
      error?.stderr,
    ].map((value) => String(value ?? "")).join(" ");
    if (/PAT_ORG_POLICY_DENIED|OPEN_SOURCE_ORG_SCOPE_FORBIDDEN/u.test(marker)) {
      return { errorCode: "dws_enterprise_identity_unavailable", retryable: false };
    }
    const errorCode = String(error?.code ?? error?.name ?? "dws_enterprise_identity_check_failed")
      .replaceAll(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) ||
      "dws_enterprise_identity_check_failed";
    const permanent = /(?:identity_(?:required|unavailable|mismatch)|auth|unauthorized|forbidden)/iu
      .test(`${errorCode} ${marker}`);
    return { errorCode, retryable: !permanent };
  }

  async verifyEnterpriseMessage(message) {
    const source = String(message?.senderIdentitySource ?? "");
    const suppliedUserId = normalizeDwsIdentity(message?.senderUserId);
    const suppliedOpenDingTalkId = normalizeDwsIdentity(message?.senderOpenDingTalkId);
    const displayName = String(message?.senderName ?? "").trim() || null;
    if (
      suppliedOpenDingTalkId &&
      (source === "payload_open_id" || !suppliedUserId || suppliedUserId === suppliedOpenDingTalkId)
    ) {
      return this.resolveEnterpriseOpenDingTalkId(suppliedOpenDingTalkId, displayName);
    }
    const identity = await this.verifyEnterpriseUser(suppliedUserId, displayName);
    if (
      suppliedOpenDingTalkId &&
      identity.openDingTalkId !== suppliedOpenDingTalkId
    ) {
      const error = new Error("DWS enterprise userId and OpenID identify different users");
      error.code = "dws_enterprise_identity_mismatch";
      throw error;
    }
    return identity;
  }

  async fetchEnterpriseDirectScan({ start, end, selfUserId = null, timeoutMs = 60_000 } = {}) {
    if (!(start instanceof Date) || !Number.isFinite(start.getTime()) ||
        !(end instanceof Date) || !Number.isFinite(end.getTime()) || start >= end) {
      throw new Error("DWS enterprise message range is invalid");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("DWS enterprise message timeout is invalid");
    }
    if (end.getTime() - start.getTime() > 60 * 60 * 1_000) {
      throw new Error("DWS enterprise message range is too broad");
    }
    const ownerUserId = normalizeDwsIdentity(selfUserId);
    const payloads = [];
    const sliceMs = 2 * 60 * 1_000;
    for (let sliceStart = start.getTime(); sliceStart < end.getTime(); sliceStart += sliceMs) {
      const sliceEnd = Math.min(end.getTime(), sliceStart + sliceMs);
      const searchArgs = [
        "chat", "message", "search-advanced",
        "--start", isoWithOffset(new Date(sliceStart)),
        "--end", isoWithOffset(new Date(sliceEnd)),
        "--limit", "100",
        "--page-all",
        "--page-limit", "20",
        "--max-items", "500",
      ];
      let payload;
      let scanComplete = false;
      let incompleteReason = "not_complete";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          payload = await this.run(searchArgs, { timeout: timeoutMs });
        } catch (error) {
          const marker = `${String(error?.stdout ?? "")} ${String(error?.stderr ?? "")} ${String(error?.message ?? "")}`;
          if (/auth|ciphertext_key_mismatch|unauthorized|forbidden/iu.test(marker)) throw error;
          if (attempt === 0) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            continue;
          }
          const failed = new Error("DWS enterprise message read failed after one bounded retry");
          failed.code = /timeout|timed out|ETIMEDOUT/iu.test(marker)
            ? "dws_enterprise_scan_request_timeout"
            : "dws_enterprise_scan_command_failed";
          throw failed;
        }
        const result = payload?.result ?? payload ?? {};
        const failures = result.failures ?? payload?.failures ?? [];
        const hasMore = result.hasMore ?? payload?.hasMore;
        const complete = result.complete ?? payload?.complete ?? (hasMore === false);
        const truncated = [
          result.truncated, payload?.truncated,
          result.truncatedByPageLimit, payload?.truncatedByPageLimit,
          result.truncatedByResultLimit, payload?.truncatedByResultLimit,
        ].some((value) => value === true);
        scanComplete = complete === true && hasMore !== true && !truncated &&
          (!Array.isArray(failures) || failures.length === 0);
        incompleteReason = Array.isArray(failures) && failures.length > 0
          ? "failures"
          : truncated
            ? "truncated"
            : hasMore === true
              ? "has_more"
              : "not_complete";
        if (scanComplete) break;
        if (attempt === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      if (!scanComplete) {
        const error = new Error("DWS enterprise message slice was incomplete after one bounded retry");
        error.code = `dws_enterprise_scan_incomplete_${incompleteReason}`;
        throw error;
      }
      payloads.push(payload);
    }
    const seenMessageIds = new Set();
    const messages = payloads.flatMap((payload) => collectMessages(payload, null)).filter((message) => {
      if (
        message.singleChat !== true || message.isSelf === true ||
        (ownerUserId && message.senderUserId === ownerUserId) ||
        typeof message.id !== "string" || !message.id ||
        typeof message.senderUserId !== "string" || !message.senderUserId ||
        seenMessageIds.has(message.id)
      ) return false;
      seenMessageIds.add(message.id);
      return true;
    });
    const output = [];
    const pending = [];
    const rejected = [];
    for (const message of messages.slice(0, 500)) {
      try {
        const identity = await this.verifyEnterpriseMessage(message);
        if (ownerUserId && identity.userId === ownerUserId) continue;
        output.push({
          ...message,
          senderUserId: identity.userId,
          senderOpenDingTalkId: identity.openDingTalkId,
          senderIdentitySource: "enterprise_contact_verified",
          enterpriseVerified: true,
        });
      } catch (error) {
        const failure = this.enterpriseIdentityFailure(error);
        (failure.retryable ? pending : rejected).push({
          message,
          errorCode: failure.errorCode,
        });
      }
    }
    return {
      messages: await this.enrichMessageResources(output, { timeoutMs }),
      pending,
      rejected,
    };
  }

  async fetchEnterpriseDirect(input = {}) {
    return (await this.fetchEnterpriseDirectScan(input)).messages;
  }

  async retryEnterpriseDirectMessage(message, { timeoutMs = 60_000 } = {}) {
    const identity = await this.verifyEnterpriseMessage(message);
    const [verified] = await this.enrichMessageResources([{
      ...message,
      senderUserId: identity.userId,
      senderOpenDingTalkId: identity.openDingTalkId,
      senderIdentitySource: "enterprise_contact_verified",
      enterpriseVerified: true,
    }], { timeoutMs });
    return verified;
  }

  async setEmojiReaction({ action, conversationId, messageId, emoji }) {
    const operation = String(action ?? "").trim();
    const conversation = normalizeDwsIdentity(conversationId);
    const message = normalizeDwsIdentity(messageId);
    const reaction = String(emoji ?? "").trim();
    if (
      !["add", "remove"].includes(operation) ||
      !conversation || conversation.length > 500 ||
      !message || message.length > 500 ||
      !reaction || reaction.length > 100
    ) {
      throw new Error("DWS emoji reaction request is invalid");
    }
    const receipt = await this.run([
      "chat", "message", operation === "add" ? "add-emoji" : "remove-emoji",
      "--conversation-id", conversation,
      "--message-id", message,
      "--emoji", reaction,
    ], { timeout: 8_000 });
    const success = receipt?.success === true || receipt?.result?.success === true;
    if (!success) {
      const error = new Error("DWS emoji reaction did not return explicit success");
      error.code = `dws_reaction_${operation}_failed`;
      throw error;
    }
    return { success: true, receipt };
  }

  async addEmojiReaction(input) {
    return this.setEmojiReaction({ ...input, action: "add" });
  }

  async removeEmojiReaction(input) {
    return this.setEmojiReaction({ ...input, action: "remove" });
  }

  async fetchBySender({ senderUserId, start, end }) {
    return (await this.fetchBySenderAll({ senderUserId, start, end })).filter(
      (message) => message.singleChat !== false,
    );
  }

  async fetchGroupMentions({ groupIds, start, end }) {
    if (!Array.isArray(groupIds) || groupIds.length === 0) return [];
    const messages = [];
    const seenCursors = new Set();
    let cursor = "0";

    for (let page = 0; page < 100; page += 1) {
      if (seenCursors.has(cursor)) {
        throw new Error(`DWS pagination cursor repeated: ${cursor}`);
      }
      seenCursors.add(cursor);
      const payload = await this.run([
        "chat",
        "message",
        "search-advanced",
        "--at-me",
        "--conversation-ids",
        groupIds.join(","),
        "--start",
        isoWithOffset(start),
        "--end",
        isoWithOffset(end),
        "--limit",
        "50",
        "--cursor",
        cursor,
      ]);
      messages.push(
        ...collectMessages(payload, null).filter(
          (message) =>
            message.singleChat === false &&
            groupIds.includes(message.conversationId) &&
            !message.isSelf,
        ),
      );
      const pageInfo = pagination(payload);
      if (!pageInfo.hasMore) return this.enrichMessageResources(messages);
      cursor = pageInfo.nextCursor;
    }
    throw new Error("DWS pagination exceeded 100 pages");
  }

  async fetchDirect({
    userId,
    identityKind = null,
    before = new Date(),
    limit = 30,
    lookbackMs = 2 * 60 * 60 * 1_000,
    timeoutMs = 60_000,
  }) {
    const beforeTime = epoch(before);
    if (beforeTime == null) throw new Error("DWS direct context cutoff is invalid");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("DWS direct context limit must be between 1 and 50");
    }
    if (!Number.isSafeInteger(lookbackMs) || lookbackMs < 60_000 || lookbackMs > 24 * 60 * 60 * 1_000) {
      throw new Error("DWS direct context lookback must be between 1 minute and 24 hours");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new Error("DWS direct context timeout must be between 1 and 60 seconds");
    }
    if (identityKind != null && !["open_dingtalk_id", "user_id"].includes(identityKind)) {
      throw new Error("DWS direct context identity kind is invalid");
    }
    const identityFlag = identityKind === "open_dingtalk_id"
      ? "--open-dingtalk-id"
      : identityKind === "user_id"
        ? "--user"
        : /^DT[A-Za-z0-9]/.test(String(userId))
          ? "--open-dingtalk-id"
          : "--user";
    const queryLimit = Math.min(200, Math.max(limit, limit * 4));
    const payload = await this.run([
      "chat",
      "message",
      "list-direct",
      identityFlag,
      userId,
      "--time",
      localTimestamp(new Date(beforeTime - lookbackMs)),
      "--forward",
      "true",
      "--limit",
      String(queryLimit),
    ], { timeout: timeoutMs });
    const messages = collectMessages(payload, userId)
      .filter((message) => {
        const createdAt = epoch(message.createTime);
        return createdAt != null && createdAt <= beforeTime + 999;
      })
      .sort((a, b) => String(a.createTime).localeCompare(String(b.createTime)))
      .slice(-limit);
    return this.enrichMessageResources(messages, { timeoutMs });
  }

  async hasManualReply({
    conversationId,
    selfUserId,
    after,
    now = new Date(),
    automatedSendEvidence = [],
    timeoutMs = 60_000,
  }) {
    if (!selfUserId) {
      return {
        known: false,
        replied: false,
        reason: "DINGTALK_SELF_USER_ID is not configured",
      };
    }
    if (!conversationId) {
      return {
        known: false,
        replied: false,
        reason: "Conversation ID is not available",
      };
    }
    const afterTime = epoch(after);
    if (afterTime == null) {
      return {
        known: false,
        replied: false,
        reason: "Source message time is invalid",
      };
    }
    const messages = await this.fetchBySenderAll({
      senderUserId: selfUserId,
      start: new Date(afterTime),
      end: now,
      timeoutMs,
    });
    const replies = messages.filter((message) => {
      const messageTime = epoch(message.createTime);
      return (
        message.conversationId === conversationId &&
        messageTime != null &&
        messageTime > afterTime &&
        !isAutomatedSelfMessage(message, automatedSendEvidence)
      );
    });
    const latest = replies.sort((left, right) =>
      String(left.createTime).localeCompare(String(right.createTime))).at(-1);
    return latest
      ? {
          known: true,
          replied: true,
          message: {
            id: String(latest.id ?? "").slice(0, 500) || null,
            content: String(latest.content ?? "").slice(0, 20_000),
            createTime: String(latest.createTime ?? "") || null,
          },
        }
      : { known: true, replied: false, message: null };
  }

  async sendText({ userId, identityKind = null, text, idempotencyKey }) {
    if (identityKind != null && !["open_dingtalk_id", "user_id"].includes(identityKind)) {
      throw new Error("DWS send identity kind is invalid");
    }
    const identityFlag = identityKind === "open_dingtalk_id"
      ? "--open-dingtalk-id"
      : identityKind === "user_id"
        ? "--user"
        : /^DT[A-Za-z0-9]/.test(String(userId))
          ? "--open-dingtalk-id"
          : "--user";
    return this.run([
      "chat",
      "message",
      "send",
      identityFlag,
      userId,
      "--title",
      "Foursday 回复",
      "--text",
      text,
      "--uuid",
      idempotencyKey,
      "--ai-tag",
      "-y",
    ]);
  }

  async sendGroupText({ groupId, text, idempotencyKey }) {
    return this.run([
      "chat",
      "message",
      "send",
      "--group",
      groupId,
      "--title",
      "Foursday 回复",
      "--text",
      text,
      "--uuid",
      idempotencyKey,
      "--ai-tag",
      "-y",
    ]);
  }

  async listMessages({ scope, start, end }) {
    if (scope?.type === "direct") {
      return (await this.fetchBySender({
        senderUserId: scope.participantId,
        start,
        end,
      })).map((message) => normalizeDwsMessage(message));
    }
    if (scope?.type === "group") {
      return (await this.fetchGroupMentions({
        groupIds: [scope.conversationId],
        start,
        end,
      })).map((message) => normalizeDwsMessage(message, { mentionedSelf: true }));
    }
    throw new Error("DWS message scope must be direct or group");
  }

  async getConversation({ participantId, before, limit, lookbackMs }) {
    return (await this.fetchDirect({
      userId: participantId,
      before,
      limit,
      lookbackMs,
    })).map((message) => normalizeDwsMessage(message));
  }

  async findManualReply({
    conversationId,
    selfIdentityId,
    after,
    now,
    automatedSendEvidence,
    timeoutMs,
  }) {
    return this.hasManualReply({
      conversationId,
      selfUserId: selfIdentityId,
      after,
      now,
      automatedSendEvidence,
      timeoutMs,
    });
  }

  async sendMessage({
    conversationId,
    recipientId,
    recipientKind = null,
    chatType,
    text,
    idempotencyKey,
  }) {
    if (chatType === "group") {
      return this.sendGroupText({
        groupId: conversationId,
        text,
        idempotencyKey,
      });
    }
    if (chatType !== "direct") {
      throw new Error("DWS send chatType must be direct or group");
    }
    return this.sendText({
      userId: recipientId,
      identityKind: recipientKind,
      text,
      idempotencyKey,
    });
  }

  verifySendReceipt(receipt) {
    return assertSuccessfulSendReceipt(receipt);
  }
}
