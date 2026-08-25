# DWS 检查点健康候选验收

## 1. 验收范围

本候选只验证DWS检查生命周期与健康状态，不提交、不推送、不部署、不生成新acceptance、不切换Active。生产保持Shadow、真实发送关闭、gbrain写入关闭和计划暂停。

## 2. 状态口径

| 状态 | 条件 | `checkpointHealthy` | `ready`处理 |
|---|---|---:|---|
| `healthy` | 最近完整检查与私有状态文件均在正常新鲜窗内 | true | 由运行、模式等其他门禁共同决定 |
| `busy_but_bounded` | 已有近期成功；新代次已持久化为running且未超过硬期限 | true | 不因DWS串行排队自动回滚 |
| `stale` | 成功、状态文件或running代次超过硬期限，或时间字段非法 | false | 停止继续放量 |
| `failed` | 检查显式失败、错误计数非零或检查点文件不安全/不可读 | false | 停止继续放量 |

30秒fallback下正常窗为60秒、busy硬期限为120秒。其他fallback按有界公式派生，busy硬期限最长15分钟。最多容忍5秒文件时间戳漂移。

## 3. 已执行验证

| 验证 | 结果 |
|---|---|
| Node + 临时PostgreSQL完整回归 | 213/213通过 |
| Python插件回归 | 40/40通过 |
| npm高危依赖审计 | 0漏洞 |
| 旧检查点无生命周期字段 | 兼容为`healthy` |
| 检查开始、真实完成时间、代次与操作 | 私有状态精确回读通过 |
| 并发唤醒、目标部分失败、下一代恢复 | 通过；失败目标游标不推进 |
| 70秒Shadow有界繁忙 | `busy_but_bounded`、ready=true、send=false |
| 121秒超时 | `stale`、ready=false |
| 显式错误 | `failed`、ready=false |
| 下一代完整成功 | `healthy`、ready=true |
| 只读状态页 | 1200×800桌面和390×844移动端均显示“检查中（有界）·第7代”；移动端页面宽度390/390无横向溢出，浏览器警告/错误0 |

## 4. 未执行事项

- 未读取或修改生产Profile；
- 未启动、停止或重启生产Gateway；
- 未发送钉钉消息；
- 未写入生产PostgreSQL或个人gbrain；
- 未提交、推送、部署或重新Active。

## 5. 部署后人工回读

只有后续获得独立部署授权时才执行：在Shadow中制造一次超过60秒但未超过120秒的受控DWS队列等待，确认Gateway、Control MCP与`foursday_runtime_status`三处均显示相同代次和`busy_but_bounded`；随后模拟超时/失败与恢复。任一投影不一致均不得Active。
