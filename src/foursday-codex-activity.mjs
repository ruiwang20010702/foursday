import { createHash } from "node:crypto";
import { basename } from "node:path";

const activityKinds = new Set([
  "analyze", "read", "search", "tool", "edit", "test", "verify", "complete", "failed",
]);
const secretMaterial = /(?:password|secret|token|authorization|private[ _-]?key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{10,}|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)?:\/\/\S+|\bfctx_[a-f0-9]{64}\b/iu;

function boundedText(value, maximum = 140) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, maximum);
  return secretMaterial.test(text) ? "" : text;
}

function fileNames(value) {
  const matches = String(value ?? "").match(/[\w./~\u3400-\u9fff -]+\.(?:md|txt|jsonl?|ya?ml|js|mjs|ts|tsx|jsx|py|sh|command|css|html|toml|sql)\b/giu) ?? [];
  return [...new Set(matches.map((item) => boundedText(basename(item.trim()), 72)).filter(Boolean))]
    .slice(0, 3);
}

function commandActivity(command) {
  const text = String(command ?? "");
  const lower = text.toLowerCase();
  const names = fileNames(text);
  const detail = names.length ? names.join("、") : "项目工作区";
  if (/apply_patch|\*\*\* begin patch/iu.test(lower)) {
    return { kind: "edit", summary: "正在修改项目文件", detail };
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|check|build))\b|\bnode\s+--test\b|\bpytest\b|\bunittest\b/iu.test(lower)) {
    return { kind: "test", summary: "正在运行自动测试", detail };
  }
  if (/\btsc\b|\bcompileall\b|node\s+--check/iu.test(lower)) {
    return { kind: "verify", summary: "正在验证代码有效性", detail };
  }
  if (/\bgit\s+(?:diff|status|log|show)\b/iu.test(lower)) {
    return { kind: "verify", summary: "正在检查项目差异", detail: "Git只读检查" };
  }
  if (/\b(?:rg|grep|find)\b/iu.test(lower)) {
    return { kind: "search", summary: "正在搜索项目内容", detail };
  }
  if (/\b(?:cat|sed|head|tail|ls|wc)\b/iu.test(lower)) {
    return { kind: "read", summary: "正在读取项目文件", detail };
  }
  return { kind: "tool", summary: "正在执行项目工具", detail: "本地受控命令" };
}

function eventIdentity(message, activity) {
  const params = message?.params ?? {};
  const item = params.item ?? {};
  return createHash("sha256").update(JSON.stringify([
    message?.method ?? "",
    params.threadId ?? "",
    params.turn?.id ?? params.turnId ?? "",
    item.id ?? item.itemId ?? "",
    item.type ?? "",
    activity.kind,
    activity.summary,
  ])).digest("hex");
}

export function activityForCodexNotification(message, now = new Date()) {
  const method = String(message?.method ?? "");
  const params = message?.params ?? {};
  const item = params.item ?? {};
  const itemType = String(item.type ?? "");
  let activity = null;
  if (method === "turn/started") {
    activity = { kind: "analyze", summary: "正在分析任务", detail: "Codex已开始本轮工作" };
  } else if (method === "turn/completed") {
    const status = String(params.turn?.status ?? "");
    activity = status === "completed"
      ? { kind: "complete", summary: "本轮工作已完成", detail: "等待任务证据与交付回读" }
      : { kind: "failed", summary: "本轮工作未正常完成", detail: "可在工作现场查看任务状态" };
  } else if (["item/started", "item/completed"].includes(method)) {
    if (itemType === "reasoning") {
      activity = { kind: "analyze", summary: "正在分析下一步", detail: "基于当前任务上下文" };
    } else if (itemType === "commandExecution") {
      activity = commandActivity(item.command);
    } else if (itemType === "fileChange") {
      const names = [...new Set((item.changes ?? []).flatMap((change) =>
        fileNames(change?.path ?? change?.file ?? change)))].slice(0, 3);
      activity = {
        kind: "edit",
        summary: "正在修改项目文件",
        detail: names.length ? names.join("、") : "工作区内文件",
      };
    } else if (["mcpToolCall", "dynamicToolCall"].includes(itemType)) {
      activity = { kind: "tool", summary: "正在调用项目工具", detail: "受控工具调用" };
    } else if (itemType === "webSearch") {
      activity = { kind: "search", summary: "正在检索公开资料", detail: "Codex受控Web搜索" };
    }
  }
  if (!activity || !activityKinds.has(activity.kind)) return null;
  const occurredAt = now instanceof Date && Number.isFinite(now.getTime())
    ? now.toISOString()
    : new Date().toISOString();
  const normalized = {
    kind: activity.kind,
    summary: boundedText(activity.summary, 140),
    detail: boundedText(activity.detail, 160),
    occurredAt,
  };
  if (!normalized.summary) return null;
  return { ...normalized, eventId: eventIdentity(message, normalized) };
}

export const foursdayActivityKinds = Object.freeze([...activityKinds]);
