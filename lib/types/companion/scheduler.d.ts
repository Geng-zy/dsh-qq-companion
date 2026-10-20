import type { Log } from './time.js';
/** A prompt that was due while dsh was down fires late if it is at most
 * this many minutes overdue (a restart around 01:30 must not skip the diary). */
export declare const CATCH_UP_MINUTES = 180;
export interface ScheduledPrompt {
    /** Stable id (fired-day bookkeeping). */
    id: string;
    /** Local time HH:MM. */
    time: string;
    /** Target chat, e.g. private:123450001. */
    chatId: string;
    /** What the turn is told to do. */
    prompt: string;
    /** Append today's transcript excerpt of this chat (then clear it). */
    includeTodayLog?: boolean;
}
/**
 * Fires each prompt once per local day, at or after its HH:MM. With a state
 * file, "fired today" survives restarts and a prompt missed while dsh was
 * down fires late (within CATCH_UP_MINUTES); without one (or on the very
 * first boot) a time already past today is skipped.
 */
export declare class DailyScheduler {
    private readonly prompts;
    private readonly fire;
    private readonly log;
    private readonly now;
    private readonly fired;
    private timer;
    private readonly state;
    constructor(options: {
        prompts: readonly ScheduledPrompt[];
        fire: (prompt: ScheduledPrompt) => Promise<void>;
        log: Log;
        now?: () => number;
        stateFile?: string;
    });
    /** Restore "fired today" from the state file; a prompt that was due while
     * dsh was down (and not too long ago) becomes due again. */
    load(): Promise<void>;
    /** Mark prompts already past today as fired when `skip` says so. */
    private markPassed;
    /** Today's state of every prompt (for /doctor). */
    snapshot(): Array<{
        id: string;
        time: string;
        firedToday: boolean;
    }>;
    start(intervalMs?: number): void;
    stop(): void;
    /** One check (exported for tests). */
    tick(): Promise<void>;
    private minutesNow;
    private minutesOf;
}
