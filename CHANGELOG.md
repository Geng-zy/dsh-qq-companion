# 更新记录

## 1.0.0（2026-10-20）

基于 [mario841859784/dsh-onebot](https://github.com/mario841859784/dsh-onebot) v0.9.3 的第一个版本，改名为 dsh-qq-companion。

### 稳定性
- 所有状态文件统一排队写 + fsync + 原子替换（`src/persist.ts`）；修复退休 / 可切回会话列表并发保存时旧快照覆盖新数据、会话映射原地写可能被读到半个文件的问题。
- QQ 在线监视（`src/liveness.ts`）：心跳 `status.online`、`bot_offline` 通知、连接还在但心跳停了时断开重连。
- 断线时排队的回复持久化到 `pending-sends.json`，重启后恢复补发。
- `/preset` 选择持久化到 `preset-overrides.json`。
- 启动配置自检（`src/selfcheck.ts`）。
- 修复：`/preset` 后新会话按配置预设挂载工具；Linux 上 Noto CJK 简中字面名小写 `sc` 匹配不上；t2i 墨水自检阈值在 Linux 上剔除所有字体；inject 启动时跳过历史行的竞争；deferred 测试等待不足。
- 日志不再写消息正文；dsh 0.2.1 缺少的宿主包在 link-host 时跳过。

### 陪伴功能（默认关闭）
- 一句一条 + 打字停顿（`splitLines` 等）。
- 管理员私聊默认预设和权限（`adminPreset` / `adminPermission`）。
- 运行期群白名单 `/group`；只认管理员的自动进群 / 加好友；被踢自动移出白名单。
- 管理员私聊、每个群分开的工作目录（`adminWorkspacePath` / `groupMemoryDir`）；群里的 `qq_memory_note`。
- 每日定时任务（`scheduledPrompts`）、主动聊天（`proactive*`）、`/task`。
- 定期 / 空闲换新会话 + 交接（`privateResetDays` / `groupResetDays` / `idleResetHours`）。
- 称呼可配置（`ownerTitle`）。
