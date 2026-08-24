---
name: foursday
description: 查看和控制本机Foursday工作分身。用户提到Foursday状态、任务、暂停、接管、恢复、定时工作、项目记忆、运行证据或可选状态页时使用。
---

# Foursday Codex入口

Foursday状态只来自`foursday-control` MCP；不要根据聊天历史猜测。

## 读取

1. 整体健康与全局revision：`foursday_status`。
2. 任务与Codex Thread：`foursday_tasks`。
3. 定时/主动工作：`foursday_schedules`。
4. 个人gbrain项目范围：`foursday_memory`。
5. 不含正文的运行证据：`foursday_evidence`。

## 控制

控制前必须先读取最新状态或任务，并把返回的精确`revision`传给`foursday_control`。revision冲突时重新读取，不能盲目重试。

- `pause_all` / `resume_all`：全局暂停或恢复。
- `pause_task`：停止当前Turn并保留可恢复状态。
- `communication_takeover`：负责人已对外回复，废弃旧AI回复但允许后台证据继续。
- `task_correction`：必须提供不含秘密的纠正说明。
- `task_takeover`：负责人接管整个任务。
- `resume_task`：恢复同一任务边界。

## 边界

- 控制工具不能开启真实发送、部署、推送、付款、删除、扩大权限或改变项目范围。
- 任务ID是匿名哈希，不反推联系人身份。
- 9465是旧管理台，不作为新版权威入口。
- 需要可视化时建议用户运行`foursday dashboard`；页面默认只读。
