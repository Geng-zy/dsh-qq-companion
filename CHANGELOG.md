# 更新记录

## 1.1.2（2026-10-20）

- 修复误报：恢复会话时“记录的预设和配置不一致”的警告原来只和全局 `agentPreset` 比，用 `adminPreset` 的管理员私聊每次重启都会被报。现在按这个会话按现在配置应该用的预设比较（`/preset` 覆盖 → 管理员私聊的 `adminPreset` → `agentPreset`），真不一致才警告，警告写明是哪个会话、发 `/new` 就能换过来。恢复行为不变。

## 1.1.1（2026-10-20）

- 修复：模型偶尔会在回复后面“续写聊天记录”——编一行 `[HH:MM 昵称(QQ号)] ……`（比如假的“撤回了一条消息”），后面再跟一段英文的自我纠正，这些都被原样发到了群里，还带出了别人的 QQ 号。现在发往 QQ 的所有模型文字从第一行这种内容起截掉，日志记一条警告。
- 群离开白名单（`/group remove`、被踢、或 dsh 停机时从配置里删掉）时退休这个群的会话；以后重新放行，从当前预设的新会话开始。之前遗留的旧会话在启动时自动清理。

## 1.1.0（2026-10-20）

### 重启后接着算
- 定时任务记住“今天执行过没有”（`scheduler-state.json`）；dsh 停机时错过的任务，3 小时内重启会补执行（比如凌晨重启不会漏掉日记）。
- 主动聊天当天的计划和已叫醒次数（`proactive-state.json`），重启不再重新抽签；停机超过半小时的时间点丢弃。
- 群记忆每天记了几条（`note-counts.json`），重启不清零。
- 这些状态文件坏了按空状态处理并记一条警告。

### 可见性
- `/doctor` 新增“陪伴状态”：QQ 账号在线 / 离线和上次心跳、定时任务今天执行没有、主动聊天今天叫醒几次和剩余时间、每个记忆文件的大小和占上限的比例（到 80% 标“该整理了”，超过标“已满”）。
- 设置页新增“陪伴”“记忆与会话”“主动聊天”三组共 27 个配置项（定时任务列表仍在 patch 里改）。

### 测试
- 端到端测试 `npm run e2e`：真实 dsh 宿主 + 本地假 DeepSeek 接口 + 假 NapCat，覆盖鉴权、斜杠命令、`/doctor`、私聊和群聊各一轮对话；不需要网络和 API Key，CI 每次都跑。
- 覆盖率统计接入 CI（`npm run coverage`），低于门槛就失败；当前行覆盖 90%。
- 故障演练：磁盘写失败、运行中磁盘变只读、全部状态文件损坏、定时任务 / 主动聊天失败时都照常聊天，恢复后补写。

### 代码结构
- 陪伴逻辑从原作者的 `bridge.ts` / `commands.ts` 移到 `src/companion/hooks.ts`、`src/companion/task-command.ts`，以后合并原作者新版本冲突更少。
- `/doctor` 标题改为 `dsh-qq-companion 体检`。

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
