/**
 * The chat↔session registry: one live ChatAgent per QQ chat with the
 * chats/bySession dual index, the chat-sessions.json mapping (save, debounced
 * flush, restart resume, idle eviction), the per-chat settings that survive
 * /new, session switching, and the shared create/resume assembly behind
 * ensureChat/loadMapping. Retired ids and /session history are kept by the
 * SessionLedger (session-ledger.ts); types live in registry-types.ts.
 * @module dsh-qq-companion/registry
 */
import type { Agent, AgentSetup, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SessionReadHandleLike } from './bridge-types.js'
import type { ChatId } from './chat.js'
import { sessionIdForChat } from './chat.js'
import { ensureGroupMemory, groupMemoryPaths } from './companion/index.js'
import { describeError } from './errors.js'
import { SerialFileWriter } from './persist.js'
import { SessionLedger } from './session-ledger.js'
import type { SwitchableSession } from './session-ledger.js'

export * from './registry-types.js'
export type { SwitchableSession } from './session-ledger.js'
import { ChatAgent, ChatSettings, MAPPING_FILE, PersistedChatSettings, RegistryDeps, SessionSwitchOutcome, persistEntry, resolveRecordedPreset } from './registry-types.js'

/** File under mediaDir holding the per-chat /preset overrides. */
const PRESETS_FILE = 'preset-overrides.json'
type AgentHandle = { agent: Agent; dispose(): Promise<void> }

/**
 * The chat↔session registry: dual index, persistence pair, per-chat settings
 * and the shared create/resume assembly. Created by the ChatBridge
 * constructor; the bridge delegates its same-name registry methods here.
 */
export class ChatRegistry {
  private readonly deps: RegistryDeps
  /** Live chats by chat id. */
  readonly chats = new Map<ChatId, ChatAgent>()
  /** Reverse index: session id → chat id (routes session events to chats). */
  readonly bySession = new Map<string, ChatId>()
  /** Per-chat settings (workspace/preset/goal), lazy-created. */
  private readonly chatSettings = new Map<ChatId, ChatSettings>()
  /** Retired / broken session ids and the /session switch-back lists. */
  private readonly ledger: SessionLedger
  private mappingSaveTimer: ReturnType<typeof setTimeout> | undefined
  /** Resolves once the on-disk chat mapping has been loaded (wired by the bridge's start()). */
  mappingLoaded: Promise<void> = Promise.resolve()

  constructor(deps: RegistryDeps) {
    this.deps = deps
    this.ledger = new SessionLedger({ mediaDir: deps.config.mediaDir, log: (level, message) => deps.log(level, message) })
  }

  /** Every retired session id (the ledger's live set). */
  get retiredSessionIds(): Set<string> {
    return this.ledger.retired
  }

  /** Session ids some chat still uses: live chats, evicted-but-resumable
   * chats, and anything routed to a chat (never deleted by cleanup). */
  sessionIdsInUse(): Set<string> {
    const ids = new Set<string>(this.bySession.keys())
    for (const chat of this.chats.values()) ids.add(chat.sessionId)
    for (const evicted of this.evictedChats.values()) ids.add(evicted.session)
    return ids
  }

  /** A session's logs were deleted (old-session cleanup). */
  forgetSession(sessionId: string): void {
    this.ledger.forgetSession(sessionId)
  }

  /** Session ids whose logs are unusable (the ledger's live set). */
  get brokenSessions(): Set<string> {
    return this.ledger.broken
  }

  /** The (lazy-created) settings entry for one chat. */
  getSettings(chatId: ChatId): ChatSettings {
    let settings = this.chatSettings.get(chatId)
    if (settings === undefined) {
      settings = {}
      this.chatSettings.set(chatId, settings)
    }
    return settings
  }

  // ------------------------------------------------------------ chat lifecycle

  /** default-model wiring shared by the create and resume assembly paths
   * — agent options for the registry call plus the mutable per-agent
   * selection ref (undefined when the deployment has no default model). */
  private modelWiring(): { agentOptions: { provider?: string; model?: string }; selectionRef: ModelSelectionRef | undefined } {
    const selection = this.deps.defaultModel?.()
    const agentOptions: { provider?: string; model?: string } = {}
    if (selection !== undefined) {
      agentOptions.provider = selection.provider
      agentOptions.model = selection.model
    }
    const selectionRef = selection !== undefined
      ? { current: selection, assembled: undefined }
      : undefined
    return { agentOptions, selectionRef }
  }

  /** the AgentSetup closure shared by the create and resume assembly
   * paths. The only difference between the callers is the preset: a resumed
   * session rejoins the preset it recorded itself; a fresh create reuses the
   * config/default resolution already recorded in its header meta. */
  private buildSetup(selectionRef: ModelSelectionRef | undefined, recordedPreset?: string, expected?: { chatId: ChatId; presetId: string | undefined }): AgentSetup {
    return async agentCtx => {
      this.deps.installChannelScope(agentCtx)
      await this.joinPreset(agentCtx, recordedPreset, expected)
      if (selectionRef !== undefined) {
        installModelSelection(agentCtx, selectionRef)
      }
    }
  }

