---
name: foursday
description: 查看和控制本机Foursday工作分身。用户提到Foursday状态、任务、暂停、接管、恢复、定时工作、项目记忆、运行证据或状态页时使用。
---

# Foursday Claude入口

调用`foursday-control` MCP作为唯一状态和控制来源。

先用`foursday_status`或`foursday_tasks`取得最新revision，再调用`foursday_control`。revision冲突必须重新读取，不能自动覆盖。

读取工具：`foursday_status`、`foursday_tasks`、`foursday_schedules`、`foursday_memory`、`foursday_evidence`。

`foursday_memory.fixedBindings`表示固定范围/页面，`discovery.projectCount`表示个人gbrain可发现项目数；可发现知识不授予文件权限，目录计数暂不可用也不等于Gateway故障。

用户明确要求接入本地项目时，使用Agent宿主已保存项目清单生成600权限私有JSON，先运行`foursday projects discover --catalog <绝对路径> --output <独立候选路径>`预览。只有用户授权写候选时才增加`--apply`；候选不得覆盖Active注册表。Profile配置、Shadow验收和Active恢复仍需分别授权。

控制动作：`pause_all`、`resume_all`、`pause_task`、`communication_takeover`、`task_correction`、`task_takeover`、`resume_task`。

负责人钉钉自然语言介入由生产Connector先冻结旧发送，再以无工具Codex回合分类固定枚举；Claude侧Control动作是负责人从Agent宿主发起的确定性控制，不替代消息侧语义分类。

控制接口不能开启发送、部署、推送、付款、删除、扩大权限或改变项目范围。9465旧管理台不再是新版权威；可视化使用按需启动的`foursday dashboard`只读页。
