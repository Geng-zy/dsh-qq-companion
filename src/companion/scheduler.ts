/**
 * Daily scheduled prompts: each fires once per local day at or after HH:MM.
 * @module dsh-qq-companion/companion/scheduler
 */
import { describeError } from '../errors.js'
import { dayKey } from './time.js'
import type { Log } from './time.js'

export interface ScheduledPrompt {
  /** Stable id (fired-day bookkeeping). */
  id: string
  /** Local time HH:MM. */
  time: string
  /** Target chat, e.g. private:123450001. */
  chatId: string
  /** What the turn is told to do. */
  prompt: string
  /** Append today's transcript excerpt of this chat (then clear it). */
  includeTodayLog?: boolean
}

/** Fires each prompt once per local day, at or after its HH:MM. */
export class DailyScheduler {
  private readonly prompts: readonly ScheduledPrompt[]
  private readonly fire: (prompt: ScheduledPrompt) => Promise<void>
  private readonly log: Log
  private readonly now: () => number
  private readonly fired = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(options: { prompts: readonly ScheduledPrompt[]; fire: (prompt: ScheduledPrompt) => Promise<void>; log: Log; now?: () => number }) {
    this.prompts = options.prompts.filter(p => /^\d{2}:\d{2}$/.test(p.time) && p.chatId !== '' && p.prompt !== '')
    this.fire = options.fire
    this.log = options.log
    this.now = options.now ?? (() => Date.now())
    // A prompt whose time already passed today does not fire on boot.
    const today = dayKey(this.now())
    for (const p of this.prompts) {
      if (this.minutesNow() >= this.minutesOf(p.time)) this.fired.set(p.id, today)
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer !== undefined || this.prompts.length === 0) return
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One check (exported for tests). */
  async tick(): Promise<void> {
    const today = dayKey(this.now())
    for (const p of this.prompts) {
      if (this.fired.get(p.id) === today) continue
      if (this.minutesNow() < this.minutesOf(p.time)) continue
      this.fired.set(p.id, today)
      try {
        await this.fire(p)
        this.log('info', '定时任务已触发: ' + p.id)
      } catch (error) {
        this.log('warn', '定时任务 ' + p.id + ' 失败: ' + describeError(error))
      }
    }
  }

  private minutesNow(): number {
    const d = new Date(this.now())
    return d.getHours() * 60 + d.getMinutes()
  }

  private minutesOf(time: string): number {
    const [h, m] = time.split(':').map(Number)
    return h * 60 + m
  }
}
