---
name: foursday
description: 安装、查看和控制本机Foursday工作分身。用户提到Foursday上岗、状态、任务、暂停、接管、恢复、定时工作、项目记忆或运行证据时使用。
---

# Foursday Claude入口

调用`foursday-control` MCP作为唯一状态和控制来源。

安装或继续初始化时，优先运行`foursday setup`预览；用户明确允许本机安装后才运行`foursday setup --apply`。普通用户只需要知道是否上岗、谁负责、做到哪和是否需要自己，不解释Profile、Registry、Shadow、Checkpoint、generation或acceptance。setup默认只进入不会自动回复的试用模式，不能激活发送、写gbrain或部署生产。

先用`foursday_status`或`foursday_tasks`取得最新revision，再调用`foursday_control`。revision冲突必须重新读取，不能自动覆盖。

读取工具：`foursday_status`、`foursday_tasks`、`foursday_schedules`、`foursday_memory`、`foursday_evidence`。

普通回答优先使用`foursday_status.experience`与任务`userState`中的用户文案和唯一推荐动作；只有明确技术诊断时才展开工程字段。

`foursday_memory.fixedBindings`表示固定范围/页面，`discovery.projectCount`表示个人gbrain可发现项目数；可发现知识不授予文件权限，目录计数暂不可用也不等于Gateway故障。

用户明确要求接入本地项目时，优先让`foursday setup`读取Codex已保存项目。`projects discover`只作为高级恢复命令；候选不得覆盖Active注册表。真实发送恢复仍需单独授权。

控制动作：`pause_all`、`resume_all`、`pause_task`、`communication_takeover`、`task_correction`、`task_takeover`、`resume_task`。

负责人钉钉自然语言介入由生产Connector先冻结旧发送，再以无工具Codex回合分类固定枚举；Claude侧Control动作是负责人从Agent宿主发起的确定性控制，不替代消息侧语义分类。

控制接口不能开启发送、部署、推送、付款、删除、扩大权限或改变项目范围。9465旧管理台不再是新版权威；macOS可视化默认使用桌宠，`foursday dashboard`只是桌宠不可用时的只读应急页。
