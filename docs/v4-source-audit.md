# Session v4 producer-owned source kind 审计收口（P0/T1）

- 基线：`742cdfe`（worktree `wt-t1-v4audit`，git 干净）
- 版本：dsh-onebot 0.8.1，engines.dsh `>=0.2.0-rc.1 <0.3.0-0`（另含 0.1.x 历史分支）
- 宿主实装（只读查阅）：`/vol2/@appdata/Harness/server/0.2.1-alpha.2/node_modules/@deepseek-ai/*`
- 方法：全仓 `grep` 形态扫描 + 宿主 `dsh-session-format-v3-to-v4` 源码行号取证 + 历史 `git log -S` 交叉验证；全程只读，零 src 改动
- 伴生回归测试：`tests/session-v4-persistence.spec.ts`

## 1. 总结论

**收敛，无缺口。** 全仓「经宿主 API 写会话 source」的形态只有两处，且同值：

| # | 写入点 | 形态 |
|---|--------|------|
| 1 | `src/bridge.ts:576` | `chat.agent.followup(createUserMessage({ content, source: { kind: 'plugin:dsh-onebot' } }))` |
| 2 | `src/bridge.ts:754` | `chat.agent.steer(createUserMessage({ content, source: { kind: 'plugin:dsh-onebot' } }))` |

机器可验证据：`grep -rn "source:" src/` 的命中中，除上述两行外仅有 4 类非会话命中——`src/t2i/measure.ts:22,35,42,57,150`（宽度来源 `WidthSource` 参数/注释）、`src/trace.ts:353` 与 `src/record.ts:298`（`// missing source: nothing to shift` 注释）、`src/commands.ts:830`（`isRealUserMessageSource` 的**只读**判定函数）。其余 `kind:` 命中均为 t2i parser/inbound 内部数据结构，与会话持久化无关。

> 行号同步（T9-C）：写点行号钉死于 T9 修复后实测（T2 重构 + T9-A/B 改动后）`:576`（`dispatchFollowup`）与 `:754`（`steerMessage` 内核）。

## 2. 宿主 v4 准入线（行号钉死，只读取证）

宿主 `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js`：

| 位置 | 事实 |
|------|------|
| `:124` `source(message)` | v4 原生准入：`source.kind` 必须是非空字符串，且 **`kind === 'plugin'`（retired 包装）直接 `SessionFormatError`** |
| `:142` `assertV4SourceRowAdmission(row)` | 对 `user/message`、`system/message`、`assistant/message`、`tool/result`、`agent/inbox/spliced`、`session/title-llm-request` 六类行做 producer 准入 |
| `:1107-1112` `assertV4RowAdmission` | 读侧汇聚点，内部调用 `assertV4SourceRowAdmission` |
| `:51` `RENAMED_PRODUCERS` / `:59` `RELEASED_SAME_NAME_PRODUCERS` | 两表均**不含** `dsh-onebot` |
| `:87-95` `producerKind(plugin, role)` | 因此历史 v3 行 `source: { kind: 'plugin', plugin: 'dsh-onebot' }` 映射为 **`plugin:dsh-onebot`** —— 与现行写入同值，跨代迁移不漂移 |

辅助事实：`dsh-llm` `createAssistantMessage`（`lib/index.js:75`）给 assistant 行打宿主自有 `kind: 'model'`——**最终回复是宿主管辖行，本插件的准入义务只覆盖插件自写的 user 行**；`assertV4SourceRowAdmission` 对非 `plugin` 的既有 kind（含 `model`、无 kind 的 provider/model source）放行。

## 3. 逐路径审计（≥7 条）

