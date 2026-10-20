import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

import { defaultMediaDir, dshHome } from '../src/index.js'
import { ChatRegistry } from '../src/registry.js'

// Regression tests for the 0.4.3 hotfix pair that pure fakes cannot cover:
// the dsh-home fallback chain (defect 1) and the retired-sessions save race
// (defect 2). Rename is gated so the test controls when each write lands;
// saves are now serialized (persist.ts), so the shared-`.tmp` ENOENT race and
// the stale-snapshot overwrite can no longer happen.

const hoisted = vi.hoisted(() => {
  const pending: Array<{ from: string; dest: string; release: () => void }> = []
  return { pending }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const [from, to] = args
      await new Promise<void>((resolve) => hoisted.pending.push({ from: String(from), dest: String(to), release: resolve }))
      return actual.rename(from, to)
    },
  }
})

describe('hotfix 0.4.3', () => {
  it('dshHome/defaultMediaDir fall back to os.homedir(), never /tmp, when DSH_HOME and HOME are both unset', () => {
    const prevDsh = process.env.DSH_HOME
    const prevHome = process.env.HOME
    delete process.env.DSH_HOME
    delete process.env.HOME
    try {
      // The systemd host runs without HOME: the passwd-backed homedir() must
      // win so preset enumeration reads <home>/.agent-presets (web-3079.log
      // line 14429 scanned /tmp/.dsh/.agent-presets).
      expect(dshHome()).toBe(join(homedir(), '.dsh'))
      expect(dshHome().startsWith('/tmp')).toBe(false)
      expect(defaultMediaDir()).toBe(join(homedir(), '.dsh', 'media', 'onebot'))
    } finally {
      if (prevDsh !== undefined) process.env.DSH_HOME = prevDsh
      if (prevHome !== undefined) process.env.HOME = prevHome
    }
  })

  it('back-to-back retired-sessions saves are serialized: no rename race and the newest snapshot wins', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-test-'))
    const logLines: string[] = []
    const registry = new ChatRegistry({
      agents: undefined as never,
      sessions: undefined as never,
      sessionPersistence: undefined,
      workspaceRegistry: undefined,
      agentPresets: undefined,
      defaultModel: undefined,
      config: {
        mediaDir, workspacePath: '', agentPreset: '', restrictedMemberPrefix: false,
        maxImageBytes: 8 * 1024 * 1024, maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
        chatIdleEvictDays: 30,
      },
      log: (level, message) => { logLines.push(level + ': ' + message) },
      isStopping: () => false,
      onChatRemoved: () => undefined,
      installChannelScope: () => undefined,
    })
    const saveRetired = (): Promise<void> => (registry as unknown as { saveRetired(): Promise<void> }).saveRetired()

    registry.retiredSessionIds.add('onebot-private-10001-a')
    const first = saveRetired()
    await vi.waitFor(() => expect(hoisted.pending.length).toBe(1))

    registry.retiredSessionIds.add('onebot-private-10001-b')
    const second = saveRetired()
    // The second save is queued behind the first: no second rename is in
    // flight while the first is still pending (the old design ran both at
    // once, and the older snapshot could land last and drop '-b').
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(hoisted.pending.length).toBe(1)

    hoisted.pending[0].release()
    await first
    await vi.waitFor(() => expect(hoisted.pending.length).toBe(2))
    expect(hoisted.pending[0].dest).toBe(hoisted.pending[1].dest)
    expect(hoisted.pending[0].from).not.toBe(hoisted.pending[1].from)
    hoisted.pending[1].release()
    await second

    expect(logLines.some((line) => line.includes('保存失败'))).toBe(false)
    // The last write rendered the newest state: both ids are durable.
    const final = JSON.parse(await readFile(join(mediaDir, 'retired-sessions.json'), 'utf8')) as string[]
    expect(final).toEqual(['onebot-private-10001-a', 'onebot-private-10001-b'])
  })
})
