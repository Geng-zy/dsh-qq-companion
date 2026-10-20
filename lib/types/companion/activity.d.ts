import type { Log } from './time.js';
/** Activity file name, under mediaDir. */
export declare const CHAT_ACTIVITY_FILE = "chat-activity.json";
/** Lines kept for the idle-reset handoff recap. */
export declare const HANDOFF_LINES = 8;
/** Characters kept per handoff / today line. */
export declare const LINE_MAX_CHARS = 200;
/** Lines kept in today's excerpt per chat (the diary input). */
export declare const TODAY_MAX_LINES = 200;
/** Lines per group in the nightly group excerpt (keeps the diary turn cheap). */
export declare const GROUP_TODAY_MAX_LINES = 80;
export interface ActivityLine {
    /** Epoch ms. */
    t: number;
    who: 'user' | 'bot';
    /** Sender label for user lines (nickname), empty for the bot. */
    name?: string;
    text: string;
}
export declare class ChatActivity {
    private readonly file;
    private readonly log;
    private readonly now;
    private chats;
    private saveTimer;
    private saveChain;
    private readonly writer;
    constructor(options: {
        mediaDir: string;
        log: Log;
        now?: () => number;
    });
    load(): Promise<void>;
    /** Last user activity time for a chat (undefined = never seen). */
    lastAt(chatId: string): number | undefined;
    /** Whether the chat has been idle longer than `hours` (never-seen = no). */
    isIdle(chatId: string, hours: number): boolean;
    /** Record one line. User lines also move the idle clock. */
    record(chatId: string, who: 'user' | 'bot', text: string, name?: string): void;
    /** Mark that the chat's session starts now (/new, idle or age reset). */
    markSessionStart(chatId: string): void;
    /** How many 04:00 day boundaries the current session has crossed
     * (0 = started today; never-seen chats = 0). */
    sessionDaysCrossed(chatId: string): number;
    /** How many of her replies came after the chat's last user line (an
     * unanswered proactive message makes this ≥ 2). */
    botLinesSinceUser(chatId: string): number;
    /** The handoff recap text for a fresh session ('' = nothing to hand off). */
    handoff(chatId: string): string;
    /** Today's excerpt for a chat (diary input), then optionally cleared. */
    takeToday(chatId: string, clear: boolean): ActivityLine[];
    /** Today's excerpt of every group chat that has one (diary input), each
     * trimmed to its last `maxLines`, then optionally cleared. */
    takeTodayGroups(maxLines: number, clear: boolean): Array<{
        chatId: string;
        lines: ActivityLine[];
    }>;
    /** Flush pending writes (stop / tests). */
    flush(): Promise<void>;
    private scheduleSave;
    private writeNow;
}
/** Format today's excerpt for the diary prompt. */
export declare function formatTranscript(lines: readonly ActivityLine[]): string;
