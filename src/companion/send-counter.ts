/**
 * Counts what the QQ account sends (for /doctor): the last minute, the last
 * hour and today. Counting only — sending pace is the typing pacer's job.
 * @module dsh-qq-companion/companion/send-counter
 */

export interface SendCounterSnapshot {
  lastMinute: number
  lastHour: number
  today: number
}

const HOUR = 3_600_000

export class SendCounter {
  private readonly now: () => number
  private recent: number[] = []
  private day = ''
  private todayCount = 0

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  /** One message went out. */
  record(): void {
    this.rollDay()
    const now = this.now()
    this.recent = this.recent.filter(t => now - t < HOUR)
    this.recent.push(now)
    this.todayCount += 1
  }

  snapshot(): SendCounterSnapshot {
    this.rollDay()
    const now = this.now()
    this.recent = this.recent.filter(t => now - t < HOUR)
    return { lastMinute: this.recent.filter(t => now - t < 60_000).length, lastHour: this.recent.length, today: this.todayCount }
  }

  private rollDay(): void {
    const d = new Date(this.now())
    const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
    if (key !== this.day) {
      this.day = key
      this.todayCount = 0
    }
  }
}
