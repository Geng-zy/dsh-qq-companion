/**
 * QQ account liveness, beyond the WebSocket being open.
 *
 * NapCat keeps answering WebSocket pings even when the QQ account behind it
 * has been kicked offline or its login expired, so the bridge would look
 * healthy while no message ever arrives. OneBot 11 heartbeat meta events
 * (NapCat: every heartInterval, 30s by default) carry `status.online`; this
 * watcher logs every online/offline transition loudly, reacts to NapCat's
 * `bot_offline` notice, and drops the socket when an open connection stops
 * delivering heartbeats altogether (a "zombie" link), so the peer reconnects.
 * @module dsh-qq-companion/liveness
 */
import type { OneBotEvent } from './connection.js'

type Log = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void

export interface LivenessSnapshot {
  /** Last OneBot heartbeat (epoch ms), undefined before the first one. */
  lastHeartbeatAt: number | undefined
  /** Last reported QQ online state, undefined before the first report. */
  online: boolean | undefined
  /** Heartbeat interval NapCat announced (ms), undefined when unknown. */
  intervalMs: number | undefined
}

export class QqLiveness {
  private readonly log: Log
  private readonly now: () => number
  private readonly connected: () => boolean
  private readonly drop: (reason: string) => void
  private lastHeartbeatAt: number | undefined
  private online: boolean | undefined
  private intervalMs: number | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(options: { log: Log; connected: () => boolean; drop: (reason: string) => void; now?: () => number }) {
    this.log = options.log
    this.connected = options.connected
    this.drop = options.drop
    this.now = options.now ?? (() => Date.now())
  }

  snapshot(): LivenessSnapshot {
    return { lastHeartbeatAt: this.lastHeartbeatAt, online: this.online, intervalMs: this.intervalMs }
  }

  /** Feed one meta event (heartbeat / lifecycle). */
  onMeta(event: OneBotEvent): void {
    const e = event as OneBotEvent & { meta_event_type?: unknown; interval?: unknown; status?: { online?: unknown; good?: unknown } }
    if (e.meta_event_type !== 'heartbeat') return
    this.lastHeartbeatAt = this.now()
    if (typeof e.interval === 'number' && e.interval > 0) this.intervalMs = e.interval
    const online = e.status?.online
    if (typeof online === 'boolean') this.setOnline(online, online ? 'NapCat 心跳报告在线' : 'NapCat 心跳报告离线（被挤下线或登录失效）')
  }

  /** Feed one notice event; reacts to NapCat's bot_offline. */
  onNotice(event: OneBotEvent): void {
    const e = event as OneBotEvent & { notice_type?: unknown; tag?: unknown; message?: unknown }
    if (e.post_type !== 'notice' || e.notice_type !== 'bot_offline') return
    const detail = [e.tag, e.message].filter(v => typeof v === 'string' && v !== '').join('：')
    this.setOnline(false, 'NapCat 报告账号下线' + (detail !== '' ? '（' + detail + '）' : ''))
  }

  /** One watchdog check (exported for tests). */
  check(): void {
    if (!this.connected() || this.lastHeartbeatAt === undefined) return
    const interval = this.intervalMs ?? 30_000
    const silent = this.now() - this.lastHeartbeatAt
    if (silent > interval * 3) {
      this.log('warn', 'OneBot 心跳中断：连接还在，但 ' + Math.round(silent / 1000) + ' 秒没收到心跳，断开让 NapCat 重连')
      // Restart the clock so one silent stretch drops the socket only once.
      this.lastHeartbeatAt = this.now()
      this.drop('no OneBot heartbeat for ' + Math.round(silent / 1000) + 's')
    }
  }

  start(intervalMs = 30_000): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => this.check(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private setOnline(online: boolean, why: string): void {
    if (this.online === online) return
    const first = this.online === undefined
    this.online = online
    if (online) {
      if (!first) this.log('info', 'QQ 账号恢复在线：' + why)
    } else {
      this.log('error', 'QQ 账号离线：' + why + '。消息收发都会中断，请检查小号（bin/status.sh / 重启 napcat / 重新扫码）')
    }
  }
}
