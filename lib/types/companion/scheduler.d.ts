import type { Log } from './time.js';
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
/** Fires each prompt once per local day, at or after its HH:MM. */
export declare class DailyScheduler {
    private readonly prompts;
    private readonly fire;
    private readonly log;
    private readonly now;
    private readonly fired;
    private timer;
    constructor(options: {
        prompts: readonly ScheduledPrompt[];
        fire: (prompt: ScheduledPrompt) => Promise<void>;
        log: Log;
        now?: () => number;
    });
    start(intervalMs?: number): void;
    stop(): void;
    /** One check (exported for tests). */
    tick(): Promise<void>;
    private minutesNow;
    private minutesOf;
}