| 路径 | 证据（file:line） | 会话写入形态 | 结论 |
|------|------------------|--------------|------|
| ① 普通入站 dispatch | `src/bridge.ts:574-577`（`dispatchFollowup` → `chat.agent.followup(createUserMessage({…, source}))`） | 写 user/message 行，`kind: 'plugin:dsh-onebot'` | **收敛**（写入点 1） |
| ② steer 补递（语音转写插话） | `src/bridge.ts:752-755`（T2 起收敛为 `steerMessage` 内核，`steerTranscript`/'steer' 策略//steer 共用 → `chat.agent.steer(createUserMessage({…, source}))`） | 写 user/message 行，`kind: 'plugin:dsh-onebot'` | **收敛**（写入点 2） |
| ③ interim 中间消息 | `src/interim.ts` 全文（`onAssistantMessage`/`onTurnEnd` 仅**消费**会话事件 + 出站 send/recall）；`src/bridge.ts:922-983` 仅读事件路由 | 零写入；本回合唯一的插件行即 ① 的 dispatch 行 | **收敛**（经写入点 1） |
| ④ inject 注入 | `src/inject.ts:6`（喂入**真实入站管线** → 复用 ① 的 dispatch 写点）；出站拦截层只拦 `send_*` 动作（`src/bridge.ts:593-594` 簿记 `injectRoundByChat`，`src/inject.ts:240` 拦 outbound action） | 经写入点 1；拦截层不触会话 | **收敛** |
| ⑤ record 录制旁路 | `src/record.ts:269`（`appendFile` 只写 `mediaDir/qq-inbox.jsonl` 自有文件）；`src/record.ts:298` 无 source 写入 | 零宿主会话写入 | **收敛** |
| ⑥ replay 回放 | `src/replay.ts:158-159`（自建 fake agent，`followup` 只 push 内存数组）；`src/replay.ts:102-103` 只读 inbox 文件 | 零宿主会话写入 | **收敛** |
| ⑦ tools（qq_send 等） | `src/tools.ts:53,68`（只读 `exec.agent?.session.id`）；发送走 outbound 管线 | 零会话写入 | **收敛** |
| ⑧ card-relay 卡片转发 | `src/card-relay.ts:29,36`（走 `ctx.sendToChat` 出站） | 零会话写入 | **收敛** |
| ⑨ prompt 平台提示词 | `src/prompt.ts`（仅 system-prompt section 注册） | 零会话写入 | **收敛** |
| ⑩ 宿主转发命令（/plan、/permission） | `src/commands.ts:1056`、`src/commands.ts:1117`（`commands.execute(…)`） | 行由**宿主命令运行时**自写（宿主自有 source）；插件侧零写入，宿主准入由 §2 准入线把关 | **收敛**（插件无准入义务） |
| ⑪ registry / outbound / stt / t2i / media / trace / health | `src/registry.ts:635`（`sessions.flush` 仅持久化冲刷）；其余模块纯出站/旁路 | 零会话写入 | **收敛** |

## 4. 兼容性注记（engines 全范围）

- **0.2.0+（v4 准入线）**：`kind: 'plugin:dsh-onebot'` 为 producer-owned kind，`source()`/`assertV4SourceRowAdmission` 放行（§2）。写入点两处均在 3af11a7（「adapt to dsh 0.2.0 — producer-owned source kind」）完成迁移，`git show 3af11a7` 证实迁移前形态为 `source: { kind: 'plugin', plugin: 'dsh-onebot' }`。
- **0.1.x（v3 时代）历史行 → 0.2.0 升级迁移**：`rewriteV3MessageSource`（`lib/index.js:99-112`）对 retired `plugin` 包装经 `producerKind('dsh-onebot')` 映射为 `plugin:dsh-onebot`（§2，两排除表均不含本插件），对已是 `plugin:dsh-onebot` 的直通 kind 原样保留（`:115-121`，非 `plugin` kind 不改写）——两类历史形态迁移后同值，**不漂移**。
- 未来任何新增会话写入必须复用 `createUserMessage` + `source: { kind: 'plugin:dsh-onebot' }`；`tests/session-v4-persistence.spec.ts` 内置的 src 扫描断言会在出现第三处写入形态时失败报警。

## 5. 交付物与验证

- 本文档（审计收口）
- `tests/session-v4-persistence.spec.ts`：dispatch/interim 开关/steer 三路写入的 kind 断言、宿主转发命令（/permission、/plan）零插件写入断言、JSONL 持久化-重读-再写入循环 kind 不漂移、真实宿主 `assertV4RowAdmission` 准入正反例、src 扫描不变量
- 验证命令与退出码见任务板 T1 汇报（`npx tsc --noEmit`、`npx vitest run`）
