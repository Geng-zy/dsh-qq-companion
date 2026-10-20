/** Typing speed defaults (milliseconds), the same as the config schema's. */
export declare const DEFAULT_TYPING_DELAY_PER_CHAR_MS = 80;
export declare const DEFAULT_TYPING_DELAY_MIN_MS = 500;
export declare const DEFAULT_TYPING_DELAY_MAX_MS = 2500;
export interface TypingPaceConfig {
    perCharMs: number;
    minMs: number;
    maxMs: number;
}
export declare class TypingPacer {
    private readonly config;
    private readonly now;
    private readonly sleep;
    private lastSendAt;
    private chain;
    constructor(options: {
        config: TypingPaceConfig;
        now?: () => number;
        sleep?: (ms: number) => Promise<void>;
    });
    /** How long typing `text` takes (non-text content: the minimum). */
    typingTime(text: string): number;
    /** Wait until this message would be typed, then mark it sent. */
    wait(text: string): Promise<void>;
}
