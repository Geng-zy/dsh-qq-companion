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
import type { Log } from './time.js'

export interface SendBudgetConfig {
  minIntervalMs: number
  perMinute: number
  perHour: number
  perDay: number
}

export interface SendBudgetSnapshot {
  lastMinute: number
  lastHour: number
  today: number
  dropped: number
  limits: SendBudgetConfig
}

const HOUR = 3_600_000

export class SendBudget {
  private readonly config: SendBudgetConfig
  private readonly isExempt: (chatId: string) => boolean
  private readonly log: Log
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** Send times within the last hour (minute/hour windows). */
  private recent: number[] = []
  private day = ''
  private todayCount = 0
  private droppedCount = 0
  private lastSendAt = 0
  private chain: Promise<unknown> = Promise.resolve()
  private warnedFor = ''

  constructor(options: {
    config: SendBudgetConfig
    isExempt: (chatId: string) => boolean
    log: Log
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  }) {
    this.config = options.config
    this.isExempt = options.isExempt
    this.log = options.log
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Whether any limit is on. */
  get enabled(): boolean {
    const c = this.config
    return c.minIntervalMs > 0 || c.perMinute > 0 || c.perHour > 0 || c.perDay > 0
  }

  /**
   * Take one send unit for `chatId`, waiting for the gap / minute window.
   * @returns false when the hour/day budget is spent (the caller drops the send).
   */
  acquire(chatId: string): Promise<boolean> {
    const run = this.chain.then(() => this.take(chatId))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async take(chatId: string): Promise<boolean> {
    const c = this.config
    this.rollDay()
    const exempt = this.isExempt(chatId)
    this.prune()
    if (!exempt) {
      const overDay = c.perDay > 0 && this.todayCount >= c.perDay
      const overHour = c.perHour > 0 && this.recent.length >= c.perHour
      if (overDay || overHour) {
        this.droppedCount += 1
        const key = (overDay ? 'day:' + this.day : 'hour:' + Math.floor(this.now() / HOUR)) + '|' + chatId
        if (this.warnedFor !== key) {
          this.warnedFor = key
          this.log('warn', '发送额度用完（' + (overDay ? '今天已发 ' + this.todayCount + '/' + c.perDay : '近一小时已发 ' + this.recent.length + '/' + c.perHour) + '），暂停给 ' + chatId + ' 发消息，防止触发 QQ 风控')
        }
        return false
      }
    }
    if (c.perMinute > 0) {
      const inMinute = this.recent.filter(t => this.now() - t < 60_000)
      if (inMinute.length >= c.perMinute) {
        const wait = inMinute[inMinute.length - c.perMinute] + 60_000 - this.now()
        if (wait > 0) await this.sleep(wait)
      }
    }
    if (c.minIntervalMs > 0) {
      const wait = this.lastSendAt + c.minIntervalMs - this.now()
      if (wait > 0) await this.sleep(wait)
    }
    const at = this.now()
    this.rollDay()
    this.lastSendAt = at
    this.recent.push(at)
    this.todayCount += 1
    return true
  }

  snapshot(): SendBudgetSnapshot {
    this.rollDay()
    this.prune()
    const now = this.now()
    return {
      lastMinute: this.recent.filter(t => now - t < 60_000).length,
      lastHour: this.recent.length,
      today: this.todayCount,
      dropped: this.droppedCount,
      limits: { ...this.config },
    }
  }

  private prune(): void {
    const now = this.now()
    this.recent = this.recent.filter(t => now - t < HOUR)
  }

  private rollDay(): void {
    const d = new Date(this.now())
    const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
    if (key !== this.day) {
      this.day = key
      this.todayCount = 0
      this.droppedCount = 0
    }
  }
}

/**
 * Per-group reply cooldown: at most `maxTurns` member-started turns per
 * group within `windowMinutes`; the admin is never limited. 0 disables.
 */
export class GroupCooldown {
  private readonly maxTurns: number
  private readonly windowMs: number
  private readonly log: Log
  private readonly now: () => number
  private readonly turns = new Map<string, number[]>()
  private readonly noted = new Map<string, number>()

  constructor(options: { maxTurns: number; windowMinutes: number; log: Log; now?: () => number }) {
    this.maxTurns = options.maxTurns
    this.windowMs = Math.max(1, options.windowMinutes) * 60_000
    this.log = options.log
    this.now = options.now ?? (() => Date.now())
  }

  /** Whether this member turn may run now (and count it if so). */
  allow(chatId: string, byAdmin: boolean): boolean {
    if (byAdmin || this.maxTurns <= 0 || !chatId.startsWith('group:')) return true
    const now = this.now()
    const list = (this.turns.get(chatId) ?? []).filter(t => now - t < this.windowMs)
    if (list.length >= this.maxTurns) {
      this.turns.set(chatId, list)
      const resumeAt = list[0] + this.windowMs
      if (this.noted.get(chatId) !== resumeAt) {
        this.noted.set(chatId, resumeAt)
        this.log('info', chatId + ' 冷却中：' + Math.round(this.windowMs / 60_000) + ' 分钟内已回 ' + list.length + ' 轮，' + Math.ceil((resumeAt - now) / 1000) + ' 秒后再回群友')
      }
      return false
    }
    list.push(now)
    this.turns.set(chatId, list)
    return true
  }
}
