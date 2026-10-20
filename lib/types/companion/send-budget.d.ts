/**
 * A bridge-wide send budget for the QQ account. QQ risk control looks at
 * how much and how fast an account sends; a companion that answers every
 * group @ with several split messages can reach hundreds of messages an hour.
 * Every outgoing message (replies, interim messages, notices, forwards)
 * takes one unit here first:
 *  - a minimum gap between two sends, account-wide;
 *  - a per-minute cap: over it, the send waits for the window;
 *  - per-hour / per-day caps: over them, the send is dropped — except for
 *    exempt chats (the admin's own private chat), which always go through
 *    (still spaced and minute-capped).
 * 0 disables a limit.
 * @module dsh-qq-companion/companion/send-budget
 */
import type { Log } from './time.js';
export interface SendBudgetConfig {
    minIntervalMs: number;
    perMinute: number;
    perHour: number;
    perDay: number;
}
export interface SendBudgetSnapshot {
    lastMinute: number;
    lastHour: number;
    today: number;
    dropped: number;
    limits: SendBudgetConfig;
}
export declare class SendBudget {
    private readonly config;
    private readonly isExempt;
    private readonly log;
    private readonly now;
    private readonly sleep;
    /** Send times within the last hour (minute/hour windows). */
    private recent;
    private day;
    private todayCount;
    private droppedCount;
    private lastSendAt;
    private chain;
    private warnedFor;
    constructor(options: {
        config: SendBudgetConfig;
        isExempt: (chatId: string) => boolean;
        log: Log;
        now?: () => number;
        sleep?: (ms: number) => Promise<void>;
    });
    /** Whether any limit is on. */
    get enabled(): boolean;
    /**
     * Take one send unit for `chatId`, waiting for the gap / minute window.
     * @returns false when the hour/day budget is spent (the caller drops the send).
     */
    acquire(chatId: string): Promise<boolean>;
    private take;
    snapshot(): SendBudgetSnapshot;
    private prune;
    private rollDay;
}
/**
 * Per-group reply cooldown: at most `maxTurns` member-started turns per
 * group within `windowMinutes`; the admin is never limited. 0 disables.
 */
export declare class GroupCooldown {
    private readonly maxTurns;
    private readonly windowMs;
    private readonly log;
    private readonly now;
    private readonly turns;
    private readonly noted;
    constructor(options: {
        maxTurns: number;
        windowMinutes: number;
        log: Log;
        now?: () => number;
    });
    /** Whether this member turn may run now (and count it if so). */
    allow(chatId: string, byAdmin: boolean): boolean;
}
