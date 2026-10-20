/**
 * Pace outgoing messages like one person typing on one phone: before a
 * message goes out, wait the time it takes to type it (by length, clamped),
 * counted from the later of "now" and the previous send. One account types
 * one message at a time, so replies to several chats queue naturally instead
 * of bursting out — the send rate is bounded by typing speed, not by quotas.
 * With humanTypingPace on every message is paced; with it off only the
 * follow-up lines of a split reply are (see outbound.ts).
 * @module dsh-qq-companion/companion/typing-pace
 */
import { typingDelayMs } from '../split.js'

/** Typing speed defaults (milliseconds), the same as the config schema's. */
export const DEFAULT_TYPING_DELAY_PER_CHAR_MS = 80
export const DEFAULT_TYPING_DELAY_MIN_MS = 500
export const DEFAULT_TYPING_DELAY_MAX_MS = 2500

export interface TypingPaceConfig {
  perCharMs: number
  minMs: number
  maxMs: number
}

export class TypingPacer {
  private readonly config: TypingPaceConfig
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private lastSendAt = 0
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: { config: TypingPaceConfig; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.config = options.config
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** How long typing `text` takes (non-text content: the minimum). */
  typingTime(text: string): number {
    const c = this.config
    return text === '' ? c.minMs : typingDelayMs(text, c.perCharMs, c.minMs, c.maxMs)
  }

  /** Wait until this message would be typed, then mark it sent. */
  wait(text: string): Promise<void> {
    const run = this.chain.then(async () => {
      const now = this.now()
      const delay = Math.max(now, this.lastSendAt) + this.typingTime(text) - now
      if (delay > 0) await this.sleep(delay)
      this.lastSendAt = this.now()
    })
    this.chain = run.catch(() => undefined)
    return run
  }
}
