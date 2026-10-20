import type { Log } from './time.js';
/** First run this long after startup (the chat mapping is loaded by then). */
export declare const CLEANUP_FIRST_DELAY_MS: number;
/** Then every this often. */
export declare const CLEANUP_INTERVAL_MS: number;
export interface SessionCleanupOptions {
    /** dsh's sessions root: <dsh-home>/sessions/<cwd>/<session id>/. */
    sessionsRoot: string;
    /** dsh's projection cache: <dsh-home>/storages/session_projcache/sessions/<id>.json. */
    projectionCacheDir: string;
    /** Days without a write after which a private chat's session goes (0 = keep). */
    privateKeepDays: number;
    /** Same for group chats. */
    groupKeepDays: number;
    /** Session ids still in use (current or resumable chat sessions). */
    inUse: () => ReadonlySet<string>;
    /** Called after a session is deleted (drop it from switch-back lists). */
    onRemoved?: (sessionId: string) => void;
    log: Log;
    now?: () => number;
}
/** One cleanup pass. @returns how many sessions were deleted, by kind. */
export declare function pruneOldSessions(options: SessionCleanupOptions): Promise<{
    private: number;
    group: number;
}>;
/** Runs pruneOldSessions shortly after start, then periodically. */
export declare class SessionCleaner {
    private readonly options;
    private first;
    private timer;
    private running;
    constructor(options: SessionCleanupOptions);
    /** Whether any limit is set (nothing to schedule otherwise). */
    get enabled(): boolean;
    start(firstDelayMs?: number, intervalMs?: number): void;
    stop(): Promise<void>;
}