  /** the ChatAgent literal shared by the create and resume assembly
   * paths — every field starts at its neutral initial value. `nickname` is
   * the one deliberate divergence between the callers (create seeds it from
   * the inbound message, resume starts with ''). */
  private createChatAgent(
    chatId: ChatId,
    handle: AgentHandle,
    selectionRef: ModelSelectionRef | undefined,
    nickname: string,
  ): ChatAgent {
    return {
      chatId,
      sessionId: handle.agent.session.id,
      agent: handle.agent,
      dispose: () => handle.dispose(),
      lastActivityAt: Date.now(),
      loopPending: null,
      loopBuffer: [],
      recallTimers: new Map(),
      recalledInterimIds: new Set(),
      lastHandledMessageId: undefined,
      busy: false,
      dispatchTimes: [],
      rateLimitNoticeAt: undefined,
      typingTimer: undefined,
      lastNickname: nickname,
      pendingTurnRoles: [],
      activeTurnRole: 'member',
      lastFollowup: undefined,
      selectionRef,
    }
  }

  /** in-flight creates keyed by chat id — concurrent first messages for
   * one chat join a single create instead of racing (otherwise two dispatches
   * could both pass the empty-map check and agents.create ran twice with the
   * same derived session id; the second chats.set won and the first agent
   * leaked). */
  private readonly pendingCreates = new Map<ChatId, Promise<ChatAgent>>()

  /** chats evicted for idleness, kept resumable (chat id → last session
   * id plus the persisted-settings snapshot, since chatSettings is cleared
   * on eviction). NOT retired: saveMapping keeps writing them, so the mapping
   * file never drops an evicted chat and a later message resumes its session. */
  private readonly evictedChats = new Map<ChatId, PersistedChatSettings>()

