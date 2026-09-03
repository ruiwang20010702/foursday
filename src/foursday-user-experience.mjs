const unhealthyCheckpointStates = new Set(["failed", "error", "blocked", "unknown_send"]);
const backgroundStates = new Set(["ack_pending", "acknowledged", "queued", "running", "blocked"]);

function counts(tasks) {
  return tasks.reduce((value, task) => {
    const group = task.worksiteGroup ?? "recent";
    value[group] = (value[group] ?? 0) + 1;
    return value;
  }, { needs_me: 0, working: 0, recent: 0 });
}

function authenticationFailure(gateway) {
  const codes = [
    gateway.manualReplyProbeErrorCode,
    gateway.reactionWakeLastErrorCode,
    gateway.enterpriseIdentityLastErrorCode,
  ].filter(Boolean).join(" ");
  return /(?:auth|login|credential|unauthorized)/iu.test(codes);
}

export function userFacingRuntimeState({ gateway = {}, control = {}, ready = false, tasks = [] } = {}) {
  const responsibility = counts(tasks);
  let state = "needs_attention";
  let title = "需要检查";
  let detail = "部分工作能力暂不可用";
  let recommendation = { code: "open_codex", label: "在 Codex 中检查 Foursday 状态" };

  if (gateway.installed !== true) {
    state = "not_setup";
    title = "尚未完成上岗";
    detail = "完成向导后即可开始试用";
    recommendation = { code: "run_setup", label: "开始十分钟上岗向导" };
  } else if (control.state === "paused") {
    state = "paused";
    title = "已暂停";
    detail = "现有任务和自动回复已暂停";
    recommendation = { code: "resume_in_codex", label: "在 Codex 中决定是否恢复" };
  } else if (gateway.sendBlocked === true || gateway.modeConsistent === false) {
    state = "send_paused";
    title = "自动回复已暂停";
    detail = "系统无法确认一次发送结果，已停止后续回复";
    recommendation = { code: "check_dingtalk", label: "检查钉钉中的实际发送结果" };
  } else if (gateway.running !== true) {
    state = "stopped";
    title = "尚未运行";
    detail = "当前不会接收或处理新任务";
    recommendation = { code: "start_in_codex", label: "在 Codex 中启动 Foursday" };
  } else if (authenticationFailure(gateway)) {
    state = "login_required";
    title = "钉钉需要重新登录";
    detail = "登录恢复前，新消息可能无法进入 Foursday";
    recommendation = { code: "login_dingtalk", label: "打开钉钉登录" };
  } else if (unhealthyCheckpointStates.has(gateway.checkpointState)) {
    state = "sync_failed";
    title = "消息同步异常";
    detail = "新消息可能暂时无法进入 Foursday";
    recommendation = { code: "repair_sync", label: "让 AI 检查并修复消息同步" };
  } else if (gateway.checkpointBusy === true) {
    state = "syncing";
    title = "正在同步新消息";
    detail = "已有任务可以继续，Foursday 正在补齐新消息";
    recommendation = { code: "wait", label: "无需操作，等待同步完成" };
  } else if (gateway.mode === "shadow") {
    state = "trial";
    title = "试用中，不会自动回复";
    detail = "可以验证理解和工作结果，真实发送保持关闭";
    recommendation = { code: "run_trial", label: "先完成一项本人只读试用任务" };
  } else if (ready === true && gateway.sendEnabled === true) {
    state = "working";
    title = "已上岗";
    detail = responsibility.needs_me > 0
      ? `有 ${responsibility.needs_me} 项工作需要你`
      : responsibility.working > 0 ? `AI 正在负责 ${responsibility.working} 项工作` : "当前没有待处理工作";
    recommendation = responsibility.needs_me > 0
      ? { code: "review_needs_me", label: "查看需要你的任务" }
      : { code: "none", label: "无需操作" };
  }
  return {
    state,
    title,
    detail,
    responsibility: {
      needsYou: responsibility.needs_me,
      aiOwned: responsibility.working,
      recentlyCompleted: responsibility.recent,
      owner: responsibility.needs_me > 0 ? "you" : responsibility.working > 0 ? "ai" : "none",
    },
    recommendation,
  };
}

export function userFacingTaskState(task = {}) {
  const lifecycle = task.taskContract?.lifecycleState ?? null;
  const execution = task.execution ?? null;
  if (task.state === "taken_over" || task.pendingIntervention?.type === "task_takeover") {
    return {
      state: "taken_over", title: "任务已由你接管", detail: "AI 已停止这项任务", owner: "you", waitTier: "none",
    };
  }
  if (task.pendingIntervention?.type === "communication_takeover") {
    return {
      state: "communication_takeover", title: "你已接管沟通", detail: "AI 不再对外回复，可继续整理证据", owner: "shared", waitTier: "none",
    };
  }
  if (["waiting_acceptance", "rework_requested", "escalated", "failed"].includes(lifecycle)) {
    const labels = {
      waiting_acceptance: ["等待你确认", "工作结果已经准备好"],
      rework_requested: ["正在按反馈修改", "AI 继续负责，必要时会再次询问"],
      escalated: ["需要你补充信息", "缺少的信息会影响工作结果"],
      failed: ["处理遇到问题", "查看失败摘要后可让 AI 继续修复"],
    };
    return { state: lifecycle, title: labels[lifecycle][0], detail: labels[lifecycle][1], owner: "you", waitTier: "needs_you" };
  }
  if (execution?.mode === "background" && backgroundStates.has(execution.state)) {
    return {
      state: "background", title: "正在后台处理", detail: "AI 会在实质进展或完成时同步", owner: "ai", waitTier: "long",
    };
  }
  if (
    task.worksiteGroup === "recent" || ["completed", "accepted"].includes(lifecycle) ||
    execution?.state === "completed"
  ) {
    return { state: "completed", title: "最近完成", detail: "结果与证据已经记录", owner: "none", waitTier: "none" };
  }
  if (execution?.mode === "instant") {
    return { state: "working", title: "正在处理", detail: "预计直接回复结果", owner: "ai", waitTier: "instant" };
  }
  return { state: "working", title: "AI 正在负责", detail: "完成后会同步结果", owner: "ai", waitTier: "normal" };
}

export function taskWaitPolicy({ expectedClass = "foreground", elapsedMs = 0, activityCount = 0, requiresExternalWait = false, requiresDurability = false, stepCount = 0 } = {}) {
  const long = expectedClass === "background" || requiresExternalWait || requiresDurability || stepCount >= 4;
  if (long) return { tier: "long", acknowledgment: "once", durable: true };
  if (elapsedMs >= 15_000 && activityCount >= 1) {
    return { tier: "normal", acknowledgment: "once", durable: false };
  }
  return { tier: "instant", acknowledgment: "none", durable: false };
}
