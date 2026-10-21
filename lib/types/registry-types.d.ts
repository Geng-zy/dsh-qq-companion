/**
 * Types and pure helpers of the chat registry: per-chat settings, the
 * chat-sessions.json entry format, the live ChatAgent shape, the recorded
 * preset lookup and the registry's dependencies.
 * @module dsh-qq-companion/registry-types
 */
import type { Agent, AgentRegistry, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatId, UserRole } from './chat.js';
import type { AgentPresetsLike, BridgeConfig, SessionPersistenceLike, WorkspaceRegistryLike } from './bridge.js';
/** The mapping file name inside the media dir. */
export declare const MAPPING_FILE = "chat-sessions.json";
/** The outcome of a /session switch attempt (the command layer phrases the
 * user-facing reply from `reason`; `message` carries the resume error text). */
export type SessionSwitchOutcome = {
    ok: true;
    sessionId: string;
} | {
    ok: false;
    reason: 'busy' | 'not-switchable' | 'broken' | 'resume-failed';
    message: string;
};
/** one pending serial-number selection snapshot — the numbered list a
 * bare /workspace|/model|/preset|/session rendered, kept per chat so a
 * following `/cmd <序号>` picks an entry without re-listing. `payload` stores the exact
 * resolved value (workspace path / provider id / preset id / switchable session
 * id; the model level-2 list stores the model id under `provider`). Single
 * shared slot: a fresh bare call of any kind overwrites it, other commands
 * never touch it; expiry is judged lazily at the next numeric reply (commands.ts
 * PENDING_SELECTION_TTL_MS) — no timer, and the field is never persisted. */
export interface PendingSelection {
    kind: 'workspace' | 'model' | 'preset' | 'session';
    /** /model only: 'providers' (level 1) or 'models' (level 2). */
    phase?: 'providers' | 'models';
    /** /model level 2: the provider the listed models belong to. */
    provider?: string;
    /** The numbered entries as displayed; payload is what a hit applies. */
    items: Array<{
        label: string;
        payload: string;
    }>;
    createdAt: number;
}
/** Per-chat settings that survive /new and collision heals:
 * resetChat and healSessionCollision never clear the entry, so every field
 * below keeps its value across session resets — exactly the pre-PR3 map
 * semantics. The entry is removed only by idle eviction. */
export interface ChatSettings {
    /** /workspace override (survives /new, so the next agent for the chat is
     * created under the new directory). */
    workspacePath?: string;
    /** /preset override (survives /new resets). */
    presetOverride?: string;
    /** /goal (reminds the model of the objective each turn). */
    goal?: string;
    /** pending serial-number selection snapshot (see PendingSelection);
     * ephemeral UI state — survives /new like every field here but never
     * persisted, and bounded by the lazy 5-minute TTL instead. */
    pendingSelection?: PendingSelection;
}
/** the persisted per-chat settings carried in one chat-sessions.json
 * entry (a bare session-id string when there are none). `workspacePath`
 * lets a per-chat /workspace override survive a restart even when the
 * session resume fails — loadMapping restores it BEFORE the resume attempt,
 * and the /workspace switch path flushes the mapping. */
export interface PersistedChatSettings {
    session: string;
    goal?: string;
    workspacePath?: string;
}
/** build one mapping entry — a bare session id when the chat carries no
 * persisted settings, else an object
 * with the optional mode/goal/workspace fields. An empty workspacePath counts
 * as unset (never persisted). */
