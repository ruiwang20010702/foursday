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

`foursday_memory`中的`fixedBindings`是固定工作范围/页面，`discovery.projectCount`是个人gbrain当前可发现项目数；后者不授予文件权限。`discovery.state=unavailable`只表示项目目录计数暂不可用，不等于Gateway故障。

## 项目接入

用户明确要求初始化或接入本地项目时：

1. 使用Agent宿主的项目清单能力取得已保存的本地项目，写入仓库外或`.runtime`下的600权限私有JSON；不要盲扫整个磁盘。
2. 先运行`foursday projects discover --catalog <绝对路径> --output <独立候选路径>`预览。
3. 回报接入、排除、保留、父子范围和gbrain可发现数量；不得输出本机路径或私人页面标题。
4. 用户已授权写候选时增加`--apply`；它只能写独立候选，不能覆盖Active注册表。
5. 配置Profile、切换Shadow、重新验收和恢复Active都是后续独立外部变更，不能从“生成候选”推断授权。

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
