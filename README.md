# dsh-qq-companion

给 [dsh（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 接**个人 QQ 号**的陪伴型通道插件。

基于 [mario841859784/dsh-onebot](https://github.com/mario841859784/dsh-onebot)（BSD-3-Clause）修改：保留原版的全部功能（OneBot 11、NapCat、私聊群聊、图片语音、斜杠命令、设置页……），在此之上补了稳定性，并加了一套“让 AI 像个真人朋友”的陪伴功能。

```
你的 QQ ⇄ QQ 服务器 ⇄ NapCat（登录一个 QQ 小号）⇄ OneBot 11 WebSocket ⇄ dsh-qq-companion ⇄ dsh agent
```

> ⚠️ 个人号接机器人用的是非官方协议（NapCat），**有被风控的风险**，请只用小号。

## 和原版 dsh-onebot 相比

**稳定性**

- 所有状态文件（会话映射、退休会话、可切回会话、超时补发、群白名单、聊天活动……）统一排队写 + fsync + 原子替换：不会出现写坏的半个文件，也不会出现旧数据覆盖新数据。
- QQ 在线监视：读取 OneBot 心跳里的 `status.online` 和 NapCat 的 `bot_offline` 通知，小号被挤下线时醒目报错；连接还在但心跳停了（“假在线”）会主动断开让 NapCat 重连。
- 断线时排队的回复存到磁盘，dsh 重启也不丢；定时任务、主动聊天计划、群记忆条数也是重启后接着算（停机错过的定时任务 3 小时内补执行）。
- `/preset` 的选择持久化（原版只在内存里）。
- 启动时配置自检，用中文逐条指出会导致“不工作”的配置。
- 修复：`/preset` 后新会话挂错预设；Linux 上文字图卡片永远找不到中文字体（简中字面名大小写 + 墨水自检阈值）；inject 启动竞争；日志里不再写消息正文。

**陪伴功能**（全部默认关闭，按需在配置里打开）

| 功能 | 说明 |
|---|---|
| 一句一条 | 最终回复按行拆成多条消息发出，中间有按字数的“打字”停顿；行数太多（列表、代码）就整段发 |
| 管理员私聊默认权限 | 管理员私聊自动用指定预设和宿主权限（比如完整权限），群聊和其他人保持只能聊天 |
| 运行期群白名单 | `/group allow / remove / list` 随时增删，重启不丢 |
| 只认管理员的进群 / 加好友 | 管理员的邀请和好友申请自动同意、自动加白名单；别人的一律不同意并私聊告诉管理员；被踢出群自动移出白名单 |
| 分开的工作目录 | 管理员私聊、每个群各用自己的工作目录，配合 dsh 自动读取的 `AGENTS.md`，实现“私密记忆只有私聊读得到、群记忆只有本群读得到” |
| `qq_memory_note` | 群里唯一能写记忆的工具：只能往本群记忆追加一句，有字数、次数、文件大小上限，拒绝像“改规则 / 认身份”的内容 |
| 每日定时任务 | 每天 HH:MM 往指定会话投递一个任务（比如写日记），可附当天聊天节选 |
| 主动聊天 | 每天在时段内随机叫醒几次，由模型决定要不要主动找管理员；回复 `[不发]` 就什么都不发；对方刚聊过就跳过，连续没回就当天停止 |
| 定期 / 空闲换新会话 | 私聊、群聊分别每 N 天换一次新会话，或空闲 N 小时后换；新会话附上最后几句“交接” |
| `/task` | 列出定时任务和今天剩余的主动聊天时间；`/task <id>`、`/task checkin` 立刻执行 |
| `/doctor` 陪伴状态 | QQ 账号是否真在线、定时任务今天执行没有、主动聊天计划、每个记忆文件占上限多少 |
| 设置页 | 陪伴、记忆与会话、主动聊天三组配置都能在 dsh 网页的设置里改 |
| 防风控 | 所有消息按真人打字速度发（整个小号同一时间只打一条）、群里不拆句；`/doctor` 显示发送量 |

## 安装

前提：dsh ≥ 0.2.0-rc.1（已在 0.2.1-rc.2 上测试），Node ≥ 22，pnpm（dsh 安装插件需要），NapCat 已登录小号。

```sh
dsh plugin --profile web add github:Geng-zy/dsh-qq-companion
```

在 profile 的 `pnpm-workspace.yaml` 里加上（防止 pnpm 拉进 registry 上的旧版 `@deepseek-ai/*` 副本）：

```yaml
autoInstallPeers: false
hoist: false
```

Linux 上要装中文字体（文字图卡片用）：

```sh
sudo apt install fonts-noto-cjk fonts-wqy-zenhei fonts-noto-color-emoji fonts-dejavu-core
```

**从原版 dsh-onebot-qq 迁移**：先 `dsh plugin --profile web remove dsh-onebot-qq`（两个插件同时挂载会冲突），再安装本插件。配置行的 id 仍然是 `dsh-onebot`，原来的 config 覆盖行不用改；默认媒体目录也还是 `<dsh-home>/media/onebot`，会话映射等状态会自动沿用。

### NapCat 侧

在 NapCat 网络设置里加一个 **WebSocket 客户端**：地址 `ws://127.0.0.1:8643/ws`，token 与插件的 `accessToken` 相同，消息格式选“数组”。

### 最小配置

写在 `<DSH_HOME>/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-onebot
  name: 'dsh-qq-companion'
  config:
    mode: reverse
    host: 127.0.0.1
    port: 8643
    accessToken: !!js process.env.ONEBOT_ACCESS_TOKEN   # 建议用环境变量，不把 token 写进文件
    botQQ: '小号的 QQ 号'
    adminUsers: ['你的 QQ 号']
    groupPolicy: allowlist
    groupAllowFrom: []          # 之后用 /group allow 群号 添加
```

重启 dsh，日志里出现 `[qq-companion] mounted`、`配置自检通过`、`OneBot connected` 就好了。

## 陪伴功能配置

都写在上面同一个 `config` 下。一个完整的例子：

```yaml
    ownerTitle: 主人                       # 系统提示和通知里怎么称呼管理员（默认“管理员”）
    agentPreset: my-chat                   # 默认（群聊、其他人）用只能聊天的预设
    adminPreset: my-full                   # 管理员私聊用完整预设
    adminPermission: danger-full-access    # 管理员私聊每个新会话自动切换的宿主权限
    autoAcceptAdminRequests: true
    autoAllowInvitedGroups: true
    splitLines: true
    splitMaxMessages: 6
    textImageThreshold: 0                  # 长回复不转图片
    workspacePath: /home/bot/memory
    adminWorkspacePath: /home/bot/memory/private
    groupMemoryDir: /home/bot/memory/groups
    groupMemoryMaxBytes: 12288
    publicMemoryFile: /home/bot/memory/AGENTS.md
    publicMemoryMaxBytes: 24576
    privateResetDays: 5
    groupResetDays: 2
    idleResetHours: 168
    scheduledPrompts:
      - id: diary
        time: '01:30'
        chatId: 'private:你的QQ号'
        includeTodayLog: true
        prompt: 现在是写日记的时间……
    proactiveEnabled: true
    proactiveChatId: 'private:你的QQ号'
    proactiveWindowStart: '09:00'
    proactiveWindowEnd: '22:00'
    proactiveMinPerDay: 4
    proactiveMaxPerDay: 6
```

| 键 | 默认 | 说明 |
|---|---|---|
| `ownerTitle` | `管理员` | 系统提示和通知里对管理员的称呼 |
| `splitLines` | `false` | 最终回复按行拆成多条消息 |
| `splitMaxMessages` | `6` | 最多拆几条；行数超过就整段发 |
| `typingDelayPerCharMs` / `typingDelayMinMs` / `typingDelayMaxMs` | `80` / `500` / `2500` | 拆分发送时的打字停顿 |
| `adminPreset` | 空 | 管理员私聊默认预设（`/preset` 覆盖优先） |
| `adminPermission` | 空 | 管理员私聊每个新会话自动执行的宿主 `/permission` 预设 |
| `adminWorkspacePath` | 空 | 管理员私聊的工作目录 |
| `groupMemoryDir` | 空 | 每个群一个工作目录 `<根>/<群号>`，自动建 `AGENTS.md` 模板 |
| `groupMemoryMaxBytes` | `8192` | 群记忆满了就拒绝追加 |
| `publicMemoryFile` / `publicMemoryMaxBytes` | 空 / `6144` | 没设 `groupMemoryDir` 时，群里的记忆追加写到这里 |
| `autoAcceptAdminRequests` | `false` | 管理员的好友申请 / 进群邀请自动同意 |
| `autoAllowInvitedGroups` | `false` | 管理员拉进的群自动加白名单 |
| `idleResetHours` | `0` | 空闲这么多小时后换新会话 |
| `privateResetDays` / `groupResetDays` | `0` | 会话跨过这么多个凌晨 4 点后换新会话 |
| `scheduledPrompts` | `[]` | 每日定时任务：`id`、`time`（HH:MM）、`chatId`、`prompt`、`includeTodayLog` |
| `proactiveEnabled` | `false` | 主动聊天 |
| `proactiveChatId` | 空 | 主动找的会话（应为管理员私聊） |
| `proactiveWindowStart` / `proactiveWindowEnd` | `09:00` / `22:00` | 时段（不跨午夜） |
| `proactiveMinPerDay` / `proactiveMaxPerDay` | `4` / `6` | 每天叫醒次数 |
| `proactiveMinGapMinutes` | `90` | 两次之间至少隔多久 |
| `proactiveSkipIfActiveMinutes` | `30` | 对方这么多分钟内说过话就跳过 |
| `proactiveMaxUnanswered` | `2` | 主动消息这么多条没回就当天停止 |

全部配置项（连接、权限、媒体、语音转写、文字图卡片、诊断……）的类型、默认值和说明见 [docs/CONFIG.md](docs/CONFIG.md)。

### 叫醒和定时任务发给模型的是什么

- 定时任务：`[定时任务 HH:MM｜这条不是{ownerTitle}发的，是系统按时叫你]` + 你写的 `prompt`（+ 当天聊天节选）。
- 主动聊天：`[主动聊天的机会 HH:MM｜这条不是{ownerTitle}发的，是系统叫醒你]` + 对方多久没说话、有几条没回 + “想找就直接写，不想就只回复 `[不发]`”。

在人设里告诉模型收到这两种消息该怎么做（写日记的步骤、什么时候值得主动找人）。

## 安全建议

- `host` 保持 `127.0.0.1`，NapCat 的 WebUI 也只监听本机；`accessToken` 用随机值，放环境变量。
- 群聊和其他人用一个**没有命令行、没有文件写入**的预设：一个群共用一个会话，群里所有人都能用到它的工具。只有管理员私聊给完整权限。
- 用小号；别让它短时间大量发消息、进很多群。

## 开发

```sh
npm ci --include=dev --legacy-peer-deps
./scripts/build.sh                 # 链接宿主 @deepseek-ai 包（需要 dsh 在 PATH 上）+ 编译
./node_modules/.bin/vitest run     # 全部测试
npm run coverage                   # 测试 + 覆盖率（低于门槛会失败）
npm run e2e                        # 端到端：真实 dsh + 假 DeepSeek 接口 + 假 NapCat，不需要网络和 API Key
```

陪伴功能在 `src/companion/`（接进桥接层的部分在 `hooks.ts`），状态文件写入在 `src/persist.ts`，QQ 在线监视在 `src/liveness.ts`，配置自检在 `src/selfcheck.ts`。

## 许可

BSD-3-Clause，见 [LICENSE](LICENSE)。原版版权归 dsh-external contributors（dsh-onebot），修改部分版权归 Geng-zy。
