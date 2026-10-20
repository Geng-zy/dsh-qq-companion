/**
 * Types of the chat bridge: its resolved configuration, the narrow host
 * service ports it uses (agent presets, session persistence, workspaces,
 * model catalog, session events) and its constructor dependencies.
 * @module dsh-qq-companion/bridge-types
 */
import type { AgentRegistry, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmModelInfo, LlmProviderInfo } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'

import type { AccessPolicyConfig } from './chat.js'
import type { ChatActivity, ScheduledPrompt, StickerLibrary } from './companion/index.js'
import type { OneBotConnection } from './connection.js'
import type { GroupAccessLike } from './groups.js'
import type { MediaStore } from './media.js'
import type { Transcriber } from './stt.js'
import type { TraceSink } from './trace.js'

/** Resolved runtime configuration for the bridge. */
export interface BridgeConfig {
  botQQ: string
  ignoreSelf: boolean
  requireMention: boolean
  /** Unknown slash-command handling: 'intercept' (default) consumes the
   * message with a closest-match suggestion or a hint; 'passthrough' restores
   * the old fall-through to the model. */
  unknownCommand?: 'intercept' | 'passthrough'
  interimMessages: boolean
  /** Per-interim auto-recall delay (ms) from each interim's send completion
   * while the turn is still running (QQ recall window ~2 min); absent → 90s.
   * At turn/end the remaining originals are recalled immediately regardless. */
  interimRecallMs?: number
  /** degrade switch: false = send-only interims — no auto-recall
   * timers, no turn/end immediate recall and no summary card (the turn ends
   * with the final text only). Absent/true = the full recall behavior. */
  interimRecall?: boolean
  sendErrorNotice: boolean
  /** per-chat per-minute sliding-window cap for normal (non-command)
   * messages; absent → 30, 0 disables. */
  rateLimitPerMinute?: number
  restrictedMemberPrefix: boolean
  sensitivePatterns: readonly string[]
  mediaDir: string
  maxImageBytes: number
  maxVoiceBytes: number
  maxFileBytes: number
  textImageThreshold: number
  cardFooter: string
  /** split model final replies "one line, one message". */
  splitLines?: boolean
  splitMaxMessages?: number
  /** false = one message per reply in groups (fewer sends, less risk control). */
  groupSplitLines?: boolean
  /** every outgoing message waits its typing time (see TypingPacer). */
  humanTypingPace?: boolean
  typingDelayPerCharMs?: number
  typingDelayMinMs?: number
  typingDelayMaxMs?: number
  fontFiles: readonly string[]
  fontFamilies: readonly string[]
  agentPreset: string
  /** preset an admin's private chat defaults to ('' = off). */
  adminPreset?: string
  /** host permission preset applied to each NEW admin private
   * session, e.g. 'danger-full-access' ('' = leave the host default). */
  adminPermission?: string
  /** cwd of an admin's private chat ('' = workspacePath). */
  adminWorkspacePath?: string
  /** hours of silence after which the next message starts a
   * fresh session with a short recap of the last lines (0 = off). */
  idleResetHours?: number
  /** public memory file qq_memory_note appends to ('' = no tool). */
  publicMemoryFile?: string
  /** How the companion refers to the admin in system prompts and notices
   * (e.g. 主人); default 管理员. */
  ownerTitle?: string
  /** public memory size cap for qq_memory_note (bytes). */
  publicMemoryMaxBytes?: number
  /** per-group memory root; '' = shared. */
  groupMemoryDir?: string
  /** per-group memory size cap (bytes). */
  groupMemoryMaxBytes?: number
  /** start a fresh session once the current one has crossed
   * this many 04:00 day boundaries (0 = off). */
  privateResetDays?: number
  groupResetDays?: number
  /** the daily scheduled prompts (for /task listing / run-now). */
  scheduledPrompts?: readonly ScheduledPrompt[]
  workspacePath: string
  /** Max inbound file bytes fetched via QQ direct link / base64 (0 = no cap). */
  maxInboundFileBytes: number
  /** chats idle longer than this many days are evicted on the next
   * inbound message (0 disables; default 7). Evicted chats keep their
   * chat→session mapping, so a later message resumes the same session. */
  chatIdleEvictDays?: number
  /** how a new ordinary message is handled while the chat's task
   * (agent turn) is running; absent → 'queue' (the default). 'queue' = the
   * message is dispatched normally (agent.followup queues it as the
   * next turn — consumed AFTER the current turn ends, in arrival order) and
   * the chat gets at most one queue notice per running turn; 'steer' = plain
   * text (no media/quote/forward, non-restricted senders) is submitted as a
   * supplementary instruction into the running turn via the same
   * agent.steer kernel as /steer, with a per-message submit notice. */
  newMessagePolicy?: 'queue' | 'steer'
  /** steer 模式下自动插话的发送者资格档位；
   * absent → 'admin'（缺省）。'admin' = 仅管理员可自动插话；'all' = 所有
   * 非受限发送者均可。不改变 /steer 命令（始终仅管理员）与 queue 模式行为，
   * 也不放宽受限用户软限制（受限消息任何档都排队）。 */
  autoSteerPolicy?: 'admin' | 'all'
  /** 等待模型回复超时阈值（ms）——回合超过该时长没有任何模型输出
   * 时提示超时并登记补发跟踪（deferred delivery），回合完成后向原聊天补发
   * 最终文字（「（超时补发）」前缀，走既有 outbound 管线）；absent →
   * 600000（保守 10 分钟），0 = 关闭超时补发。 */
  deferredTimeoutMs?: number
  /** inbound (chatId, message_id) dedup window in seconds; absent → 300, 0 disables. */
  dedupWindowSeconds?: number
  /** tool-send audit (mediaDir/qq-actions.log); absent → on. */
  actionAuditEnabled?: boolean
  /** decision-trace sink; absent/disabled = no traceIds, no jsonl. */
  trace?: TraceSink | undefined
}

