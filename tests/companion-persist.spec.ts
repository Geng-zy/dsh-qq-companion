/**
 * Companion counters survive restarts: the daily scheduler's fired days
 * (with late catch-up), today's proactive plan, and memory-note quotas.
 * Also: missing / corrupt state files mean "no prior state".
 * @module dsh-qq-companion/tests/companion-persist
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  CATCH_UP_MINUTES, ChatActivity, DailyScheduler, NOTES_PER_DAY, NoteCounter, ProactiveScheduler, appendMemoryNote,
} from '../src/companion/index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'companion-persist-'))
const at = (h: number, m: number, day = 20) => new Date(2026, 9, day, h, m).getTime()
const prompt = { id: 'diary', time: '01:30', chatId: 'private:1', prompt: '写日记' }
const fileHas = (file: string, text: string) => vi.waitFor(() => expect(readFileSync(file, 'utf8')).toContain(text))

describe('DailyScheduler persistence', () => {
  it('a prompt fired before a restart does not fire again the same day', async () => {
    const file = join(tmp(), 'scheduler-state.json')
    let now = at(1, 31)
    const fired: string[] = []
    const make = () => new DailyScheduler({ prompts: [prompt], fire: async p => { fired.push(p.id) }, log: () => undefined, now: () => now, stateFile: file })
    // First boot ever (no state file) at 01:20, fires at 01:31.
    now = at(1, 20)
    const a = make(); await a.load()
    now = at(1, 31)
    await a.tick()
    expect(fired).toEqual(['diary'])
    await fileHas(file, '"diary"')
    now = at(2, 0)
    const b = make(); await b.load()
    await b.tick()
    expect(fired).toEqual(['diary'])
  })

  it('catches up a prompt missed while dsh was down, within the window only', async () => {
    const file = join(tmp(), 'scheduler-state.json')
    writeFileSync(file, JSON.stringify({ fired: { diary: '2026-10-19' } }))
    const fired: string[] = []
    let now = at(2, 15)
    const late = new DailyScheduler({ prompts: [prompt], fire: async p => { fired.push(p.id) }, log: () => undefined, now: () => now, stateFile: file })
    await late.load()
    await late.tick()
    expect(fired).toEqual(['diary'])

    writeFileSync(file, JSON.stringify({ fired: { diary: '2026-10-19' } }))
    now = at(1, 30 + CATCH_UP_MINUTES + 1)
    const tooLate = new DailyScheduler({ prompts: [prompt], fire: async p => { fired.push(p.id + '!') }, log: () => undefined, now: () => now, stateFile: file })
    await tooLate.load()
    await tooLate.tick()
    expect(fired).toEqual(['diary'])
  })

  it('a corrupt state file is treated as no state (past times stay skipped)', async () => {
    const file = join(tmp(), 'scheduler-state.json')
    writeFileSync(file, '{not json')
    const fired: string[] = []
    const warns: string[] = []
    const s = new DailyScheduler({ prompts: [prompt], fire: async p => { fired.push(p.id) }, log: (level, m) => { if (level === 'warn') warns.push(m) }, now: () => at(2, 0), stateFile: file })
    await s.load()
    await s.tick()
    expect(fired).toEqual(['diary']) // the file existed, so the 01:30 prompt is within catch-up
    expect(warns.join()).toContain('状态文件读取失败')
  })
})

describe('ProactiveScheduler persistence', () => {
  const config = { chatId: 'private:1', windowStart: '09:00', windowEnd: '22:00', minPerDay: 6, maxPerDay: 6, minGapMinutes: 90, skipIfActiveMinutes: 30, maxUnanswered: 2 }

  it('a restart keeps the same plan and count; a new day draws afresh', async () => {
    const dir = tmp()
    const file = join(dir, 'proactive-state.json')
    let now = at(8, 0)
    const activity = new ChatActivity({ mediaDir: dir, log: () => undefined, now: () => now })
    const make = (random: () => number) => new ProactiveScheduler({ config, activity, fire: async () => undefined, log: () => undefined, now: () => now, random, stateFile: file })
    const a = make(() => 0)
    await a.load()
    expect(a.remaining()).toEqual(['09:00', '10:30', '12:00', '13:30', '15:00', '16:30'])
    now = at(9, 0)
    await a.tick()
    await fileHas(file, '"fired":1')
    // Restart at 10:00 with a different random source: same remaining plan.
    now = at(10, 0)
    const b = make(() => 0.99)
    await b.load()
    expect(b.snapshot()).toEqual({ day: a.snapshot().day, remaining: ['10:30', '12:00', '13:30', '15:00', '16:30'], firedToday: 1 })
    // Restart after a long outage: stale slots are dropped.
    now = at(14, 10)
    const c = make(() => 0.99)
    await c.load()
    expect(c.remaining()).toEqual(['15:00', '16:30'])
    // Next day: a fresh plan.
    now = at(8, 0, 21)
    const d = make(() => 0)
    await d.load()
    expect(d.snapshot().firedToday).toBe(0)
    expect(d.remaining()).toHaveLength(6)
  })

  it('stopping for the day survives a restart', async () => {
    const dir = tmp()
    const file = join(dir, 'proactive-state.json')
    let now = at(7, 0)
    const activity = new ChatActivity({ mediaDir: dir, log: () => undefined, now: () => now })
    activity.record('private:1', 'bot', '一')
    activity.record('private:1', 'bot', '二')
    activity.record('private:1', 'bot', '三')
    const make = () => new ProactiveScheduler({ config, activity, fire: async () => undefined, log: () => undefined, now: () => now, random: () => 0, stateFile: file })
    now = at(8, 0)
    const a = make(); await a.load(); a.remaining()
    now = at(9, 0)
    await a.tick()
    expect(a.remaining()).toEqual([])
    await fileHas(file, '"plan":[]')
    now = at(11, 0)
    const b = make(); await b.load()
    expect(b.remaining()).toEqual([])
  })

  it('a corrupt state file just plans the rest of today', async () => {
    const dir = tmp()
    const file = join(dir, 'proactive-state.json')
    writeFileSync(file, '[]garbage')
    const now = at(12, 0)
    const activity = new ChatActivity({ mediaDir: dir, log: () => undefined, now: () => now })
    const s = new ProactiveScheduler({ config, activity, fire: async () => undefined, log: () => undefined, now: () => now, random: () => 0, stateFile: file })
    await s.load()
    expect(s.remaining()[0]).toBe('12:01')
  })
})

describe('NoteCounter persistence', () => {
  it('the per-day quota survives a restart and resets the next day', async () => {
    const dir = tmp()
    const notes = join(dir, 'AGENTS.md')
    const state = join(dir, 'note-counts.json')
    let now = at(12, 0)
    const a = new NoteCounter(state)
    await a.load(now)
    for (let i = 0; i < NOTES_PER_DAY; i++) expect((await appendMemoryNote(notes, 'group:7', '第' + i + '件事', () => now, undefined, a)).ok).toBe(true)
    await fileHas(state, '"group:7":' + NOTES_PER_DAY)
    const b = new NoteCounter(state)
    await b.load(now)
    expect((await appendMemoryNote(notes, 'group:7', '重启后再来一件', () => now, undefined, b)).ok).toBe(false)
    expect((await appendMemoryNote(notes, 'group:8', '别的群不受影响', () => now, undefined, b)).ok).toBe(true)
    now = at(12, 0, 21)
    const c = new NoteCounter(state)
    await c.load(now)
    expect((await appendMemoryNote(notes, 'group:7', '第二天又能记了', () => now, undefined, c)).ok).toBe(true)
  })

  it('a corrupt counter file starts from zero', async () => {
    const dir = tmp()
    const state = join(dir, 'note-counts.json')
    writeFileSync(state, 'oops')
    const c = new NoteCounter(state)
    await c.load(at(12, 0))
    expect(c.used('group:1', at(12, 0))).toBe(0)
  })
})

describe('feature interplay: proactive check-in vs session renewal', () => {
  it('a check-in stays in the aged session; the owner\'s reply renews it with the check-in in the handoff', async () => {
    const { makeCmdHarness } = await import('./helpers/bridge-harness.js')
    let now = Date.now()
    const activity = new ChatActivity({ mediaDir: tmp(), log: () => undefined, now: () => now })
    const h = await makeCmdHarness({ activity, privateResetDays: 1 })
    h.sendText('今天好累')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const first = h.captured.followups[0].sessionId
    await h.bridge.sendToChat('private:10001' as never, '摸摸头', { humanize: true })

    now += 3 * 86_400_000
    await h.bridge.fireCheckin('private:10001' as never, { time: '15:00', unanswered: 0, lastUserAt: now - 3 * 86_400_000 })
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].sessionId).toBe(first)
    expect(h.captured.followups[1].text).toContain('主动聊天的机会')
    await h.bridge.sendToChat('private:10001' as never, '主人在干嘛呀', { humanize: true })
    expect(activity.botLinesSinceUser('private:10001')).toBe(2)

    h.sendText('在上班')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    expect(h.captured.followups[2].sessionId).not.toBe(first)
    expect(h.captured.followups[2].text).toContain('这是一个新会话')
    expect(h.captured.followups[2].text).toContain('你：主人在干嘛呀')
    expect(activity.botLinesSinceUser('private:10001')).toBe(0)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
