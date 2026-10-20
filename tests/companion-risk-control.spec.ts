/**
 * Risk control: the account-wide send budget, the per-group cooldown, and
 * one message per reply in groups.
 * @module dsh-qq-companion/tests/companion-risk-control
 */
import { describe, expect, it, vi } from 'vitest'

import { GroupCooldown, SendBudget } from '../src/companion/index.js'

import { makeCmdHarness } from './helpers/bridge-harness.js'

function clock(start = new Date(2026, 9, 20, 9, 0).getTime()) {
  let t = start
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms },
    advance: (ms: number) => { t += ms },
    sleeps,
  }
}

describe('SendBudget', () => {
  it('spaces sends account-wide', async () => {
    const c = clock()
    const b = new SendBudget({ config: { minIntervalMs: 1500, perMinute: 0, perHour: 0, perDay: 0 }, isExempt: () => false, log: () => undefined, now: c.now, sleep: c.sleep })
    expect(await b.acquire('group:1')).toBe(true)
    expect(await b.acquire('group:2')).toBe(true)
    c.advance(600)
    expect(await b.acquire('private:3')).toBe(true)
    expect(c.sleeps).toEqual([1500, 900])
  })

  it('waits for the minute window instead of dropping', async () => {
    const c = clock()
    const b = new SendBudget({ config: { minIntervalMs: 0, perMinute: 3, perHour: 0, perDay: 0 }, isExempt: () => false, log: () => undefined, now: c.now, sleep: c.sleep })
    for (let i = 0; i < 3; i++) { expect(await b.acquire('group:1')).toBe(true); c.advance(1000) }
    expect(await b.acquire('group:1')).toBe(true)
    expect(c.sleeps).toEqual([57_000])
  })

  it('drops over the hour cap, except for the exempt admin chat; warns once', async () => {
    const c = clock()
    const warns: string[] = []
    const b = new SendBudget({ config: { minIntervalMs: 0, perMinute: 0, perHour: 2, perDay: 0 }, isExempt: id => id === 'private:10001', log: (l, m) => { if (l === 'warn') warns.push(m) }, now: c.now, sleep: c.sleep })
    expect(await b.acquire('group:1')).toBe(true)
    expect(await b.acquire('group:1')).toBe(true)
    expect(await b.acquire('group:1')).toBe(false)
    expect(await b.acquire('group:1')).toBe(false)
    expect(await b.acquire('private:10001')).toBe(true)
    expect(warns).toHaveLength(1)
    expect(b.snapshot()).toMatchObject({ lastHour: 3, today: 3, dropped: 2 })
    c.advance(3_600_001)
    expect(await b.acquire('group:1')).toBe(true)
  })

  it('the day cap resets on a new day', async () => {
    const c = clock(new Date(2026, 9, 20, 23, 0).getTime())
    const b = new SendBudget({ config: { minIntervalMs: 0, perMinute: 0, perHour: 0, perDay: 1 }, isExempt: () => false, log: () => undefined, now: c.now, sleep: c.sleep })
    expect(await b.acquire('group:1')).toBe(true)
    expect(await b.acquire('group:1')).toBe(false)
    c.advance(2 * 3_600_000)
    expect(await b.acquire('group:1')).toBe(true)
    expect(b.snapshot().today).toBe(1)
  })

  it('all limits 0 = disabled', () => {
    expect(new SendBudget({ config: { minIntervalMs: 0, perMinute: 0, perHour: 0, perDay: 0 }, isExempt: () => false, log: () => undefined }).enabled).toBe(false)
  })
})

describe('GroupCooldown', () => {
  it('caps member turns per group per window; the admin and private chats are never limited', () => {
    const c = clock()
    const logs: string[] = []
    const g = new GroupCooldown({ maxTurns: 2, windowMinutes: 10, log: (_l, m) => logs.push(m), now: c.now })
    expect(g.allow('group:1', false)).toBe(true)
    expect(g.allow('group:1', false)).toBe(true)
    expect(g.allow('group:1', false)).toBe(false)
    expect(g.allow('group:1', false)).toBe(false)
    expect(logs).toHaveLength(1)
    expect(g.allow('group:1', true)).toBe(true)
    expect(g.allow('group:2', false)).toBe(true)
    expect(g.allow('private:5', false)).toBe(true)
    c.advance(10 * 60_000 + 1)
    expect(g.allow('group:1', false)).toBe(true)
  })
})

describe('wired into the bridge', () => {
  it('a cooled-down group does not reach the model, the admin does', async () => {
    const c = clock(Date.now())
    const cooldown = new GroupCooldown({ maxTurns: 1, windowMinutes: 10, log: () => undefined, now: c.now })
    const h = await makeCmdHarness({ groupCooldown: cooldown })
    h.sendGroupTextAs('第一句', 10005)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    h.sendGroupTextAs('第二句', 10005)
    await new Promise(r => setTimeout(r, 200))
    expect(h.captured.followups).toHaveLength(1)
    h.sendGroupTextAs('主人说话', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('groups get one message per reply, private chats are still split; spent budget sends nothing', async () => {
    let allow = true
    const h = await makeCmdHarness({ splitLines: true, groupSplitLines: false, sendBudget: { acquire: async () => allow } })
    const sends = () => h.outbound.filter(o => JSON.stringify(o).includes('send_msg'))
    await h.bridge.sendToChat('group:888' as never, '第一行\n第二行\n第三行', { humanize: true })
    await vi.waitFor(() => expect(sends()).toHaveLength(1))
    await h.bridge.sendToChat('private:10001' as never, '一\n二\n三', { humanize: true })
    await vi.waitFor(() => expect(sends()).toHaveLength(4))
    allow = false
    expect(await h.bridge.sendToChat('group:888' as never, '额度用完', { humanize: true })).toEqual([])
    await new Promise(r => setTimeout(r, 100))
    expect(sends()).toHaveLength(4)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
