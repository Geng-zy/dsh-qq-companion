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
