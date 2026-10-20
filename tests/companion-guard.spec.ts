/**
 * Fabricated transcript continuations are cut before QQ; groups that leave
 * the allowlist have their sessions retired.
 * @module dsh-qq-companion/tests/companion-guard
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { cutFabricatedContext } from '../src/companion/index.js'
import { GroupAccess } from '../src/groups.js'

import { makeCmdHarness } from './helpers/bridge-harness.js'

// The real case (2026-10-20), with the QQ number replaced.
const LEAKED = '喂 肚皮是禁区\n\n挠了会笑 笑了会打嗝 打嗝会停不下来\n\n换个地方 头可以摸 呆毛轻轻碰\n\n---\n\n' +
  '[09:57 某群友(123450001)] 撤回了一条消息\n\nWait, I shouldn\'t fabricate. Let me check: there is no such message.\n\n' +
  'Correct: just the 3 lines above.喂 肚皮是禁区\n\n挠了会笑 笑了会打嗝 打嗝会停不下来\n\n换个地方 头可以摸 呆毛轻轻碰'

describe('cutFabricatedContext', () => {
  it('cuts from the first fake header line, dropping the separator before it', () => {
    expect(cutFabricatedContext(LEAKED)).toEqual({
      text: '喂 肚皮是禁区\n\n挠了会笑 笑了会打嗝 打嗝会停不下来\n\n换个地方 头可以摸 呆毛轻轻碰',
      cut: true,
    })
  })

  it('catches the restricted-member prefix and the message wrapper', () => {
    expect(cutFabricatedContext('好呀\n[受限用户:仅问答] [10:01 小王(888000123)][@我] 再来').text).toBe('好呀')
    expect(cutFabricatedContext('嗯嗯\n<user_message qq="1">').text).toBe('嗯嗯')
    expect(cutFabricatedContext('[10:01 小王(888000123)] 全是编的').text).toBe('')
  })

  it('leaves normal replies alone', () => {
    for (const ok of ['现在是 [10:30] 啦', '我的 QQ 是 (12345)', '[开心] 今天吃了 3 碗饭', '时间 09:57，地点(一楼)', '---\n分割线也没事']) {
      expect(cutFabricatedContext(ok)).toEqual({ text: ok, cut: false })
    }
  })
})

describe('bridge sends only the real reply', () => {
  it('a final reply with a fabricated tail sends just the reply, and a fully fabricated one sends nothing', async () => {
    const logs: string[] = []
    const h = await makeCmdHarness({ log: (_l, m) => logs.push(m) })
    await h.bridge.sendToChat('group:888' as never, LEAKED, { humanize: true })
    await vi.waitFor(() => expect(h.outbound.some(o => JSON.stringify(o).includes('呆毛轻轻碰'))).toBe(true))
    const sent = JSON.stringify(h.outbound)
    expect(sent).not.toContain('123450001')
    expect(sent).not.toContain('fabricate')
    expect(sent.split('呆毛轻轻碰').length - 1).toBe(1)
    const before = h.outbound.length
    expect(await h.bridge.sendToChat('group:888' as never, '[10:01 小王(888000123)] 编的', {})).toEqual([])
    expect(h.outbound.length).toBe(before)
    expect(logs.join()).toContain('编造内容')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('groups leaving the allowlist', () => {
  it('/group remove retires the session; a re-allowed group starts fresh', async () => {
    const allow = ['888']
    const h = await makeCmdHarness({ groupPolicy: 'allowlist', groupAllowFrom: allow })
    const access = new GroupAccess({ policy: { groupAllowFrom: allow, groupPolicy: 'allowlist' }, mediaDir: mkdtempSync(join(tmpdir(), 'guard-')), log: () => undefined })
    access.onRemoved = id => h.bridge.retireGroup(id)
    h.sendGroupTextAs('大家好', 10005)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const first = h.captured.followups[0].sessionId
    expect(await access.remove('888')).toBe('removed')
    // The harness policy keeps its own array: mirror the effective list.
    allow.splice(0, allow.length)
    h.sendGroupTextAs('还在吗', 10005)
    await new Promise(r => setTimeout(r, 200))
    expect(h.captured.followups).toHaveLength(1) // not allowed: ignored
    allow.push('888')
    h.sendGroupTextAs('我又回来了', 10005)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].sessionId).not.toBe(first)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('on startup, sessions of groups no longer allowed are retired; allowed ones and private chats stay', async () => {
    const allow = ['888']
    const h = await makeCmdHarness({ groupPolicy: 'allowlist', groupAllowFrom: allow })
    h.sendGroupTextAs('大家好', 10005)
    h.sendText('主人在')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const groupSession = h.captured.followups.find(f => f.text.includes('大家好'))!.sessionId
    const privateSession = h.captured.followups.find(f => f.text.includes('主人在'))!.sessionId
    await h.bridge.retireDisallowedGroups()
    h.sendGroupTextAs('还是这个会话', 10005)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    expect(h.captured.followups[2].sessionId).toBe(groupSession)
    allow.splice(0, allow.length) // dropped from the config while dsh was down
    await h.bridge.retireDisallowedGroups()
    allow.push('888')
    h.sendGroupTextAs('新会话了吧', 10005)
    h.sendText('私聊不受影响')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(5))
    expect(h.captured.followups.find(f => f.text.includes('新会话了吧'))!.sessionId).not.toBe(groupSession)
    expect(h.captured.followups.find(f => f.text.includes('私聊不受影响'))!.sessionId).toBe(privateSession)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
