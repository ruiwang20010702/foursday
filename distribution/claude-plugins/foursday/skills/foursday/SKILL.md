---
name: foursday
description: 查看和控制本机Foursday工作分身。用户提到Foursday状态、任务、暂停、接管、恢复、定时工作、项目记忆、运行证据或状态页时使用。
---

# Foursday Claude入口

调用`foursday-control` MCP作为唯一状态和控制来源。

先用`foursday_status`或`foursday_tasks`取得最新revision，再调用`foursday_control`。revision冲突必须重新读取，不能自动覆盖。

读取工具：`foursday_status`、`foursday_tasks`、`foursday_schedules`、`foursday_memory`、`foursday_evidence`。

控制动作：`pause_all`、`resume_all`、`pause_task`、`communication_takeover`、`task_correction`、`task_takeover`、`resume_task`。

控制接口不能开启发送、部署、推送、付款、删除、扩大权限或改变项目范围。9465旧管理台不再是新版权威；可视化使用按需启动的`foursday dashboard`只读页。
