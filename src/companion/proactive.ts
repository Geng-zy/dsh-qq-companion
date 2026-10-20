/**
 * Proactive check-ins: wake the companion a few random times a day inside a
 * window so she can decide whether to reach out; replying the pass marker
 * sends nothing.
 * @module dsh-qq-companion/companion/proactive
 */
import { describeError } from '../errors.js'
import type { ChatActivity } from './activity.js'
import { dayKey, toMinutes } from './time.js'
import type { Log } from './time.js'

export interface ProactiveConfig {
  /** The chat she may reach out to (the owner's private chat). */
  chatId: string
  /** Local window, HH:MM–HH:MM. */
  windowStart: string
  windowEnd: string
  /** Wake-ups per day, picked at random in [min, max]. */
  minPerDay: number
  maxPerDay: number
  /** Minimum minutes between two wake-ups. */
  minGapMinutes: number
  /** Skip a wake-up when the owner wrote within this many minutes. */
  skipIfActiveMinutes: number
  /** Stop for the day after this many unanswered proactive messages. */
  maxUnanswered: number
}

/** The reply that means "nothing to say this time" — never sent to QQ. */
export const PROACTIVE_PASS = '[不发]'

/** True when a final reply is the pass marker (whitespace / brackets tolerant). */
export function isProactivePass(text: string): boolean {
  return /^[\s\[【（(]*不发[\s\]】）)。.!！]*$/.test(text)
}

/**
 * Pick `count` minutes-of-day in [start, end) at least `gap` apart, at
 * random. Returns fewer when the window cannot fit them.
 */
export function pickCheckinTimes(start: number, end: number, count: number, gap: number, random: () => number = Math.random): number[] {
  if (end <= start || count <= 0) return []
  const fit = Math.min(count, Math.floor((end - start - 1) / Math.max(gap, 1)) + 1)
  // Spread `fit` slots with the mandatory gaps, then share the slack at random.
  const slack = (end - start - 1) - gap * (fit - 1)
  const cuts = Array.from({ length: fit }, () => random() * slack).sort((a, b) => a - b)
  return cuts.map((c, i) => Math.floor(start + c + gap * i))
}

/** Wakes her a few random times a day inside the window (see ProactiveConfig). */
export class ProactiveScheduler {
  private readonly config: ProactiveConfig
  private readonly fire: (context: { time: string; unanswered: number; lastUserAt: number | undefined }) => Promise<void>
  private readonly activity: ChatActivity
  private readonly log: Log
  private readonly now: () => number
  private readonly random: () => number
  private day = ''
  private plan: number[] = []
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(options: {
    config: ProactiveConfig
    activity: ChatActivity
    fire: (context: { time: string; unanswered: number; lastUserAt: number | undefined }) => Promise<void>
    log: Log
    now?: () => number
    random?: () => number
  }) {
    this.config = options.config
    this.activity = options.activity
    this.fire = options.fire
    this.log = options.log
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
  }

  start(intervalMs = 30_000): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => { void this.tick() }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Today's remaining wake-up times as HH:MM (for /task listing). */
  remaining(): string[] {
    this.ensurePlan()
    return this.plan.map(m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'))
  }

  /** Wake her right now (the /task checkin test hook): the hard rules
   * still apply except the time plan. */
  async fireNow(): Promise<void> {
    const c = this.config
    const unanswered = Math.max(0, this.activity.botLinesSinceUser(c.chatId) - 1)
    const d = new Date(this.now())
    const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    await this.fire({ time, unanswered, lastUserAt: this.activity.lastAt(c.chatId) })
  }

  /** One check (exported for tests). */
  async tick(): Promise<void> {
    this.ensurePlan()
    const d = new Date(this.now())
    const nowMin = d.getHours() * 60 + d.getMinutes()
    if (this.plan.length === 0 || this.plan[0] > nowMin) return
    // Fire the earliest due slot; any older missed slots are dropped.
    while (this.plan.length > 1 && this.plan[1] <= nowMin) this.plan.shift()
    this.plan.shift()
    const c = this.config
    const lastUserAt = this.activity.lastAt(c.chatId)
    if (lastUserAt !== undefined && this.now() - lastUserAt < c.skipIfActiveMinutes * 60_000) {
      this.log('info', '主动聊天跳过：对方刚在聊天')
      return
    }
    // Her normal reply to the owner's last message is 1; each unanswered
    // proactive message adds one.
    const unanswered = Math.max(0, this.activity.botLinesSinceUser(c.chatId) - 1)
    if (unanswered >= c.maxUnanswered) {
      this.log('info', '主动聊天今天停止：已有 ' + unanswered + ' 条主动消息没回')
      this.plan = []
      return
    }
    const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    try {
      await this.fire({ time, unanswered, lastUserAt })
      this.log('info', '主动聊天：已叫醒她（' + time + '）')
    } catch (error) {
      this.log('warn', '主动聊天失败: ' + describeError(error))
    }
  }

  private ensurePlan(): void {
    const today = dayKey(this.now())
    if (today === this.day) return
    this.day = today
    const c = this.config
    const span = Math.max(0, c.maxPerDay - c.minPerDay)
    const count = c.minPerDay + Math.floor(this.random() * (span + 1))
    const d = new Date(this.now())
    const nowMin = d.getHours() * 60 + d.getMinutes()
    // A restart mid-day plans only the rest of today's window.
    const start = Math.max(toMinutes(c.windowStart), nowMin + 1)
    this.plan = pickCheckinTimes(start, toMinutes(c.windowEnd), count, c.minGapMinutes, this.random)
    this.log('info', '今天的主动聊天时间：' + (this.remaining().join('、') || '（无）'))
  }
}