export declare function persistEntry(sessionId: string, goal: string | undefined, workspacePath: string | undefined): string | PersistedChatSettings;
/** One live per-chat agent. */
export interface ChatAgent {
    chatId: ChatId;
    sessionId: SessionId;
    agent: Agent;
    dispose(): Promise<void>;
    /** last activity timestamp (creation, dispatchFollowup, turn events);
     * the idle sweep evicts chats idle longer than chatIdleEvictDays. */
    lastActivityAt: number;
    /** Text deferred one step in either outbound mode — proven interim by the
     * next assistant/message (flushed live), else the final at turn/end.
     * the former instant-mode-only pendingFinal folded in. */
    loopPending: string | null;
    /** Sent interim messages awaiting turn/end summary (text kept for the recap
     * t2i card). `sentAt` drives the per-message auto-recall scheduled after
     * each interim's send completes. */
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
    /** Per-interim 90s (config interimRecallMs) auto-recall timers, keyed by
     * message id; cleared when turn/end recalls the originals immediately. */
    recallTimers: Map<string, ReturnType<typeof setTimeout>>;
    /** Interim message ids already auto-revoked by their 90s timer during a long
     * turn — skipped by the turn/end immediate recall (already gone from QQ). */
    recalledInterimIds: Set<string>;
    /** Last assistant message id already handled — duplicate session events
     * (streaming/usage re-emits of the same message) must not re-send it. */
    lastHandledMessageId: string | undefined;
    /** Whether a turn is currently generating. */
    busy: boolean;
    /** dispatch timestamps of normal (non-command) messages inside the
     * current 60s sliding window (rateLimitPerMinute). */
    dispatchTimes: number[];
    /** when the last rate-limit notice was sent (at most one per window). */
    rateLimitNoticeAt: number | undefined;
    typingTimer: ReturnType<typeof setInterval> | undefined;
    lastNickname: string;
    /** Roles of dispatched turns not yet opened (FIFO, consumed at turn/start). */
    pendingTurnRoles: UserRole[];
    /** Role of the currently running turn; stays 'member' (fail-closed) until a
     * turn/start assigns the head of pendingTurnRoles. */
    activeTurnRole: UserRole;
    /** The last user message text actually fed to the agent (for /retry). */
    lastFollowup: string | undefined;
    /** Mutable per-agent model selection (installModelSelection-bound); the
     * /model command swaps `.current` for the next step. */
    selectionRef: ModelSelectionRef | undefined;
}
/** The preset id a session's own record names: newest logged selection, else the creation header. */
export declare function resolveRecordedPreset(inspection: {
    meta: {
        agentPreset?: string;
    };
    events: readonly {
        type?: string;
        data?: {
            agentPreset?: string;
        };
    }[];
}): string | undefined;
/** What the registry touches. Deliberately narrower than BridgeDeps: the
 * agent registry, the persistence/workspace/preset services, the config
 * subset the registry reads, and three bridge-owned hooks — the stop flag,
 * the typing-indicator teardown for a chat leaving the registry, and the
 * channel-scope installer (the qq_* tools call back into the bridge, so the
 * agent setup closure cannot be assembled without it). */
export interface RegistryDeps {
    agents: AgentRegistry;
    /** Durable session store: flushes a session before its chat is evicted. */
    sessions: SessionStore;
    sessionPersistence: SessionPersistenceLike | undefined;
    workspaceRegistry: WorkspaceRegistryLike | undefined;
    agentPresets: AgentPresetsLike | undefined;
    defaultModel: (() => ModelSelection | undefined) | undefined;
    /** The only config fields the registry reads. */
    config: Pick<BridgeConfig, 'mediaDir' | 'workspacePath' | 'adminWorkspacePath' | 'groupMemoryDir' | 'groupMemoryMaxBytes' | 'agentPreset' | 'adminPreset' | 'restrictedMemberPrefix' | 'maxImageBytes' | 'maxVoiceBytes' | 'maxFileBytes' | 'chatIdleEvictDays' | 'groupReasoningEffort'>;
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** Bridge stop flag (guards the resume loop). */
    isStopping(): boolean;
    /** Bridge-owned chat runtime teardown when a chat leaves the registry:
     * stop the typing indicator. Interim recall timers are cleared by the
     * registry itself (ChatAgent state). */
    onChatRemoved(chat: ChatAgent): void;
    /** Register the QQ platform prompt section + qq_* tools on a new agent's
     * own scope — bridge-owned because the tools call back into the bridge. */
    installChannelScope(agentCtx: Context, chatId: ChatId): void;
    /** whether a chat is an admin's private chat, which then
     * defaults to config.adminPreset. Absent = no admin defaults. */
    isAdminPrivate?(chatId: ChatId): boolean;
    /** runs once after a NEW session is registered (the bridge
     * applies the admin permission default here). Failures only log. */
    onSessionCreated?(chat: ChatAgent): Promise<void>;
}