  /** Get (or create) the agent for a chat. */
  async ensureChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    const existing = this.chats.get(chatId)
    if (existing !== undefined) return existing
    const pending = this.pendingCreates.get(chatId)
    if (pending !== undefined) return pending
    const creation = this.createChat(chatId, nickname)
    this.pendingCreates.set(chatId, creation)
    void creation.finally(() => {
      this.pendingCreates.delete(chatId)
    }).catch(() => undefined)
    return creation
  }

  private async createChat(chatId: ChatId, nickname: string): Promise<ChatAgent> {
    await this.mappingLoaded
    // a chat evicted for idleness resumes its recorded session instead
    // of forking a fresh one — the mapping entry was kept for exactly this.
    const evicted = this.evictedChats.get(chatId)
    if (evicted !== undefined) {
      if (this.ledger.isBlocked(evicted.session)) {
        // the snapshot records a retired session (resetChat keeps the
        // mapping entry as a settings carrier after /new or a /workspace
        // switch). Resuming it would resurrect retired history — skip the
        // resume, keep the settings, and fall through to a fresh create.
        this.restoreSettings(chatId, evicted)
        this.evictedChats.delete(chatId)
      } else {
        try {
          const resumed = await this.resumeChat(chatId, evicted.session)
          // the evicted chat's persisted mode/goal/workspace come back with it.
          this.restoreSettings(chatId, evicted)
          this.evictedChats.delete(chatId)
          return resumed
        } catch (error) {
          this.ledger.retireBroken(evicted.session)
          // mirror the blocked-snapshot fast path above — the failed
          // resume retires the session but must not lose the snapshot's
          // settings: restore them onto chatSettings so the fresh create
          // below keys them in (and, if that create also fails, saveMapping's
          // settings-only fallback keeps writing them under the derived bare id).
          this.restoreSettings(chatId, evicted)
          this.evictedChats.delete(chatId)
          this.deps.log('warn', 'resume of evicted session failed for ' + chatId + '; falling back to a fresh session: ' + describeError(error))
        }
      }
    }
    let sessionId = makeSessionId(sessionIdForChat(chatId))
    if (this.ledger.isBlocked(sessionId)) {
      sessionId = this.ledger.freshSessionId(chatId)
    } else if (await this.hasPersistedLog(sessionId)) {
      // The bare id still owns a stale on-disk log (e.g. the retired record
      // was lost in an earlier crash): reusing it would collide, so retire it
      // NOW and move to a suffixed id instead of failing the chat later.
      this.ledger.retireBroken(sessionId)
      sessionId = this.ledger.freshSessionId(chatId)
    }
    const { agentOptions, selectionRef } = this.modelWiring()
    const cwd = this.effectiveCwd(chatId)
    const groupRoot = this.deps.config.groupMemoryDir
    if (groupRoot !== undefined && groupRoot !== '' && chatId.startsWith('group:') && this.getSettings(chatId).workspacePath === undefined) {
      try {
        await ensureGroupMemory(groupRoot, chatId.slice('group:'.length), this.deps.config.groupMemoryMaxBytes)
      } catch (error) {
        this.deps.log('warn', '群记忆目录创建失败: ' + describeError(error))
      }
    }
    const presetId = await this.resolvePresetId(chatId)
    const meta: { cwd: string; agentPreset?: string } = { cwd }
    if (presetId !== undefined) meta.agentPreset = presetId
    // Mount the same preset the header records: without it joinPreset falls
    // back to config.agentPreset, so a /preset override was written to the
    // header but the agent still got the configured preset's tools.
    const setup = this.buildSetup(selectionRef, presetId)
    let handle: AgentHandle
    try {
      handle = await this.deps.agents.create({
        sessionId,
        meta,
        agentOptions,
        setup,
      })
    } catch (error) {
      // A stale or foreign persisted log under the same id blocks creation
      // (id collision). Recover with a fresh suffixed session id instead of
      // failing the chat.
      this.ledger.retireBroken(sessionId)
      const fallbackId = this.ledger.freshSessionId(chatId)
      this.deps.log('warn', 'agent create failed (' + describeError(error) + '); retrying with ' + fallbackId)
      handle = await this.deps.agents.create({
        sessionId: fallbackId,
        meta,
        agentOptions,
        setup,
      })
      this.deps.log('info', 'recovered with fresh session ' + fallbackId + ' for ' + chatId)
    }
    // The real session id is authoritative (the fallback path above creates a
    // different id than the one initially attempted); record it everywhere so
    // session events route to this chat and the mapping persists the truth.
    const actualSessionId = handle.agent.session.id
    await this.attachToWorkspace(actualSessionId, handle.agent.session.header?.cwd)
    const chat = this.createChatAgent(chatId, handle, selectionRef, nickname)
    await this.settle(handle)
    this.chats.set(chatId, chat)
    if (this.deps.onSessionCreated !== undefined) {
      try {
        await this.deps.onSessionCreated(chat)
      } catch (error) {
        this.deps.log('warn', 'session-created hook failed for ' + chatId + ': ' + describeError(error))
      }
    }
    this.bySession.set(actualSessionId, chatId)
    this.deps.log('info', 'agent created for ' + chatId + ' (session ' + actualSessionId + ')')
    void this.saveMapping()
    return chat
  }

  /** apply a persisted-settings snapshot (mode/goal/workspace override)
   * onto a chat's settings entry — used for mapping entries read from disk
   * and for the snapshots of evicted / reset chats. */
  private restoreSettings(chatId: ChatId, entry: Partial<PersistedChatSettings>): void {
    const settings = this.getSettings(chatId)
    if (typeof entry.goal === 'string' && entry.goal !== '') settings.goal = entry.goal
    if (typeof entry.workspacePath === 'string' && entry.workspacePath !== '') settings.workspacePath = entry.workspacePath
  }

  /** The persisted-settings snapshot of a chat under one session id: the
   * live settings win, `known` (an earlier snapshot) fills the gaps. */
  private settingsSnapshot(chatId: ChatId, session: string, known?: PersistedChatSettings): PersistedChatSettings {
    const live = this.chatSettings.get(chatId)
    return {
      session,
      goal: live?.goal ?? known?.goal,
      workspacePath: live?.workspacePath ?? known?.workspacePath,
    }
  }

  /** Wait for a fresh agent to settle; when that fails, dispose it (no
   * orphan agent) and rethrow the original error. */
  private async settle(handle: AgentHandle): Promise<void> {
    try {
      await handle.agent.whenIdle()
    } catch (error) {
      try {
        await handle.dispose()
      } catch {
        // the whenIdle failure is the cause; a dispose failure must not mask it
      }
      throw error
    }
  }

  /** Take a chat out of the live indexes: typing stopped, interim recall
   * timers cleared. The agent itself is disposed by the caller. */
  private detachChat(chat: ChatAgent): void {
    this.deps.onChatRemoved(chat)
    this.clearInterimTimers(chat)
    this.chats.delete(chat.chatId)
    this.bySession.delete(chat.sessionId)
  }

  /** Dispose a detached chat's agent; a failure only logs. */
  private async disposeChat(chat: ChatAgent, what: string): Promise<void> {
    try {
      await chat.dispose()
    } catch (error) {
      this.deps.log('warn', what + ' dispose failed: ' + describeError(error))
    }
  }

  /** Resume persisted chats from the mapping file (best-effort). */
  async loadMapping(): Promise<void> {
    try {
      const content = await readFile(this.mappingPath(), 'utf8')
      // additive format — a legacy entry is a bare session-id string; a
      // new entry is { session, goal?, workspacePath? } (an old file's
      // interimOverride, from the removed /mode, is ignored).
      const mapping = JSON.parse(content) as Record<string, string | PersistedChatSettings>
      this.deps.log('debug', 'mapping file has ' + Object.keys(mapping).length + ' chat(s)')
      for (const [chatId, entry] of Object.entries(mapping)) {
        const sessionId = typeof entry === 'string' ? entry : entry?.session
        if (typeof sessionId !== 'string' || sessionId === '') continue
        // Restore the persisted mode/goal/workspace override BEFORE the resume
        // attempt (old files carry neither — the settings then fall back to
        // their current defaults). restoring the override first closes the
        // hole where a failed resume (retire → fresh session) lost the
        // per-chat /workspace choice.
        if (typeof entry === 'object' && entry !== null) this.restoreSettings(chatId as ChatId, entry)
        // a durably retired session id (recorded by resetChat's settings
        // snapshot) must never be resumed — the entry only carries the
        // settings for the chat's NEXT session. Keep the object entry in
        // evictedChats so any mid-flight saveMapping
        // (stop(), another chat's createChat) still writes it — a
        // settings-only chat sits in neither chats nor evictedChats, and one
        // dropped save would erase workspacePath/goal from the file
        // before the next restart.
        if (this.ledger.retired.has(sessionId)) {
          this.deps.log('debug', 'skipping resume of retired session ' + sessionId + ' for ' + chatId + ' (settings only)')
          if (typeof entry === 'object' && entry !== null) this.evictedChats.set(chatId, entry)
          continue
        }
        this.deps.log('debug', 'attempting resume of ' + chatId + ' @ ' + sessionId)
        if (this.deps.isStopping()) return
        try {
          await this.resumeChat(chatId, sessionId)
        } catch (error) {
          this.ledger.retireBroken(sessionId)
          // mirror the retired-skip branch above — keep the object
          // entry in evictedChats as a settings carrier so any later
          // saveMapping keeps writing it (otherwise one dropped save erases
          // workspacePath/goal from the file before the next restart).
          if (typeof entry === 'object' && entry !== null) this.evictedChats.set(chatId, entry)
          this.deps.log('warn', 'resume failed for ' + chatId + ': ' + describeError(error))
        }
      }
    } catch {
      // No mapping file yet — fresh start.
    }
  }

  /** Resume one persisted chat from its recorded session id (shared by
   * loadMapping and the evicted-chat resume). */
  private async resumeChat(chatId: ChatId, sessionId: string): Promise<ChatAgent> {
    const { agentOptions, selectionRef } = this.modelWiring()
    const recordedPreset = await this.recordedPresetFor(makeSessionId(sessionId))
    // What this chat would get today (/preset override, admin default, config
    // default) — only a real difference from the recorded preset is reported.
    const expectedPreset = recordedPreset !== undefined ? await this.resolvePresetId(chatId) : undefined
    const handle = await this.deps.agents.resume({
      resumeSessionId: makeSessionId(sessionId),
      agentOptions,
      setup: this.buildSetup(selectionRef, recordedPreset, { chatId, presetId: expectedPreset }),
    })
    await this.attachToWorkspace(handle.agent.session.id, handle.agent.session.header?.cwd)
    // /workspace persistence across restarts: the per-chat override map is
    // in-memory only, but a session's cwd is frozen in its header. When the
    // resumed session's directory differs from what this chat would default
    // to now, restore it as the override so /workspace and future /new
    // sessions keep using it.
    const headerCwd = handle.agent.session.header?.cwd
    if (headerCwd !== undefined && headerCwd !== '' && headerCwd !== this.effectiveCwd()) {
      this.getSettings(chatId).workspacePath = headerCwd
      this.deps.log('debug', 'workspace override restored for ' + chatId + ': ' + headerCwd)
    }
    const chat = this.createChatAgent(chatId, handle, selectionRef, '')
    await this.settle(handle)
    this.chats.set(chatId, chat)
    this.bySession.set(handle.agent.session.id, chatId)
    return chat
  }

  private mappingPath(): string {
    return join(this.deps.config.mediaDir, MAPPING_FILE)
  }

  /** Make a just-set /workspace override durable even when the
   * chat is not live (before its first message, or after a failed resume).
   * saveMapping covers chats/evictedChats plus a settings-only
   * fallback, so the settings survive either way — the snapshot still pins
   * the chat's real mapping session id over the derived bare id. Snapshots
   * the chat into evictedChats under its mapping session id — or the derived bare id
   * when the chat never went live (the resume then fails harmlessly and a
   * fresh session is created with the settings intact). No-op for a live
   * chat: the normal save path covers it. */
  noteWorkspaceOverride(chatId: ChatId): void {
    if (this.chats.has(chatId)) return
    const workspacePath = this.chatSettings.get(chatId)?.workspacePath
    if (workspacePath === undefined || workspacePath === '') return
    const known = this.evictedChats.get(chatId)
    this.evictedChats.set(chatId, this.settingsSnapshot(chatId, known?.session ?? makeSessionId(sessionIdForChat(chatId)), known))
  }

  /** Lazily created serialized writers (deps are assigned in the constructor). */
  private writers: Partial<Record<'mapping' | 'presets', SerialFileWriter>> = {}
  private writer(kind: 'mapping' | 'presets'): SerialFileWriter {
    const path = kind === 'mapping' ? this.mappingPath() : this.presetsPath()
    return (this.writers[kind] ??= new SerialFileWriter(path, { label: kind + ' 状态文件', log: (level, message) => this.deps.log(level, message) }))
  }

  /**
   * Persist the chat↔session mapping. Saves are fire-and-forget from several
   * paths; they queue on one writer, each renders the mapping when it runs
   * (the last write is always the latest state), and the file is replaced
   * atomically (see persist.ts).
   */
  saveMapping(): Promise<void> {
    return this.writer('mapping').write(() => JSON.stringify(this.buildMapping(), null, 2))
  }

  private buildMapping(): Record<string, string | PersistedChatSettings> {
    const mapping: Record<string, string | PersistedChatSettings> = {}
    for (const [chatId, evicted] of this.evictedChats) {
      // prefer the live settings entry over the snapshot — later
      // /goal or /workspace changes on a not-yet-resumed chat must
      // reach the file (union semantics: a field kept in only one of the
      // two places still survives).
      const entry = this.settingsSnapshot(chatId, evicted.session, evicted)
      mapping[chatId] = persistEntry(entry.session, entry.goal, entry.workspacePath)
    }
    for (const chat of this.chats.values()) {
      const settings = this.chatSettings.get(chat.chatId)
      mapping[chat.chatId] = persistEntry(chat.sessionId, settings?.goal, settings?.workspacePath)
    }
    // a chat that sits in neither evictedChats nor chats but owns
    // persisted settings must not be dropped from the file by a save —
    // write it under the noteWorkspaceOverride-derived bare session id,
    // and only when it carries at least one persistable field (no empty
    // placeholder entries).
    for (const [chatId, settings] of this.chatSettings) {
      if (mapping[chatId] !== undefined) continue
      if (settings.goal === undefined && (settings.workspacePath === undefined || settings.workspacePath === '')) continue
      mapping[chatId] = persistEntry(makeSessionId(sessionIdForChat(chatId)), settings.goal, settings.workspacePath)
    }
    return mapping
  }

  saveMappingDebounced(): void {
    if (this.mappingSaveTimer !== undefined) clearTimeout(this.mappingSaveTimer)
    this.mappingSaveTimer = setTimeout(() => {
      this.mappingSaveTimer = undefined
      void this.saveMapping()
    }, 2_000).unref()
  }

  /** dispose chats whose last activity is older than chatIdleEvictDays
   * (0 disables; default 7). Called before each inbound message: the session
   * is flushed, the agent disposed, and the chat removed from
   * chats/bySession/settings — NOT retired, the mapping keeps the pair so a
   * later message (or a restart) resumes the same session. */
  async sweepIdleChats(): Promise<void> {
    const days = this.deps.config.chatIdleEvictDays ?? 7
    if (days <= 0 || this.deps.isStopping()) return
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    for (const [chatId, chat] of [...this.chats]) {
      if (chat.lastActivityAt > cutoff) continue
      await this.evictChat(chatId, chat)
    }
  }

  private async evictChat(chatId: ChatId, chat: ChatAgent): Promise<void> {
    // Only evict a session that is durably persisted; a failed flush keeps
    // the chat alive and the sweep retries on the next message.
    try {
      await this.deps.sessions.flush(chat.agent.session)
    } catch (error) {
      this.deps.log('warn', 'idle-evict flush failed for ' + chatId + ' (keeping the chat): ' + String(error))
      return
    }
    this.detachChat(chat)
    // snapshot the persisted settings before the eviction clears them,
    // so saveMapping keeps writing the chat's mode/goal/workspace override
    // while it is idle.
    this.evictedChats.set(chatId, this.settingsSnapshot(chatId, chat.sessionId))
    this.chatSettings.delete(chatId)
    await this.disposeChat(chat, 'idle-evict')
    this.deps.log('info', 'evicted idle chat ' + chatId + ' (session ' + chat.sessionId + ' kept resumable)')
  }

  // ------------------------------------------------------------ retired ids

  /** Whether the persistence layer already owns a durable log for this id —
   * true means reusing the id would collide (stale on-disk log or live entry).
   * A read failure counts as no log so the caller falls back to the normal
   * path rather than blocking an id on a transient error. */
  private async hasPersistedLog(id: SessionId): Promise<boolean> {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return false
    try {
      // 0.1.6 `stat` (the retired `inspect` no longer exists): a snapshot means
      // the id owns a durable log; missing or a read failure counts as no log.
      return (await persistence.stat(id)) !== undefined
    } catch {
      return false
    }
  }


  loadRetired(): Promise<void> {
    return this.ledger.loadRetired()
  }

  // ---------------------------------------------------- presets & switchable history

  private presetsPath(): string {
    return join(this.deps.config.mediaDir, PRESETS_FILE)
  }

  /** Set (or clear with '') a chat's /preset override and persist it, so the
   * choice survives restarts (it used to live in memory only). */
  setPresetOverride(chatId: ChatId, presetId: string): void {
    const settings = this.getSettings(chatId)
    if (presetId === '') delete settings.presetOverride
    else settings.presetOverride = presetId
    void this.writer('presets').write(() => {
      const out: Record<string, string> = {}
      for (const [id, chatSettings] of this.chatSettings) {
        if (chatSettings.presetOverride !== undefined && chatSettings.presetOverride !== '') out[id] = chatSettings.presetOverride
      }
      return JSON.stringify(out, null, 2)
    })
  }

  /** Restore persisted /preset overrides (missing / corrupt file = none). */
  async loadPresetOverrides(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.presetsPath(), 'utf8')) as Record<string, unknown>
      for (const [chatId, presetId] of Object.entries(raw)) {
        if (typeof presetId === 'string' && presetId !== '') this.getSettings(chatId as ChatId).presetOverride = presetId
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') this.deps.log('warn', 'preset-overrides 读取失败，忽略: ' + describeError(error))
    }
  }

  loadSwitchable(): Promise<void> {
    return this.ledger.loadSwitchable()
  }

  /** The chat's switchable retired sessions (a copy; newest first). */
  switchableSessions(chatId: ChatId): SwitchableSession[] {
    return this.ledger.switchable(chatId)
  }

  /**
   * /session <序号>: switch a chat back to one of its switchable (soft-retired)
   * sessions. Validation is per-chat (chat A's history is invisible to chat
   * B) and refuses broken ids. With a live chat the current session is
   * soft-retired into the list first (the retire half of resetChat — the
   * settings carrier included — so a failed resume still rebuilds cleanly);
   * with no live chat the switch is carried through evictedChats like
   * noteWorkspaceOverride. On success the target is un-retired and leaves the
   * list (it is the current session); on resume failure the target is
   * hard-retired, dropped from the list, and the chat falls back to a fresh
   * session on its next message — it never gets stuck.
   */
  async switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome> {
    const target = targetSessionId.trim()
    if (!this.ledger.isSwitchable(chatId, target)) {
      this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is not in the chat switchable list')
      return { ok: false, reason: 'not-switchable', message: '目标会话不在该 chat 的可切回列表中' }
    }
    if (this.ledger.broken.has(target)) {
      this.deps.log('warn', 'session switch rejected for ' + chatId + ': ' + target + ' is broken')
      return { ok: false, reason: 'broken', message: '目标会话已损坏' }
    }
    const chat = this.chats.get(chatId)
    if (chat !== undefined && chat.busy) {
      return { ok: false, reason: 'busy', message: '当前会话正在生成' }
    }
    if (chat !== undefined) {
      // The retire half of resetChat: keep the settings carrier, then retire
      // the live session as SOFT-retired (switchable, not broken) and record
      // it so the user can switch back later.
      this.snapshotRetainedSettings(chatId, chat.sessionId)
      this.detachChat(chat)
      this.ledger.softRetire(chat.sessionId)
      this.ledger.recordSwitchable(chatId, chat.sessionId)
      await this.disposeChat(chat, 'session switch')
    } else {
      // Chat not live (before its first message / after a failed resume):
      // carry the switch through the evictedChats carrier exactly like
      // noteWorkspaceOverride — saveMapping only writes chats/evictedChats,
      // and the next message's createChat resumes the (un-retired) target
      // from the carrier. On resume failure below the carrier points at the
      // hard-retired target, which the evicted branch skips into a fresh
      // create with the settings intact.
      this.evictedChats.set(chatId, this.settingsSnapshot(chatId, target, this.evictedChats.get(chatId)))
    }
    try {
      await this.resumeChat(chatId, target)
    } catch (error) {
      // The target's log is unusable: hard-retire it, drop it from the list
      // and let the chat rebuild on a fresh session (never stuck).
      this.ledger.retireBroken(target)
      this.ledger.removeSwitchable(chatId, target)
      void this.saveMapping()
      this.deps.log('warn', 'session switch resume failed for ' + chatId + ' -> ' + target + '; falling back to a fresh session: ' + describeError(error))
      return { ok: false, reason: 'resume-failed', message: describeError(error) }
    }
    this.ledger.unRetire(target)
    this.ledger.removeSwitchable(chatId, target)
    // The live (or just-resumed) chat owns the mapping entry now; drop any
    // stale carrier so it cannot shadow the fresh entry.
    this.evictedChats.delete(chatId)
    void this.saveMapping()
    this.deps.log('info', 'session switch for ' + chatId + ' -> ' + target)
    return { ok: true, sessionId: target }
  }

  /** carry the chat's persisted settings across a reset, a session
   * switch or a collision heal — snapshot them into evictedChats under the
   * (about-to-be-retired) session id, so the trailing saveMapping keeps the
   * entry instead of dropping the chat's workspace/goal on a restart.
   * Only persisted fields trigger the snapshot (a plain /new or heal drops
   * the entry); the recorded session id is retired by the caller, so the
   * carrier is never resumed. */
  private snapshotRetainedSettings(chatId: ChatId, sessionId: string): void {
    const settings = this.chatSettings.get(chatId)
    if (settings?.goal !== undefined || (settings?.workspacePath !== undefined && settings?.workspacePath !== '')) {
      this.evictedChats.set(chatId, this.settingsSnapshot(chatId, sessionId))
    }
  }

  /**
   * Recover from a session-log collision: the live session cannot append to
   * the mismatched on-disk log, so dispose the agent and rebuild the chat on
   * a fresh session id. The user is asked to resend.
   */
  async healSessionCollision(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat === undefined) return
    // same settings carrier as resetChat (see snapshotRetainedSettings).
    this.snapshotRetainedSettings(chatId, chat.sessionId)
    this.ledger.retireBroken(chat.sessionId)
    // The bare derived id shares the chat's stale log; retire it too so the
    // next ensureChat can never pick it again in this run OR after a restart.
    this.ledger.retireBroken(sessionIdForChat(chatId))
    this.detachChat(chat)
    await this.disposeChat(chat, 'collision heal')
    this.deps.log('warn', 'healed session collision for ' + chatId + '; a fresh session will be created on next message')
    void this.saveMapping()
  }

  // ------------------------------------------------------------ workspace & preset

  /**
   * Effective workspace directory for a chat's sessions: the per-chat
   * /workspace override when set, else the configured workspacePath, falling
   * back to the host process cwd.
   */
  effectiveCwd(chatId?: ChatId): string {
    if (chatId !== undefined) {
      const override = this.getSettings(chatId).workspacePath
      if (override !== undefined && override !== '') return override
    }
    // an admin's private chat gets its own cwd (the private
    // memory directory), so group sessions never load the private AGENTS.md.
    const adminCwd = this.deps.config.adminWorkspacePath
    if (chatId !== undefined && adminCwd !== undefined && adminCwd !== '' && this.deps.isAdminPrivate?.(chatId) === true) return adminCwd
    // each group gets its own memory directory as cwd, so it
    // loads the shared AGENTS.md above plus only its own group file.
    const groupRoot = this.deps.config.groupMemoryDir
    if (chatId !== undefined && groupRoot !== undefined && groupRoot !== '' && chatId.startsWith('group:')) {
      return groupMemoryPaths(groupRoot, chatId.slice('group:'.length)).dir
    }
    const configured = this.deps.config.workspacePath
    return configured !== undefined && configured !== '' ? configured : process.cwd()
  }

  /**
   * The preset id a NEW session records and joins: the configured id when set,
   * else the deployment default — the same resolution the Web surface applies,
   * so cross-channel sessions carry the same header fact. A roster that cannot
   * resolve the effective id leaves the header bare and the session uncomposed,
   * exactly like a failed mount.
   */
  async resolvePresetId(chatId: ChatId): Promise<string | undefined> {
    // A /preset override wins for this chat (survives /new, so the re-created
    // session registers the chosen preset in its header).
    const override = this.getSettings(chatId).presetOverride
    if (override !== undefined && override !== '') return override
    const presets = this.deps.agentPresets
    if (presets === undefined) return undefined
    // an admin's private chat defaults to adminPreset (the
    // override above still wins), so the choice survives restarts and /new.
    const adminPreset = this.deps.config.adminPreset
    const configured = adminPreset !== undefined && adminPreset !== '' && this.deps.isAdminPrivate?.(chatId) === true
      ? adminPreset
      : this.deps.config.agentPreset
    const wanted = configured !== undefined && configured !== '' ? configured : presets.defaultId
    try {
      const preset = await presets.resolve(wanted)
      return preset.id
    } catch (error) {
      this.deps.log('warn', 'agent preset resolve failed; session header records no preset: ' + describeError(error))
      return undefined
    }
  }

  /**
   * The preset id a persisted session recorded for itself (newest logged
   * selection wins, else the creation header), or undefined when it recorded
   * none or the record cannot be read — a legacy session resumes under the
   * config/default, preserving its original behavior.
   */
  private async recordedPresetFor(sessionId: SessionId): Promise<string | undefined> {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return undefined
    // 0.1.6 has no `inspect`: read the same record through open('read') — the
    // immutable header carries the creation preset, the full event log the
    // newest `agent-preset/selected`. The handle MUST close even on failure
    // (AsyncDisposable — a leaked read handle pins backend resources).
    let handle: SessionReadHandleLike | undefined
    try {
      handle = await persistence.open(sessionId, 'read')
      return resolveRecordedPreset({
        meta: { agentPreset: handle.header.agentPreset },
        events: (await handle.read()).events,
      })
    } catch (error) {
      this.deps.log('warn', 'preset record read failed for ' + sessionId + ' (falling back to config/default): ' + describeError(error))
      return undefined
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          // Best-effort teardown: the read outcome above already decided.
        }
      }
    }
  }

  /**
   * Join the QQ agent to the configured agent preset (the deployment default
   * when unset) so its tools/prompt sections/skill catalog resolve against the
   * preset composition instead of the empty global layer. `preferred` — the
   * preset the session itself recorded — overrides the config (its history was
   * produced under that composition; replaying it differently would break the
   * recorded tool calls); a conflicting config only logs. Best-effort: a
   * broken preset falls back to the previous behavior rather than failing the
   * chat.
   */
  private async joinPreset(agentCtx: unknown, preferred?: string, expected?: { chatId: ChatId; presetId: string | undefined }): Promise<void> {
    if (this.deps.agentPresets === undefined) return
    const configured = this.deps.config.agentPreset
    // Compare against what THIS chat should use now (an admin's private chat
    // uses adminPreset, a /preset override wins), not the global default.
    if (preferred !== undefined && expected?.presetId !== undefined && expected.presetId !== preferred) {
      this.deps.log('warn', '会话 ' + expected.chatId + ' 记录的预设是 ' + preferred + '，按现在的配置应该用 ' + expected.presetId + '；先按记录的预设恢复，在这个会话里发 /new 就会换成 ' + expected.presetId)
    }
    const selected = preferred ?? (configured !== undefined && configured !== '' ? configured : undefined)
    try {
      const preset = await this.deps.agentPresets.mount(agentCtx, selected)
      this.deps.log('debug', 'agent joined preset ' + preset.id)
    } catch (error) {
      this.deps.log('warn', 'agent preset mount failed (tools fall back to the global layer): ' + describeError(error))
    }
  }

  /**
   * Attach a chat session to the workspace owning its header cwd, so QQ
   * sessions group under a workspace in the GUI instead of "Ungrouped".
   * Best-effort: failure only logs.
   *
   * A workspace is auto-created only when the session cwd matches the
   * configured workspacePath (new sessions). A resumed session carrying a
   * foreign cwd (e.g. created under an earlier host cwd) is attached only when
   * a workspace already owns that path — never auto-created, so legacy
   * sessions cannot spawn accidental workspaces.
   */
  private async attachToWorkspace(sessionId: string, headerCwd: string | undefined): Promise<void> {
    const registry = this.deps.workspaceRegistry
    if (registry === undefined) return
    try {
      if (headerCwd === undefined || headerCwd === '') {
        this.deps.log('warn', 'workspace attach skipped: session header carries no cwd')
        return
      }
      const workspace = await registry.resolveByPath(headerCwd)
      if (workspace === undefined) {
        if (headerCwd !== this.effectiveCwd()) {
          this.deps.log('debug', 'workspace attach skipped: no workspace owns ' + headerCwd + ' and it differs from the configured workspacePath')
          return
        }
        const created = await registry.create(headerCwd)
        this.deps.log('info', 'created workspace for ' + headerCwd)
        await created.attachSession(sessionId)
        this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd)
        return
      }
      await workspace.attachSession(sessionId)
      this.deps.log('info', 'attached session ' + sessionId + ' to workspace ' + headerCwd)
    } catch (error) {
      this.deps.log('warn', 'workspace attach failed for ' + sessionId + ': ' + describeError(error))
    }
  }

  /**
   * /new: dispose the current chat agent and retire its session id, so the
   * next inbound message creates a brand-new session (fresh history; the old
   * conversation stays on disk). The chat's settings (workspace/preset/
   * goal) all survive — they key the NEXT session of this chat.
   */
  async resetChat(chatId: ChatId): Promise<void> {
    const chat = this.chats.get(chatId)
    if (chat !== undefined) {
      // keep the mapping entry alive across the reset (see
      // snapshotRetainedSettings). The retired session id is never resumed:
      // createChat skips blocked snapshots and loadMapping skips durably
      // retired ids.
      this.snapshotRetainedSettings(chatId, chat.sessionId)
      this.detachChat(chat)
      // SOFT retire (not brokenSessions): the old session's history is
      // intact, and /session must keep it switchable — the durable retired
      // record still keeps the id out of every create path (blocked union).
      this.ledger.softRetire(chat.sessionId)
      this.ledger.recordSwitchable(chatId, chat.sessionId)
      // The bare derived id is forever unsafe for this chat once its history
      // has moved to a suffixed id: its on-disk log (if any) would collide
      // with any future bare-id session. Retire it up front so a /new after a
      // restart — when only the retired file protects us — stays safe.
      // Skipped when it IS the current session (a first-generation /new): the
      // soft retire above already covers it, and a hard retire would mark the
      // chat's own first session broken and un-switchable for /session.
      const bareId = sessionIdForChat(chatId)
      if (bareId !== chat.sessionId) this.ledger.retireBroken(bareId)
      await this.disposeChat(chat, 'reset')
      this.deps.log('info', 'reset chat ' + chatId + ' (old session ' + chat.sessionId + ' retired)')
    }
    void this.saveMapping()
  }

  /** Every chat with a session: live ones and idle-evicted ones. */
  knownChatIds(): ChatId[] {
    return [...new Set([...this.chats.keys(), ...this.evictedChats.keys()])]
  }

  /**
   * Retire a chat's session for good (e.g. a group that left the allowlist):
   * a live chat is reset like /new; an idle-evicted one has its recorded
   * session retired so it is never resumed. Either way the next message
   * starts a fresh session (with the current preset). History stays on disk.
   * @returns whether there was a session to retire.
   */
  async retireChat(chatId: ChatId): Promise<boolean> {
    if (this.chats.has(chatId)) {
      await this.resetChat(chatId)
      return true
    }
    const evicted = this.evictedChats.get(chatId)
    if (evicted === undefined) return false
    this.ledger.softRetire(evicted.session)
    this.ledger.recordSwitchable(chatId, evicted.session)
    this.evictedChats.delete(chatId)
    void this.saveMapping()
    this.deps.log('info', 'retired idle chat ' + chatId + ' (session ' + evicted.session + ')')
    return true
  }

  /** Read the chat→session mapping file (for /id and /status when no live chat). */
  async sessionIdFromMapping(chatId: ChatId): Promise<string | undefined> {
    try {
      const text = await readFile(this.mappingPath(), 'utf8')
      const map = JSON.parse(text) as Record<string, string | PersistedChatSettings>
      const entry = map[chatId]
      const id = typeof entry === 'string' ? entry : entry?.session
      return typeof id === 'string' && id !== '' ? id : undefined
    } catch {
      return undefined
    }
  }

  /** Clear every pending interim auto-recall timer for a chat (dispose path). */
  private clearInterimTimers(chat: ChatAgent): void {
    for (const timer of chat.recallTimers.values()) clearTimeout(timer)
    chat.recallTimers.clear()
  }

  /** Stop everything registry-owned: cancel the debounce timer, save the
   * mapping, dispose every agent, clear both indexes. */
  async stop(): Promise<void> {
    if (this.mappingSaveTimer !== undefined) {
      clearTimeout(this.mappingSaveTimer)
      this.mappingSaveTimer = undefined
    }
    await this.saveMapping()
    for (const chat of [...this.chats.values()]) {
      this.detachChat(chat)
      await this.disposeChat(chat, 'agent')
    }
  }
}
