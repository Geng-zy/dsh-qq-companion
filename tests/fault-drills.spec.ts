/**
 * Fault drills: disk write failures and corrupt state files must never stop
 * the chat. Every persisted file is best-effort — a failure is logged, the
 * in-memory state keeps working, and the next successful write catches up.
 * @module dsh-qq-companion/tests/fault-drills
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { ChatActivity, DailyScheduler, ProactiveScheduler, hhmm, minutesOfDay } from '../src/companion/index.js'
import { GROUP_ALLOWLIST_FILE } from '../src/groups.js'
import { PENDING_SENDS_FILE } from '../src/outbound.js'
import { SerialFileWriter, writeFileAtomic } from '../src/persist.js'

import { makeCmdHarness } from './helpers/bridge-harness.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'fault-drill-'))
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe('SerialFileWriter under write failures', () => {
  it('a failed rename leaves no temp file and the old content intact', async () => {
    const dir = tmp()
    const target = join(dir, 'state.json')
    mkdirSync(target) // a directory where the file should be → rename fails
    await expect(writeFileAtomic(target, '{"a":1}')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['state.json'])
  })

  it('logs and resolves (never rejects), and later writes succeed once the disk recovers', async () => {
    const dir = tmp()
    const blocker = join(dir, 'blocked')
    writeFileSync(blocker, 'a file, not a directory')
    const warns: string[] = []
    const w = new SerialFileWriter(join(blocker, 'state.json'), { label: '测试状态', log: (_l, m) => warns.push(m) })
    await expect(w.write(() => '{"n":1}')).resolves.toBeUndefined()
    expect(warns.join()).toContain('测试状态 保存失败')
    // The chain is not poisoned: a writer on a healthy path keeps working.
    const ok = new SerialFileWriter(join(dir, 'ok.json'))
    await ok.write(() => '{"n":2}')
    expect(readFileSync(join(dir, 'ok.json'), 'utf8')).toBe('{"n":2}')
  })

  it('a render that throws is logged like a write failure', async () => {
    const warns: string[] = []
    const w = new SerialFileWriter(join(tmp(), 's.json'), { log: (_l, m) => warns.push(m) })
    await w.write(() => { throw new Error('render boom') })
    await w.write(() => 'after')
    await w.idle()
    expect(warns.join()).toContain('render boom')
  })
})

describe('corrupt state files at startup', () => {
  it('every corrupt state file is ignored and the chat still works', async () => {
    const mediaDir = tmp()
    for (const f of ['chat-sessions.json', 'retired-sessions.json', 'switchable-sessions.json', 'preset-overrides.json',
      'chat-activity.json', GROUP_ALLOWLIST_FILE, PENDING_SENDS_FILE]) {
      writeFileSync(join(mediaDir, f), '{"broken": ')
    }
    const logs: string[] = []
    const activity = new ChatActivity({ mediaDir, log: (_l, m) => logs.push(m) })
    await activity.load()
    const h = await makeCmdHarness({ mediaDir, activity })
    h.sendText('文件坏了也要能聊天')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('文件坏了也要能聊天')
    await h.bridge.sendToChat('private:10001' as never, '能聊', { humanize: true })
    await vi.waitFor(() => expect(h.outbound.some(o => JSON.stringify(o).includes('能聊'))).toBe(true))
    expect(logs.join()).toContain('读取失败')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe.skipIf(isRoot)('disk becomes read-only while running', () => {
  it('messages keep flowing; state is saved again once the disk is writable', async () => {
    const mediaDir = tmp()
    const activity = new ChatActivity({ mediaDir, log: () => undefined })
    const h = await makeCmdHarness({ mediaDir, activity })
    h.sendText('第一句')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    chmodSync(mediaDir, 0o500)
    try {
      h.sendText('磁盘只读时的第二句')
      await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
      await h.bridge.sendToChat('private:10001' as never, '照样回复', { humanize: true })
      await vi.waitFor(() => expect(h.outbound.some(o => JSON.stringify(o).includes('照样回复'))).toBe(true))
      await activity.flush()
    } finally {
      chmodSync(mediaDir, 0o700)
    }
    activity.record('private:10001', 'user', '磁盘好了', '主人')
    await activity.flush()
    expect(readFileSync(join(mediaDir, 'chat-activity.json'), 'utf8')).toContain('磁盘好了')
    expect(readdirSync(mediaDir).some(f => f.includes('.tmp-'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('scheduler failures', () => {
  it('a failing scheduled prompt is logged, not retried the same day, and does not block the next one', async () => {
    let now = new Date(2026, 9, 20, 1, 0).getTime()
    const fired: string[] = []
    const warns: string[] = []
    const s = new DailyScheduler({
      prompts: [
        { id: 'a', time: '01:10', chatId: 'private:1', prompt: '会失败' },
        { id: 'b', time: '01:10', chatId: 'private:1', prompt: '正常' },
      ],
      fire: async p => { fired.push(p.id); if (p.id === 'a') throw new Error('turn failed') },
      log: (level, m) => { if (level === 'warn') warns.push(m) },
      now: () => now,
    })
    now = new Date(2026, 9, 20, 1, 10).getTime()
    await s.tick()
    await s.tick()
    expect(fired).toEqual(['a', 'b'])
    expect(warns.join()).toContain('定时任务 a 失败')
  })

  it('a state file on an unwritable path does not stop the scheduler', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'blocked'), 'x')
    let now = new Date(2026, 9, 20, 1, 0).getTime()
    const fired: string[] = []
    const s = new DailyScheduler({
      prompts: [{ id: 'diary', time: '01:30', chatId: 'private:1', prompt: '写日记' }],
      fire: async p => { fired.push(p.id) }, log: () => undefined, now: () => now, stateFile: join(dir, 'blocked', 'state.json'),
    })
    await s.load()
    now = new Date(2026, 9, 20, 1, 30).getTime()
    await s.tick()
    await s.tick()
    expect(fired).toEqual(['diary'])
  })

  it('a failing proactive wake-up is logged and does not count as fired; fireNow bypasses the plan', async () => {
    let now = new Date(2026, 9, 20, 8, 0).getTime()
    const activity = new ChatActivity({ mediaDir: tmp(), log: () => undefined, now: () => now })
    const warns: string[] = []
    let fail = true
    const contexts: Array<{ time: string; unanswered: number }> = []
    const s = new ProactiveScheduler({
      config: { chatId: 'private:1', windowStart: '09:00', windowEnd: '22:00', minPerDay: 2, maxPerDay: 2, minGapMinutes: 90, skipIfActiveMinutes: 30, maxUnanswered: 2 },
      activity,
      fire: async ctx => { contexts.push(ctx); if (fail) throw new Error('no session') },
      log: (level, m) => { if (level === 'warn') warns.push(m) },
      now: () => now,
      random: () => 0,
    })
    expect(s.remaining()).toEqual(['09:00', '10:30'])
    now = new Date(2026, 9, 20, 9, 0).getTime()
    await s.tick()
    expect(warns.join()).toContain('主动聊天失败')
    expect(s.snapshot().firedToday).toBe(0)
    fail = false
    now = new Date(2026, 9, 20, 9, 5).getTime()
    await s.fireNow()
    expect(contexts.at(-1)).toMatchObject({ time: '09:05', unanswered: 0 })
    expect(s.remaining()).toEqual(['10:30'])
  })
})

describe('time helpers', () => {
  it('minutesOfDay / hhmm round-trip', () => {
    const t = new Date(2026, 9, 20, 7, 5).getTime()
    expect(minutesOfDay(t)).toBe(425)
    expect(hhmm(425)).toBe('07:05')
    expect(hhmm(0)).toBe('00:00')
  })
})

describe('pending sends survive a crash', () => {
  it('a corrupt pending file is not resent and does not block new sends', async () => {
    const mediaDir = tmp()
    writeFileSync(join(mediaDir, PENDING_SENDS_FILE), 'not json at all')
    const h = await makeCmdHarness({ mediaDir })
    await h.bridge.sendToChat('private:10001' as never, '新消息', { humanize: true })
    await vi.waitFor(() => expect(h.outbound.some(o => JSON.stringify(o).includes('新消息'))).toBe(true))
    expect(existsSync(join(mediaDir, PENDING_SENDS_FILE))).toBe(true)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
