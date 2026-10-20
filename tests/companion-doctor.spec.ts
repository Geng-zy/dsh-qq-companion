/**
 * The companion block of /doctor.
 * @module dsh-qq-companion/tests/companion-doctor
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DailyScheduler, companionStatusLines } from '../src/companion/index.js'
import { healthReport } from '../src/health.js'

const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime()

describe('companion /doctor block', () => {
  it('renders liveness, scheduler, proactive and memory sizes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-'))
    writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(20 * 1024))
    mkdirSync(join(dir, 'groups', '888000001'), { recursive: true })
    writeFileSync(join(dir, 'groups', '888000001', 'AGENTS.md'), 'y'.repeat(13 * 1024))
    mkdirSync(join(dir, 'groups', '888000002'))
    const scheduler = new DailyScheduler({
      prompts: [{ id: 'diary', time: '01:30', chatId: 'private:1', prompt: '写日记' }],
      fire: async () => undefined, log: () => undefined, now: () => at(10, 0),
    })
    const lines = await companionStatusLines({
      liveness: () => ({ lastHeartbeatAt: at(9, 59, ) + 30_000, online: true, intervalMs: 30_000 }),
      scheduler: () => scheduler.snapshot(),
      proactive: () => ({ remaining: ['15:00', '18:20'], firedToday: 2 }),
      memoryFiles: [
        { label: '公开', path: join(dir, 'AGENTS.md'), max: 24 * 1024 },
        { label: '私密', path: join(dir, 'missing.md') },
      ],
      groupMemoryDir: join(dir, 'groups'),
      groupMemoryMaxBytes: 12 * 1024,
      now: () => at(10, 0),
    })
    const text = lines.join('\n')
    expect(text).toContain('QQ 账号：在线（上次心跳 30 秒前，间隔 30 秒）')
    expect(text).toContain('diary 01:30 今天已执行') // past at boot counts as done
    expect(text).toContain('主动聊天：今天已叫醒 2 次，还剩 15:00、18:20')
    expect(text).toContain('公开 20.0KB/24.0KB（83%，该整理了）')
    expect(text).toContain('私密 无')
    expect(text).toContain('群888000001 13.0KB/12.0KB（108%，已满）')
    expect(text).toContain('群888000002 无')
  })

  it('offline / no heartbeat yet', async () => {
    const offline = (await companionStatusLines({ liveness: () => ({ lastHeartbeatAt: undefined, online: false, intervalMs: undefined }) })).join('\n')
    expect(offline).toContain('QQ 账号：⚠️ 离线（还没收到心跳）')
  })

  it('is appended to the health report; a failing part does not break /doctor', async () => {
    const base = {
      mediaDir: mkdtempSync(join(tmpdir(), 'doctor-')),
      connection: { connected: true, selfId: '1' },
      transport: { mode: 'reverse', host: '127.0.0.1', port: 1 },
      retryState: {},
      dedup: { entries: 0, windowSeconds: 300 },
      writeGate: { minuteUsed: 0, minuteLimit: 1, dayUsed: 0, dayLimit: 1 },
      configSnapshot: {},
      log: () => undefined,
    }
    expect(await healthReport({ ...base, companion: async () => ['▍陪伴状态', '主动聊天：x'] })).toContain('主动聊天：x')
    expect(await healthReport({ ...base, companion: async () => { throw new Error('boom') } })).toContain('▍陪伴状态：读取失败（boom）')
  })
})