/** Agent-preset service (dsh-agent-presets): joins agents to a preset composition. */
export interface AgentPresetsLike {
  /** The preset id a new session gets when none is named (deployment default). */
  readonly defaultId: string
  /** Resolve one preset by id (undefined = default); throws when no root supplies it. */
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<{ id: string }>
}

/** Structural slice of one logged session event the /session preview reads
 * — only the preview's fields are named, and the host's SessionEvent (whose
 * 'user/message' payload is a UserMessage) satisfies it. */
export interface SessionPreviewEvent {
  type?: string
  data?: {
    agentPreset?: string
    source?: { kind?: string }
    content?: readonly { type?: string; text?: string }[]
  }
}

/** Narrowed read handle over one stored session (dsh-session-persistence's
 * `SessionHandle` from `open(id, 'read')`): the /session preview reads the
 * immutable header plus a small event prefix and then MUST close the handle
 * (AsyncDisposable — a leaked read handle pins backend resources). */
export interface SessionReadHandleLike {
  readonly header: { createdAt?: number; agentPreset?: string }
  read(offset?: number, length?: number): Promise<{ events: readonly SessionPreviewEvent[] }>
  close(): Promise<void>
}

/** Durable session persistence (dsh-session-persistence): cold-read what a session recorded. */
export interface SessionPersistenceLike {
  /** Existence probe (dsh-session-persistence 0.1.6 `stat`): resolves the
   * stored snapshot, or undefined when the id owns no durable log. Replaces
   * the retired host `inspect` convenience. */
  stat(id: SessionId): Promise<object | undefined>
  /** Open an existing stored session for reading: 'read' never takes write
   * ownership and works while a live writer holds the session. */
  open(id: SessionId, access: 'read'): Promise<SessionReadHandleLike>
}

/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceLike {
  id: string
  path: string
  sessionIds: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

/** Workspace registry (dsh-workspace): durable workspace membership. */
export interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  create(path: string, title?: string): Promise<WorkspaceLike>
  list(): WorkspaceLike[]
}

