/**
 * an admin's private chat defaults to config.adminPreset and
 * each NEW admin private session gets config.adminPermission; group chats and
 * other users keep config.agentPreset and the host default permission.
 * @module dsh-qq-companion/tests/companion-admin-defaults
 */
import { describe, expect, it, vi } from 'vitest'

import { makeCmdHarness } from './helpers/bridge-harness.js'

function makePresets() {
  const resolve = vi.fn(async (id?: string) => ({ id: id ?? 'standard' }))
  const mount = vi.fn(async (_agentCtx: unknown, id?: string) => ({ id: id ?? 'standard' }))
  return { defaultId: 'standard', resolve, mount }
}

function makeCommands() {
  const lines: string[] = []
  const execute = vi.fn(async (_agent: unknown, line: string) => {
    lines.push(line)
    return { commandId: 'cmd-test', result: { kind: 'success', text: 'ok' } }
  })
  return { commands: { execute }, lines }
}

describe('admin private-chat defaults', () => {
  it('an admin private chat gets adminPreset and the adminPermission switch on creation', async () => {
    const presets = makePresets()
    const { commands, lines } = makeCommands()
    const h = await makeCmdHarness({ agentPresets: presets, commands, adminPreset: 'companion', adminPermission: 'danger-full-access' })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.capturedMeta[0].agentPreset).toBe('companion')
    expect(presets.mount).toHaveBeenLastCalledWith(expect.anything(), 'companion')
    expect(lines).toEqual(['/permission danger-full-access'])

    // /new re-creates the session: the defaults apply again.
    h.sendText('/new')
    await vi.waitFor(() => expect(h.chats().has('private:10001')).toBe(false))
    h.sendText('再来')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.capturedMeta[1].agentPreset).toBe('companion')
    expect(lines.filter(l => l.startsWith('/permission'))).toEqual(['/permission danger-full-access', '/permission danger-full-access'])

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('a /preset override still wins over adminPreset', async () => {
    const presets = makePresets()
    const { commands } = makeCommands()
    const h = await makeCmdHarness({ agentPresets: presets, commands, adminPreset: 'companion' })
    h.sendText('/preset standard')
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('预设已切换：standard'))).toBe(true)
    })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.capturedMeta.at(-1)?.agentPreset).toBe('standard')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('group chats keep agentPreset and get no permission switch, even for the admin', async () => {
    const presets = makePresets()
    const { commands, lines } = makeCommands()
    const h = await makeCmdHarness({ agentPresets: presets, commands, adminPreset: 'companion', adminPermission: 'danger-full-access' })
    h.sendGroupTextAs('大家好', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.capturedMeta[0].agentPreset).toBe('standard')
    expect(lines).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('without the new config keys the behavior is unchanged', async () => {
    const presets = makePresets()
    const { commands, lines } = makeCommands()
    const h = await makeCmdHarness({ agentPresets: presets, commands })
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.capturedMeta[0].agentPreset).toBe('standard')
    expect(lines).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('/preset override persistence', () => {
  it('a /preset choice survives a restart', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const mediaDir = mkdtempSync(join(tmpdir(), 'preset-persist-'))
    const presets = makePresets()
    const h1 = await makeCmdHarness({ agentPresets: presets, mediaDir })
    h1.sendText('/preset standard-2')
    await vi.waitFor(() => {
      expect(h1.outbound.some(f => JSON.stringify(f.params).includes('预设已切换：standard-2'))).toBe(true)
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    h1.client.close()
    await h1.bridge.stop()
    await h1.connection.stop()

    const h2 = await makeCmdHarness({ agentPresets: makePresets(), mediaDir })
    h2.sendText('你好')
    await vi.waitFor(() => expect(h2.captured.followups).toHaveLength(1))
    expect(h2.capturedMeta[0].agentPreset).toBe('standard-2')
    h2.client.close()
    await h2.bridge.stop()
    await h2.connection.stop()
  })
})
