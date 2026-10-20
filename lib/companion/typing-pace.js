/**
 * Pace every outgoing message like one person typing on one phone: before a
 * message goes out, wait the time it takes to type it (by length, clamped),
 * counted from the later of "now" and the previous send. One account types
 * one message at a time, so replies to several chats queue naturally instead
 * of bursting out — the send rate is bounded by typing speed, not by quotas.
 * @module dsh-qq-companion/companion/typing-pace
 */
import { typingDelayMs } from '../split.js';
export class TypingPacer {
    config;
    now;
    sleep;
    lastSendAt = 0;
    chain = Promise.resolve();
    constructor(options) {
        this.config = options.config;
        this.now = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    }
    /** How long typing `text` takes (non-text content: the minimum). */
    typingTime(text) {
        const c = this.config;
        return text === '' ? c.minMs : typingDelayMs(text, c.perCharMs, c.minMs, c.maxMs);
    }
    /** Wait until this message would be typed, then mark it sent. */
    wait(text) {
        const run = this.chain.then(async () => {
            const start = Math.max(this.now(), this.lastSendAt);
            const ready = start + this.typingTime(text);
            const delay = ready - this.now();
            if (delay > 0)
                await this.sleep(delay);
            this.lastSendAt = this.now();
        });
        this.chain = run.catch(() => undefined);
        return run;
    }
}
