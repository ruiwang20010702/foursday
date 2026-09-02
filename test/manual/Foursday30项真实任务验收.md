# Foursday 30项真实任务验收

## 目标

验证用户能否只凭“是否上岗、谁负责、做到哪、是否需要我”使用Foursday，并获得消息发现、接单、完成、接管和零重复发送的真实证据。测试不得记录聊天原文、人员ID、绝对路径、命令、凭据或思维链。

## 前置状态

- 候选版本已经通过自动化测试；
- 仅使用明确参加测试的企业内账号；
- 先在试用模式完成理解与工具验证，再单独授权灰度发送；
- 每个真实工作项由Shadow证据生成不含正文的`workItemHash`；人工确认它代表一项完整业务任务后，用记录命令派生稳定`taskHash`，重复记录会被拒绝；
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
8. 在私有观察文件中只填写指标判断，再由记录命令写入私有JSONL；不要手工编辑正式证据。

## 私有观察文件示例

```json
{
  "schema": "foursday-experience-observation/v1",
  "sourceHash": "0123456789abcdef0123456789abcdef",
  "taskClass": "normal",
  "wakeSource": "dws_event",
  "detectionMs": 8000,
  "internalDetectionMs": 800,
  "acknowledgmentMs": null,
  "firstEffectiveReplyMs": 25000,
  "responsibilityCorrect": true,
  "duplicated": false,
  "takeoverObserved": false,
  "completed": true
}
```

只允许示例中的固定字段；不得添加消息正文、人员身份、路径或备注。`sourceHash`取自该任务对应的`workItemHash`，旧证据可使用最后一条消息的哈希。

## 记录单项任务

```bash
npm run experience:record -- \
  --observation /absolute/private/observation.json \
  --evidence /absolute/private/experience.jsonl
```

命令会派生稳定`taskHash`、一次性追加完整事件组、拒绝重复任务，并回读`messagesSent: 0`。

## 生成报告

```bash
npm run experience:verify -- \
  --evidence /absolute/private/experience.jsonl \
  --output /absolute/private/experience-report.json
```

`sample.taskCount`和`sample.sufficient`只统计含终态人工复核的`task_result`，会话数或仅被系统发现的工作项不能冒充真实任务。`sample.sufficient`只有在至少30个不同`taskHash`时才为`true`。缺少某项证据时，该指标必须为`passed=null`，不能按通过计算。
