import type { SessionId } from '@deepseek-ai/dsh-session';
import { type ChatId } from './chat.js';
export declare const RETIRED_FILE = "retired-sessions.json";
export declare const SWITCHABLE_FILE = "switchable-sessions.json";
/** Most switch-back entries kept per chat. */
export declare const SWITCHABLE_CAP = 20;
/** One /session switch-back candidate. */
export interface SwitchableSession {
    id: string;
    /** When it was soft-retired (epoch ms). */
    retiredAt: number;
}
type Log = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
export declare class SessionLedger {
    private readonly log;
    private readonly retiredPath;
    private readonly switchablePath;
    private readonly retiredWriter;
    private readonly switchableWriter;
    /** Ids whose persisted logs are unusable (this run). */
    readonly broken: Set<string>;
    /** Every retired id (durable). */
    retired: Set<string>;
    private switchableByChat;
    constructor(options: {
        mediaDir: string;
        log: Log;
    });
    /** Whether a session id must never be created again (this run or on disk). */
    isBlocked(id: string): boolean;
    /** A suffixed session id for a chat that avoids every blocked id. */
    freshSessionId(chatId: ChatId): SessionId;
    /** Permanently retire a broken id (in memory and on disk). */
    retireBroken(id: string): void;
    /** Soft-retire an id (/new, retired groups): blocked from creates, still a
     * switch-back target. */
    softRetire(id: string): void;
    /** A switched-back session is live again: lift its retired mark so the
     * normal resume paths keep finding it. */
    unRetire(id: string): void;
    loadRetired(): Promise<void>;
    saveRetired(): Promise<void>;
    loadSwitchable(): Promise<void>;
    private saveSwitchable;
    /** The chat's switch-back candidates (a copy; newest first). */
    switchable(chatId: ChatId): SwitchableSession[];
    isSwitchable(chatId: ChatId, sessionId: string): boolean;
    /** Record a just-soft-retired session for its chat: deduped by id (a
     * re-retire refreshes it to the front), newest first, capped. */
    recordSwitchable(chatId: ChatId, sessionId: string): void;
    removeSwitchable(chatId: ChatId, sessionId: string): void;
}
export {};
