/**
 * The "recorded preset differs" warning on resume compares against the
 * preset THIS chat should use now (admin private → adminPreset, /preset
 * override wins), not the global agentPreset.
 * @module dsh-qq-companion/tests/preset-warning
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'

import { ChatBridge } from '../src/bridge.js'
import { OneBotConnection } from '../src/connection.js'
import { MediaStore } from '../src/media.js'
import { Transcriber } from '../src/stt.js'

async function resumeOne(options: { chatId: string; recorded: string; adminPreset?: string; override?: string }): Promise<{ warns: string[]; mounted: Array<string | undefined> }> {
  const mediaDir = mkdtempSync(join(tmpdir(), 'preset-warn-'))
  writeFileSync(join(mediaDir, 'chat-sessions.json'), JSON.stringify({ [options.chatId]: 'session-under-test' }))
  if (options.override !== undefined) writeFileSync(join(mediaDir, 'preset-overrides.json'), JSON.stringify({ [options.chatId]: options.override }))
  const warns: string[] = []
  const mounted: Array<string | undefined> = []
  const resume = vi.fn(async (o: { resumeSessionId: string; setup?: (agentCtx: unknown) => unknown }) => {
    if (typeof o.setup === 'function') {
      await o.setup({ on: () => () => undefined, systemPrompt: { section: () => () => undefined }, tools: { register: () => () => undefined } })
    }
    return {
      agent: { session: { id: String(o.resumeSessionId), seq: 1, header: { cwd: mediaDir } }, status: 'idle', cancel: () => undefined, followup: () => undefined, whenIdle: async () => undefined },
      dispose: async () => undefined,
    }
  })
  const bridge = new ChatBridge({
    ctx: new Context(),
    connection: new OneBotConnection({ host: '127.0.0.1', port: 0, accessToken: 'test-token', callTimeoutMs: 3_000 }),
    media: new MediaStore(join(mediaDir, 'media'), 6),
    transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
    agents: { create: vi.fn(), resume } as never,
    sessions: { flush: vi.fn(async () => undefined) } as never,
    agentPresets: {
      defaultId: 'standard',
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
      mount: vi.fn(async (_agentCtx: unknown, id?: string) => { mounted.push(id); return { id: id ?? 'standard' } }),
    } as never,
    sessionPersistence: {
      open: vi.fn(async () => ({
        header: { agentPreset: options.recorded },
        read: vi.fn(async () => ({ eventState: 'detached' as const, events: [] })),
        close: vi.fn(async () => undefined),
      })),
    } as never,
    workspaceRegistry: undefined as never,
    agentDefaultModel: undefined,
    defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
      sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      agentPreset: 'chat-only', workspacePath: mediaDir,
      ...(options.adminPreset !== undefined ? { adminPreset: options.adminPreset } : {}),
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: (level: string, message: string) => { if (level === 'warn') warns.push(message) },
  })
  bridge.start()
  await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(mounted).toHaveLength(1))
  await bridge.stop()
  return { warns, mounted }
}

const presetWarnings = (warns: string[]) => warns.filter(w => w.includes('记录的预设'))

describe('recorded-preset warning on resume', () => {
  it("an admin's private chat on adminPreset is not reported", async () => {
    const r = await resumeOne({ chatId: 'private:10001', recorded: 'full', adminPreset: 'full' })
    expect(presetWarnings(r.warns)).toEqual([])
    expect(r.mounted).toEqual(['full'])
  })

  it('a group on the full preset is reported by name, with how to fix it', async () => {
    const r = await resumeOne({ chatId: 'group:888', recorded: 'full', adminPreset: 'full' })
    expect(presetWarnings(r.warns)).toEqual(['会话 group:888 记录的预设是 full，按现在的配置应该用 chat-only；先按记录的预设恢复，在这个会话里发 /new 就会换成 chat-only'])
    expect(r.mounted).toEqual(['full']) // behavior unchanged: the recorded preset still wins
  })

  it('a /preset override counts as what the chat should use', async () => {
    const r = await resumeOne({ chatId: 'group:888', recorded: 'writer', override: 'writer' })
    expect(presetWarnings(r.warns)).toEqual([])
  })

  it('a non-admin private chat on the admin preset is reported', async () => {
    const r = await resumeOne({ chatId: 'private:20002', recorded: 'full', adminPreset: 'full' })
    expect(presetWarnings(r.warns)).toHaveLength(1)
    expect(presetWarnings(r.warns)[0]).toContain('private:20002')
  })
})
