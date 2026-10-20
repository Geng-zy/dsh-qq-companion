import type { ChatActivity } from './activity.js';
import type { Log } from './time.js';
export interface ProactiveConfig {
    /** The chat she may reach out to (the owner's private chat). */
    chatId: string;
    /** Local window, HH:MM–HH:MM. */
    windowStart: string;
    windowEnd: string;
    /** Wake-ups per day, picked at random in [min, max]. */
    minPerDay: number;
    maxPerDay: number;
    /** Minimum minutes between two wake-ups. */
    minGapMinutes: number;
    /** Skip a wake-up when the owner wrote within this many minutes. */
    skipIfActiveMinutes: number;
    /** Stop for the day after this many unanswered proactive messages. */
    maxUnanswered: number;
}
/** The reply that means "nothing to say this time" — never sent to QQ. */
export declare const PROACTIVE_PASS = "[\u4E0D\u53D1]";
/** True when a final reply is the pass marker (whitespace / brackets tolerant). */
export declare function isProactivePass(text: string): boolean;
/**
 * Pick `count` minutes-of-day in [start, end) at least `gap` apart, at
 * random. Returns fewer when the window cannot fit them.
 */
export declare function pickCheckinTimes(start: number, end: number, count: number, gap: number, random?: () => number): number[];
/** Wakes her a few random times a day inside the window (see ProactiveConfig). */
export declare class ProactiveScheduler {
    private readonly config;
    private readonly fire;
    private readonly activity;
    private readonly log;
    private readonly now;
    private readonly random;
    private day;
    private plan;
    private timer;
    constructor(options: {
        config: ProactiveConfig;
        activity: ChatActivity;
        fire: (context: {
            time: string;
            unanswered: number;
            lastUserAt: number | undefined;
        }) => Promise<void>;
        log: Log;
        now?: () => number;
        random?: () => number;
    });
    start(intervalMs?: number): void;
    stop(): void;
    /** Today's remaining wake-up times as HH:MM (for /task listing). */
    remaining(): string[];
    /** Wake her right now (the /task checkin test hook): the hard rules
     * still apply except the time plan. */
    fireNow(): Promise<void>;
    /** One check (exported for tests). */
    tick(): Promise<void>;
    private ensurePlan;
}
