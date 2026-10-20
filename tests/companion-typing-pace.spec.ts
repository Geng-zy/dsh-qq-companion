/**
 * Human typing pace: every outgoing message waits its typing time, one
 * message at a time account-wide.
 * @module dsh-qq-companion/tests/companion-typing-pace
 */
import { describe, expect, it, vi } from 'vitest'

import { TypingPacer } from '../src/companion/index.js'

import { makeCmdHarness } from './helpers/bridge-harness.js'

function clock() {
  let t = 1_000_000
  const sleeps: number[] = []
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms }, advance: (ms: number) => { t += ms }, sleeps }
}
const config = { perCharMs: 250, minMs: 1200, maxMs: 10_000 }

describe('TypingPacer', () => {
  it('waits the typing time by length, clamped', () => {
    const p = new TypingPacer({ config })
    expect(p.typingTime('好')).toBe(1200)
    expect(p.typingTime('今天吃了三碗饭超开心')).toBe(2500)
    expect(p.typingTime('字'.repeat(100))).toBe(10_000)
    expect(p.typingTime('')).toBe(1200) // an image or other non-text
  })

  it('one message at a time: messages for different chats queue behind each other', async () => {
    const c = clock()
    const p = new TypingPacer({ config, now: c.now, sleep: c.sleep })
    await Promise.all([p.wait('群里的一句话'), p.wait('私聊的一句'), p.wait('好')])
    expect(c.sleeps).toEqual([1500, 1250, 1200])
  })

  it('time already passed since the last send counts toward typing', async () => {
    const c = clock()
    const p = new TypingPacer({ config, now: c.now, sleep: c.sleep })
    await p.wait('好')
    c.advance(60_000)
    await p.wait('隔了一分钟才回的这一句话')
    expect(c.sleeps).toEqual([1200, 3000])
  })
})

describe('wired into the bridge', () => {
  it('every sent message, each split line included, goes through the pacer once', async () => {
    const typed: string[] = []
    const h = await makeCmdHarness({ splitLines: true, typingPacer: { wait: async text => { typed.push(text) } } })
    await h.bridge.sendToChat('private:10001' as never, '第一句\n第二句\n第三句', { humanize: true })
    await h.bridge.sendToChat('group:888' as never, '群里一句', {})
    await vi.waitFor(() => expect(typed).toEqual(['第一句', '第二句', '第三句', '群里一句']))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
