# 配置项

> 由 `npm run docs:config` 从 `src/config.ts` 生成，不要手改。
> 配置写在 dsh profile 的 `cordis.patch.yml` 里 `id: dsh-onebot` 那一行的 `config:` 下，也可以在 dsh 网页的设置里改其中常用的几十项。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | "reverse" / "forward" | `"reverse"` | 连接模式：reverse = NapCat ws-reverse 拨入（本插件监听端口）；forward = 本插件主动连接 NapCat 的 ws 服务 |
| `host` | string | `"127.0.0.1"` | reverse 模式监听地址；跨机部署（NapCat 从其他机器拨入）需显式改为 0.0.0.0 |
| `port` | number | `8643` | reverse 模式监听端口 |
| `url` | string | `"ws://127.0.0.1:3001"` | forward 模式的 NapCat ws 地址 |
| `accessToken` | string | `""` | OneBot access_token（reverse 校验 / forward 发送 Authorization: Bearer） |
| `reconnectMaxAttempts` | number | `100` | forward 模式重连上限：连续失败达到该次数后放弃重连并打印恢复指引；0 = 无限重试（退避间隔封顶 60s） |
| `botQQ` | string | `""` | 机器人自身 QQ 号；留空则从 meta 事件自动学习 |
| `requireMention` | boolean | `true` | 群聊是否仅在 @机器人（或回复其消息）时响应 |
| `unknownCommand` | "intercept" / "passthrough" | `"intercept"` | 未知斜杠命令处理：intercept（默认）=拦截并提示相近命令或 /help；passthrough=透传给模型（旧行为） |
| `newMessagePolicy` | "queue" / "steer" | `"queue"` | 任务运行中的新消息处理策略：queue（默认）=排队——新消息在当前任务结束后按序处理为后续回合，等待期间至多提示一次；steer=插话——运行中收到的新普通纯文字消息作为补充指令加入当前任务（模型在下一步读取）并回复提交提示；图片/文件/语音/带引用消息与 [受限用户:仅问答] 消息两种模式下都按排队处理，/steer 命令两种模式下均可用 |
| `autoSteerPolicy` | "admin" / "all" | `"admin"` | steer 模式下自动插话的发送者资格：admin（默认）=仅管理员可自动插话；all=所有非受限发送者均可。不具备资格的消息按排队处理；/steer 命令始终仅管理员、不受本项影响；queue 模式行为不变 |
| `deferredTimeoutMs` | number | `600000` | 等待模型回复超时阈值（毫秒超时补发）：回合超过该时长没有任何模型输出时提示超时并登记补发跟踪，任务完成后向原聊天自动补发最终文字（走既有出站管线）；发送明确失败最多尝试 3 次（退避），结果不确定时保留记录停止自动重试；/stop 终止该聊天的补发跟踪；0=关闭超时补发 |
| `dmPolicy` | "open" / "allowlist" / "disabled" | `"open"` | 私聊策略：open=仅管理员；allowlist=仅 allowFrom；disabled=拒绝所有私聊 |
| `groupPolicy` | "open" / "allowlist" / "disabled" | `"open"` | 群聊策略：open=所有群；allowlist=仅 groupAllowFrom；disabled=拒绝所有群 |
| `allowFrom` | string[] | `[]` | dmPolicy=allowlist 时允许私聊的 QQ 号 |
| `groupAllowFrom` | string[] | `[]` | groupPolicy=allowlist 时允许的群号 |
| `adminUsers` | string[] | `[]` | 管理员 QQ 号（也可用环境变量 ONEBOT_ALLOWED_USERS 逗号分隔指定） |
| `allowAllUsers` | boolean | `false` | 放行所有用户（仅开发用；也可用 ONEBOT_ALLOW_ALL_USERS=true） |
| `autoAcceptAdminRequests` | boolean | `false` | 管理员发来的好友申请和进群邀请自动同意（其他人的一律不同意，并私聊告诉管理员） |
| `ownerTitle` | string | `"管理员"` | 机器人在系统提示和通知里对管理员的称呼，例如「主人」 |
| `autoAllowInvitedGroups` | boolean | `false` | 管理员拉机器人进的群自动加入群白名单（运行期白名单，保存在 mediaDir/group-allowlist.json） |
| `ignoreSelf` | boolean | `true` | 忽略机器人自己发出的消息（防自循环） |
| `interimMessages` | boolean | `true` | 是否把模型每步（含工具调用之间的中间回复）的文本立即发出；false 则只发最终回复。true 时：中间消息实时可见、每条在 interimRecallMs 后自动单独撤回、回合结束先发一张整轮 t2i 小结卡再发最终回复 |
| `interimRecallMs` | number | `90000` | 中间消息各自发送完成后多久自动单独撤回（毫秒；QQ 撤回时限约 2 分钟，建议 ≤110000） |
| `interimRecall` | boolean | `true` | 中间消息撤回开关：true（默认）=每条中间消息在 interimRecallMs 后自动撤回，回合结束先发整轮 t2i 小结卡再立即撤回原消息；false=只发不撤——中间消息照常实时发出但保留在聊天里：不排自动撤回定时器、回合结束不发小结卡也不撤回原消息，只发最终回复 |
| `sendErrorNotice` | boolean | `true` | 一轮运行出错时向用户发送 ⚠️ 错误提示 |
| `rateLimitPerMinute` | number | `30` | 每 chat 每分钟允许的普通消息条数上限（60 秒滑动窗口）；命令消息不计入也不受限；超限时每窗口最多提示一次；0=禁用频控 |
| `restrictedMemberPrefix` | boolean | `true` | 群聊非管理员消息注入 [受限用户:仅问答] 前缀（软限制） |
| `sensitivePatterns` | string[] | `[]` | 出站敏感内容审计正则（默认内置 rm -rf/关机/删库/密钥 等模式；留空用默认） |
| `mediaDir` | string | `""` | 入站媒体与映射文件目录；留空默认 <dsh-home>/media/onebot |
| `tempTtlHours` | number | `6` | 入站临时媒体文件保留时长（小时），到期自动清理 |
| `outboundImageMaxBytes` | number | `8388608` | 出站图片大小上限（字节） |
| `maxImageBytes` | number |  | [deprecated] 旧名别名（现 outboundImageMaxBytes）：出站图片大小上限（字节）；本版兼容读取，新配置请用新名 |
| `inboundImageMaxPx` | number | `2048` | 入站图片长边上限（像素）；超过则等比压缩后交给视觉模型，<=0 禁用 |
| `imageMaxSize` | number |  | [deprecated] 旧名别名（现 inboundImageMaxPx）：入站图片长边上限（像素）；本版兼容读取，新配置请用新名 |
| `maxVoiceBytes` | number | `15728640` | 出站语音大小上限（字节） |
| `maxFileBytes` | number | `20971520` | 出站视频/文件大小上限（字节） |
| `sttEnabled` | boolean | `false` | 收到语音时转成文字给她看（本机离线识别，需要 ffmpeg 和一个识别引擎；没装或失败时她只看到 [语音]） |
| `sttEngine` | "auto" / "sherpa-onnx" / "whisper-cpp" / "command" / "openai" / "custom" | `"auto"` | 识别引擎：sherpa-onnx = sherpa-onnx-offline + SenseVoice 模型（中文好、CPU 快，推荐）；whisper-cpp = whisper-cli + ggml 模型；command = 自定义命令（stdout 输出文字）；auto = 按 sherpa-onnx、whisper-cpp 的顺序找能用的。旧名 custom = command，openai = auto |
| `sttCommand` | string | `""` | command 引擎的程序名或路径 |
| `sttArgs` | string[] | `[]` | command 引擎的参数模板：{wav}（16kHz 单声道 WAV）、{input}（原文件）、{model}、{lang} 会被替换；留空 = 只传 {wav} |
| `sttModel` | string | `""` | sherpa-onnx：SenseVoice 模型目录（含 tokens.txt 和 model.int8.onnx）；whisper-cpp：模型名（如 small，找 ggml-small.bin）或 .bin 路径；留空用默认位置 |
| `sttLanguage` | string | `"auto"` | 语音的语言：auto 自动判断，或 zh / en / ja 等 |
| `sttMaxSeconds` | number | `60` | 只转写每条语音的前多少秒 |
| `sttTimeoutMs` | number | `60000` | 单次转写超时（毫秒）；超时后她只看到 [语音] |
| `textImageThreshold` | number | `150` | 回复正文超过该长度（字符数）时渲染为文字图卡片发送；<=0 禁用卡片路径 |
| `splitLines` | boolean | `false` | 模型最终回复按行拆成多条消息发送（一句一条），中间按字数停顿模拟打字 |
| `splitMaxMessages` | number | `6` | 一条回复最多拆成几条；行数超过它（列表、代码等）就整段发送 |
| `groupSplitLines` | boolean | `true` | 群聊里也一句一条；false = 群里每次回复只发一条（发送量少很多，降低 QQ 风控概率） |
| `humanTypingPace` | boolean | `false` | 防风控：所有发出的消息都按真人打字的速度排队（按字数等 typingDelayPerCharMs，夹在 typingDelayMinMs～typingDelayMaxMs 之间）；整个小号同一时间只“打”一条，几个会话同时回复时自然排队 |
| `typingDelayPerCharMs` | number | `80` | 拆分发送时每个字的打字停顿（毫秒） |
| `typingDelayMinMs` | number | `500` | 两条消息之间最短停顿（毫秒） |
| `typingDelayMaxMs` | number | `2500` | 两条消息之间最长停顿（毫秒） |
| `cardFooter` | string | `"dsh"` | 文字图卡片页脚品牌文字（"Powered by <brand>"） |
| `fontFiles` | string[] | `[]` | t2i 渲染器注册的字体文件路径（Linux/自定义字体；macOS 自动用系统字体） |
| `fontFamilies` | string[] | `[]` | t2i 渲染器优先使用的字体家族名（覆盖平台默认） |
| `agentPreset` | string | `""` | QQ 会话加入的 agent 预设 id；留空用部署默认（settings 的 agent-presets.default，当前为 router-flash）。创建时总是解析有效预设并写入会话 header，Web 界面可见；resume 优先恢复会话自己记录的预设 |
| `adminPreset` | string | `""` | 管理员私聊默认使用的 agent preset（留空=同 agentPreset；/preset 覆盖优先） |
| `adminPermission` | string | `""` | 管理员私聊每个新会话自动切换的宿主权限预设，如 danger-full-access（留空=宿主默认） |
| `adminWorkspacePath` | string | `""` | 管理员私聊的工作目录（私密记忆目录；留空=同 workspacePath）。群聊用 workspacePath，读不到这里的 AGENTS.md |
| `idleResetHours` | number | `0` | 超过这么多小时没说话，下一条消息开新会话，并附上最后几句作交接（0=关闭） |
| `publicMemoryFile` | string | `""` | qq_memory_note 工具追加的公开记忆文件（留空=不提供该工具） |
| `scheduledPrompts` | object[] | `[]` | 每天定时投递给指定会话的任务（写日记等）；time 为本地 HH:MM |
| `publicMemoryMaxBytes` | number | `6144` | 公开记忆文件达到这个大小（字节）后 qq_memory_note 不再追加 |
| `groupMemoryDir` | string | `""` | 每个群一份记忆的根目录；留空=所有群共用 publicMemoryFile |
| `groupMemoryMaxBytes` | number | `8192` | 每个群的记忆文件达到这个大小（字节）后 qq_memory_note 不再追加 |
| `privateResetDays` | number | `0` | 私聊会话跨过这么多个凌晨 4 点后，下一条消息开新会话（附交接；0=关闭） |
| `groupResetDays` | number | `0` | 群聊会话跨过这么多个凌晨 4 点后，下一条消息开新会话（附交接；0=关闭） |
| `proactiveEnabled` | boolean | `false` | 每天在时段内随机叫醒机器人几次，让它决定要不要主动找管理员 |
| `proactiveChatId` | string | `""` | 主动找的会话，如 private:<管理员QQ> |
| `proactiveWindowStart` | string | `"09:00"` | 主动聊天时段开始（本地 HH:MM） |
| `proactiveWindowEnd` | string | `"22:00"` | 主动聊天时段结束（本地 HH:MM） |
| `proactiveMinPerDay` | number | `4` | 每天最少叫醒几次 |
| `proactiveMaxPerDay` | number | `6` | 每天最多叫醒几次 |
| `proactiveMinGapMinutes` | number | `90` | 两次叫醒至少间隔多少分钟 |
| `proactiveSkipIfActiveMinutes` | number | `30` | 对方这么多分钟内说过话就跳过这次 |
| `proactiveMaxUnanswered` | number | `2` | 主动发的消息有这么多条没回，当天就不再叫醒 |
| `workspacePath` | string | `""` | QQ 会话的工作区目录（写入会话 cwd，并自动归入该工作区，不存在则创建）；留空时使用宿主进程工作目录并在启动时告警提醒（宿主未提供可编程查询的默认工作区），单聊 /workspace 覆盖优先且已持久化到会话映射文件，重启/恢复失败均不丢失 |
| `inboundFileMaxBytes` | number | `20971520` | QQ 入站文件最大字节数（直链/base64 拉取，0 = 不限制） |
| `maxInboundFileBytes` | number |  | [deprecated] 旧名别名（现 inboundFileMaxBytes）：QQ 入站文件最大字节数；本版兼容读取，新配置请用新名 |
| `allowPrivateHosts` | boolean | `false` | 下载 SSRF 防护逃生门：默认拒绝解析到私网/环回/链路本地地址的下载目标（协议仅 http/https、重定向逐跳复检仍生效）；NapCat 文件服务器或反代部署在本机/内网时置 true 跳过私网检查 |
| `chatIdleEvictDays` | number | `7` | 会话空闲淘汰天数：chat 超过该天数无任何活动时，在下一条入站消息处理前清理其 agent（会话先落盘 flush、映射保留，之后同一 chat 的消息可 resume 恢复原会话）；0 = 禁用 |
| `dedupWindowSeconds` | number | `300` | 入站消息去重窗口（秒）：同一会话内相同 message_id 在该窗口内重投（断线重连重放等）只处理第一条，后续静默跳过并记 debug；仅对会触发回复处理的消息事件生效（notice/meta 类不经过此闸）；0 = 禁用去重 |
| `actionRatePerMinute` | number | `20` | 主动写操作每分钟全桥合计上限：约束 qq_send_image/voice/video/file/segments 与 qq_send_forward 等工具发起的主动发送（回合内的被动回复/interim/通知不受此闸，由 rateLimitPerMinute 与离线队列上限约束）；超限拒发并记 warn 与审计；0 = 禁用分钟限额 |
| `actionRatePerDay` | number | `500` | 主动写操作每日（本地自然日）全桥合计上限：口径同 actionRatePerMinute；超限拒发并记 warn 与审计，次日自动恢复；0 = 禁用日限额 |
| `actionAuditEnabled` | boolean | `true` | 主动写审计：每次主动写（成功/失败）与拒发事件追加写一行 JSON 到 mediaDir/qq-actions.log（含 ts/chatId/action/ok/reason）；写失败仅 warn 不影响发送 |
| `traceEnabled` | boolean | `false` | 链路追踪：为每条入站消息生成 traceId 并贯穿入站→模型回合→出站，决策事件（含限流/去重/白名单/@ 门控/闸门拒发与每个静默丢弃分支的中文 reason）逐行 JSON 落盘 mediaDir/qq-trace.jsonl（4MiB 改名轮转，保留 qq-trace.1/2.jsonl；同一原因 5 分钟限频）；默认关闭——关闭时不生成 traceId、不落盘、决策行为与 0.6.0 完全一致 |
| `traceLevel` | "debug" / "warn" | `"debug"` | 追踪事件级别：debug=记录全部决策事件；warn=仅记录 ok:false（被拒/失败/丢弃）事件 |
| `logLevel` | "debug" / "info" / "warn" / "error" | `"info"` | 控制台日志级别门槛（debug < info < warn < error）：低于该级别的日志不输出。debug=全部输出（含「session 事件早退」等调试行）；info=常规信息（启动、连接建立、meta 事件等，默认）；warn=仅警告与错误；error=仅错误 |
