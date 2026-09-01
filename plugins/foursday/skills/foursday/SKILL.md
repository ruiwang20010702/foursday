---
name: foursday
description: 安装、查看和控制本机Foursday工作分身。用户提到Foursday上岗、状态、任务、暂停、接管、恢复、定时工作、项目记忆或运行证据时使用。
---

# Foursday Codex入口

Foursday状态只来自`foursday-control` MCP；不要根据聊天历史猜测。

## 十分钟上岗

用户要求安装、初始化或继续安装时，优先运行`foursday setup`预览。只向用户解释“是否可以开始、还需要什么、下一动作”；不要要求用户理解Profile、Registry、Shadow、Checkpoint、generation或acceptance。

用户明确同意应用本机安装后才运行`foursday setup --apply`。该命令最多处理钉钉账号、允许工作的项目目录和是否保持试用三个选择，默认只启动“试用中，不会自动回复”。它不能激活真实发送、开启gbrain写入、部署生产或继承联系人权限。

## 读取

1. 整体健康与全局revision：`foursday_status`。
2. 任务与Codex Thread：`foursday_tasks`。
3. 定时/主动工作：`foursday_schedules`。
4. 个人gbrain项目范围：`foursday_memory`。
5. 不含正文的运行证据：`foursday_evidence`。

普通回答优先使用`foursday_status.experience`和任务的`userState`：只说明是否上岗、谁负责、做到哪、是否需要用户，以及唯一推荐动作。工程字段只有用户明确问技术诊断时才展开。

`foursday_memory`中的`fixedBindings`是固定工作范围/页面，`discovery.projectCount`是个人gbrain当前可发现项目数；后者不授予文件权限。`discovery.state=unavailable`只表示项目目录计数暂不可用，不等于Gateway故障。

## 项目接入

用户明确要求初始化或接入本地项目时：

1. 优先让`foursday setup`读取Codex已保存项目；不要盲扫整个磁盘。
2. 仅在高级恢复场景运行`foursday projects discover --catalog <绝对路径> --output <独立候选路径>`预览。
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

负责人在钉钉中的自然语言介入由生产Connector先冻结旧发送，再通过无工具Codex语义分类；Control MCP动作仍用于负责人明确从Agent宿主执行的确定性控制。两者都不能开启发送或扩大权限。

## 边界

- 控制工具不能开启真实发送、部署、推送、付款、删除、扩大权限或改变项目范围。
- 任务ID是匿名哈希，不反推联系人身份。
- 9465是旧管理台，不作为新版权威入口。
- macOS默认可视化入口是桌宠；`foursday dashboard`仅在桌宠不可用或非macOS环境下作为只读应急页。
