/**
 * liveness.ts: QQ account online state and the zombie-link watchdog.
 */
import { describe, expect, it } from 'vitest'

import { QqLiveness } from '../src/liveness.js'

const heartbeat = (online: boolean) => ({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30_000, status: { online, good: online } }) as never

describe('QqLiveness', () => {
  it('logs offline/online transitions once each, not on every heartbeat', () => {
    const logs: string[] = []
    const l = new QqLiveness({ log: (level, m) => logs.push(level + ':' + m), connected: () => true, drop: () => undefined })
    l.onMeta(heartbeat(true))
    l.onMeta(heartbeat(true))
    expect(logs).toEqual([])
    l.onMeta(heartbeat(false))
    l.onMeta(heartbeat(false))
    expect(logs.filter(x => x.startsWith('error:QQ 账号离线'))).toHaveLength(1)
    l.onMeta(heartbeat(true))
    expect(logs.at(-1)).toContain('QQ 账号恢复在线')
    expect(l.snapshot().online).toBe(true)
  })

  it('reacts to the bot_offline notice', () => {
    const logs: string[] = []
    const l = new QqLiveness({ log: (level, m) => logs.push(level + ':' + m), connected: () => true, drop: () => undefined })
    l.onNotice({ post_type: 'notice', notice_type: 'bot_offline', tag: '被踢下线', message: '你的账号在别处登录' } as never)
    expect(logs[0]).toContain('被踢下线')
    expect(l.snapshot().online).toBe(false)
  })

  it('drops a connected socket once after 3 silent heartbeat intervals', () => {
    let now = 1_000_000
    const drops: string[] = []
    const l = new QqLiveness({ log: () => undefined, connected: () => true, drop: r => drops.push(r), now: () => now })
    l.check()
    expect(drops).toEqual([]) // no heartbeat yet: nothing to judge
    l.onMeta(heartbeat(true))
    now += 60_000
    l.check()
    expect(drops).toEqual([])
    now += 40_000 // 100s silent > 90s
    l.check()
    expect(drops).toHaveLength(1)
    l.check()
    expect(drops).toHaveLength(1)
  })

  it('never drops while disconnected', () => {
    let now = 0
    const drops: string[] = []
    const l = new QqLiveness({ log: () => undefined, connected: () => false, drop: r => drops.push(r), now: () => now })
    l.onMeta(heartbeat(true))
    now += 10 * 60_000
    l.check()
    expect(drops).toEqual([])
  })
})