/** Default model service (dsh-agent-default-model): read/save the default selection. */
export interface AgentDefaultModelLike {
  currentSelection(): ModelSelection | undefined
  saveSelection(next: ModelSelection): Promise<void>
}

/** Live model-catalog port: the only llm surface the command domain
 * reads (/model). index.ts implements it over a live llm-service lookup so
 * late-registered providers stay visible; commands never touch Context. */
export interface LlmCatalogPort {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
}

/** Session-event feed port: the narrowed event-bus surface the bridge
 * subscribes to, replacing the whole-plugin Context. index.ts satisfies it
 * with the host context itself (its event-bus `on` IS the implementation); the
 * BridgeDeps field keeps the historical name `ctx` because existing test
 * assemblies pass the host context directly. */
export interface SessionEventPort {
  on(type: 'session/event', handler: (session: Session, event: SessionEvent) => void): () => void
  on(type: 'session/flush', handler: (session: Session) => void): () => void
}

/** Services the bridge needs (the plugin Context enters only through
 * the two explicit ports below — session events and the /model catalog). */
export interface BridgeDeps {
  ctx: SessionEventPort
  /** runtime group allowlist for /group (absent = disabled). */
  groupAccess?: GroupAccessLike
  /** Companion lines for /doctor (liveness, plans, memory sizes). */
  companionStatus?: () => Promise<string[]>
  /** Counts every message that went out (for /doctor). */
  sendCounter?: { record(): void }
  /** The account-wide typing pacer (absent = the outbound pipeline builds one). */
  typingPacer?: { wait(text: string): Promise<void> }
  /** per-chat activity (idle reset, handoff recap, diary input). */
  activity?: ChatActivity
  /** Her sticker library (absent = no sticker tools). */
  stickers?: StickerLibrary
  /** proactive wake-ups (for /task listing and run-now). */
  proactive?: { remaining(): string[]; fireNow(): Promise<void> }
  /** Resolves once the host's boot-time configuration (the loader service) is
   * fully applied; index.ts owns the 'loader' lookup and swallows its errors.
   * Absent in test assemblies = no gate (matches the previously swallowed
   * lookup). Must not reject. */
  hostReady?: (() => Promise<void>) | undefined
  /** Live model-catalog port for /model; index.ts implements it over
   * the live llm service. Absent only in assemblies that never route /model. */
  llmCatalog?: LlmCatalogPort | undefined
  connection: OneBotConnection
  /** The dsh data home (default <home>/.dsh); used to enumerate agent presets. */
  dshHome?: string | undefined
  media: MediaStore
  transcriber: Transcriber
  agents: AgentRegistry
  sessions: SessionStore
  agentPresets: AgentPresetsLike | undefined
  /** Host command runtime: forwards /plan and /permission so QQ reaches the
   * native commands. dsh ≥0.1.5-rc.1: `submittedAttachments` (always pass an
   * empty array) and `signal` are both REQUIRED (the host reads `.length` /
   * `.aborted` unconditionally); the settled return is the
   * `{ commandId, result: { kind, text } }` wrapper (older hosts: flat). */
  commands?: { execute(agent: unknown, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<{ kind?: string; text?: string; result?: { kind?: string; text?: string } }> } | undefined
  /** Durable persistence for cold reads: the recorded preset at resume and
   * the /session list's per-item content previews; absent = config/default
   * fallback and preview-less list items. */
  sessionPersistence: SessionPersistenceLike | undefined
  workspaceRegistry: WorkspaceRegistryLike | undefined
  agentDefaultModel: AgentDefaultModelLike | undefined
  defaultModel: (() => ModelSelection | undefined) | undefined
  config: BridgeConfig
  policy: AccessPolicyConfig
  /** health: the ALREADY-redacted plugin config snapshot (secrets
   * replaced by 已配置/未配置 — see health.redactSnapshot). Absent = the
   * /healthcheck diagnostics export renders without a config section. */
  configSnapshot?: (() => Record<string, unknown>) | undefined
  /** Log line callback (level, message). */
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
}
