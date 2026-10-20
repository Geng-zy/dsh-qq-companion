/**
 * The narrow view of the bridge that slash-command handlers work through.
 * @module dsh-qq-companion/commands/types
 */
import type { ScheduledPrompt } from '../companion/index.js';
import type { GroupAccessLike } from '../groups.js';
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { OneBotConnection } from '../connection.js';
import { type ChatId, type UserRole } from '../chat.js';
import type { PendingSelection, SessionSwitchOutcome, SwitchableSession } from '../registry.js';
import type { AgentDefaultModelLike, AgentPresetsLike, BridgeConfig, BridgeDeps, LlmCatalogPort, SessionPersistenceLike, WorkspaceRegistryLike } from '../bridge.js';
import type { TraceStage } from '../trace.js';
/** Narrow view of a live chat the command handlers may read or mutate —
 * the structural subset of the bridge's internal ChatAgent that the
 * pre-split handlers actually touched. */
export interface CommandChatView {
    agent: Agent;
    sessionId: SessionId;
    busy: boolean;
    lastFollowup: string | undefined;
    lastNickname: string;
    loopPending: string | null;
    loopBuffer: Array<{
        id: string;
        text: string;
        sentAt: number;
    }>;
    selectionRef: ModelSelectionRef | undefined;
}
/** The bridge capabilities the command surface may touch. Deliberately
 * narrower than BridgeDeps: handlers get the outbound send path, the
 * per-chat state they already owned pre-split, and the few services they
 * call — never the agent registry, media store, or the policy allowlists
 * (the admin gate is answered by `isAdmin`, not by exposing `policy`). */
export interface CommandContext {
    /** Full outbound pipeline send (the commands' only reply path). */
    sendToChat(chatId: ChatId, text: string): Promise<string[]>;
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** runtime group allowlist (/group); absent = not enabled. */
    groupAccess?: GroupAccessLike;
    /** daily scheduled prompts (/task) and a run-now hook. */
    scheduledPrompts?(): readonly ScheduledPrompt[];
    fireScheduled?(prompt: ScheduledPrompt): Promise<void>;
    proactive?: {
        remaining(): string[];
        fireNow(): Promise<void>;
    };
    /** Router entry gate: the admin check against the policy allowlist. */
    isAdmin(userId: string): boolean;
    /** Live chat lookup / existence probe. */
    getChat(chatId: ChatId): CommandChatView | undefined;
    hasChat(chatId: ChatId): boolean;
    /** Registry capabilities the commands legitimately trigger. */
    resetChat(chatId: ChatId): Promise<void>;
    dispatchFollowup(chatId: ChatId, text: string, role: UserRole, nickname?: string): Promise<void>;
    /** /stop — 显式终止该聊天的超时补发跟踪（pending 条目转
     * cancelled，其他聊天不受影响）。无补发条目时为 no-op。 */
    stopDeferredTracking(chatId: ChatId): void;
    /** /steer — the bridge-owned steer core (agent.steer with the
     * producer-owned source kind; the createUserMessage write point stays in
     * bridge.ts). Returns false when the chat has no live agent. */
    steerRunningTurn(chatId: ChatId, text: string): boolean;
    /** Per-chat state readers/writers (the pre-split private maps). */
    effectiveCwd(chatId: ChatId): string;
    sessionIdFromMapping(chatId: ChatId): Promise<string | undefined>;
    resolvePresetId(chatId: ChatId): Promise<string | undefined>;
    setChatWorkspacePath(chatId: ChatId, path: string): void;
    presetOverride(chatId: ChatId): string | undefined;
    setPresetOverride(chatId: ChatId, id: string): void;
    hasPresetOverride(chatId: ChatId): boolean;
    goal(chatId: ChatId): string | undefined;
    setGoal(chatId: ChatId, value: string): void;
    deleteGoal(chatId: ChatId): void;
    /** per-chat pending serial-number selection snapshot (the numbered list
     * a bare /workspace|/model|/preset|/session rendered; lazy 5-min TTL, see below). */
    /** /session: this chat's switchable retired sessions (newest first). */
    switchableSessions(chatId: ChatId): SwitchableSession[];
    /** /session <序号>: switch the chat back to a listed session. */
    switchSession(chatId: ChatId, targetSessionId: string): Promise<SessionSwitchOutcome>;
    /** /session list previews: the persistence port each retired session's
     * first user input is cold-read through (read handle + small event prefix).
     * Absent = preview-less items. */
    sessionPersistence: SessionPersistenceLike | undefined;
    pendingSelection(chatId: ChatId): PendingSelection | undefined;
    setPendingSelection(chatId: ChatId, value: PendingSelection | undefined): void;
    /** Services (narrow slices of the bridge deps). */
    /** Live model catalog for /model (port; index.ts wires it over the
     * live llm service — commands never touch Context). */
    llmCatalog: LlmCatalogPort | undefined;
    workspaceRegistry: WorkspaceRegistryLike | undefined;
    agentDefaultModel: AgentDefaultModelLike | undefined;
    agentPresets: AgentPresetsLike | undefined;
    commands: BridgeDeps['commands'];
    connection: OneBotConnection;
    dshHome: string | undefined;
    /** /doctor: render the health summary (absent = the bridge has
     * no health wiring — the command replies with a hint instead). */
    healthReport?: (() => Promise<string>) | undefined;
    /** /doctor export: pack the redacted diagnostics archive,
     * returning its path. the optional trigger reference is stamped
     * into the archive file name (absent = the bridge's latest fault reference,
     * or a reference-free name when none was recorded). */
    exportDiagnostics?: ((triggerRef?: string) => Promise<string>) | undefined;
    /** command-plane failure reference entry (/retry dispatch throw).
     * Mints an MF- reference through the bridge (registry + trace + structured
     * log) and returns it for the ⚠️ notice tail. */
    reportFailure?: ((chatId: ChatId, stage: TraceStage, detail: string) => string) | undefined;
    /** The only config fields the commands read. */
    config: Pick<BridgeConfig, 'interimMessages' | 'maxImageBytes' | 'unknownCommand'>;
}
/** the sender identity the inbound pipeline already resolved for the
 * command message — threaded through tryHandleCommand so /steer can wrap its
 * argument in the same <user_message> boundary as every inbound payload
 *.
 * The nickname is the pre-sanitized value from inbound.ts; wrapUserMessage
 * re-sanitizes defensively. */
/** Who sent the command message. */
export interface CommandSender {
    userId: string;
    nickname: string;
}
