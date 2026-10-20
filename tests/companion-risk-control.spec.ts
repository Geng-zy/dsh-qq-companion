/**
 * Risk control: one message per reply in groups, and the send counter
 * behind the /doctor line.
 * @module dsh-qq-companion/tests/companion-risk-control
 */
import { describe, expect, it, vi } from 'vitest'

import { SendCounter, companionStatusLines } from '../src/companion/index.js'

import { makeCmdHarness } from './helpers/bridge-harness.js'

describe('one message per reply in groups', () => {
  it('groups get one message, private chats are still split', async () => {
    const h = await makeCmdHarness({ splitLines: true, groupSplitLines: false })
    const sends = () => h.outbound.filter(o => JSON.stringify(o).includes('send_msg'))
    await h.bridge.sendToChat('group:888' as never, '第一行\n第二行\n第三行', { humanize: true })
    await vi.waitFor(() => expect(sends()).toHaveLength(1))
    await h.bridge.sendToChat('private:10001' as never, '一\n二\n三', { humanize: true })
    await vi.waitFor(() => expect(sends()).toHaveLength(4))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('SendCounter', () => {
  it('counts the last minute, the last hour and today; never limits', () => {
    let t = new Date(2026, 9, 20, 23, 0).getTime()
    const c = new SendCounter({ now: () => t })
    for (let i = 0; i < 3; i++) c.record()
    t += 2 * 60_000
    c.record()
    expect(c.snapshot()).toEqual({ lastMinute: 1, lastHour: 4, today: 4 })
    t += 2 * 3_600_000 // past midnight
    expect(c.snapshot()).toEqual({ lastMinute: 0, lastHour: 0, today: 0 })
  })

  it('is shown by /doctor', async () => {
    const lines = await companionStatusLines({ sendCounter: () => ({ lastMinute: 2, lastHour: 40, today: 300 }) })
    expect(lines.join('\n')).toContain('发送量：近 1 分钟 2 条 · 近 1 小时 40 条 · 今天 300 条')
  })

  it('the bridge counts every message that went out', async () => {
    const counter = new SendCounter()
    const h = await makeCmdHarness({ splitLines: true, sendCounter: counter })
    await h.bridge.sendToChat('private:10001' as never, '一\n二\n三', { humanize: true })
    await vi.waitFor(() => expect(counter.snapshot().today).toBe(3))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
