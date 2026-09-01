# Foursday 30项真实任务验收

## 目标

验证用户能否只凭“是否上岗、谁负责、做到哪、是否需要我”使用Foursday，并获得消息发现、接单、完成、接管和零重复发送的真实证据。测试不得记录聊天原文、人员ID、绝对路径、命令、凭据或思维链。

## 前置状态

- 候选版本已经通过自动化测试；
- 仅使用明确参加测试的企业内账号；
- 先在试用模式完成理解与工具验证，再单独授权灰度发送；
- 每项任务使用随机生成的16—64位十六进制`taskHash`；
- 测试证据文件权限为`600`。

## 样本构成

| 编号 | 数量 | 任务类型 | 验证重点 |
|---|---:|---|---|
| I01—10 | 10 | 即时任务 | 15秒内不发送接单套话，直接给出有效结果 |
| N01—10 | 10 | 普通任务 | 超过15秒只接单一次，仍在当前会话完成 |
| L01—10 | 10 | 长任务 | 明确交付物、后台继续、实质变化才更新、跨重启恢复 |

至少覆盖：项目事实核对、钉钉文档阅读、图片或附件理解、网页搜索、数据计算、文档整理、代码修改与测试、需要业务人员补充、需要所有者授权、人工沟通接管和任务接管。

## 单项步骤

1. 记录发送时间，不记录消息正文。
2. 确认任务最后一条消息出现“好的”责任标记。
3. 记录Foursday发现任务的时间。
4. 检查桌宠是否用自然语言标题显示正确责任人。
5. 普通／长任务记录一次接单时间；即时任务确认没有接单噪声。
6. 对需要接管的样例由用户回复或贴表情，确认Foursday停止抢答。
7. 记录最终结果是否完成、是否具有可回读证据、是否重复发送。
8. 在私有JSONL中写入指标事件。

## JSONL示例

```json
{"type":"message_detected","taskHash":"0123456789abcdef","durationMs":8000}
{"type":"ack_sent","taskHash":"0123456789abcdef","durationMs":12000}
{"type":"responsibility_check","taskHash":"0123456789abcdef","correct":true}
{"type":"duplicate_send_check","taskHash":"0123456789abcdef","duplicated":false}
{"type":"takeover_reply_check","taskHash":"0123456789abcdef","repliedAfterTakeover":false}
{"type":"task_result","taskHash":"0123456789abcdef","completed":true}
```

## 生成报告

```bash
npm run experience:verify -- \
  --evidence /absolute/private/experience.jsonl \
  --output /absolute/private/experience-report.json
```

`sample.sufficient`只有在至少30个不同`taskHash`时才为`true`。缺少某项证据时，该指标必须为`passed=null`，不能按通过计算。
