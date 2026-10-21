/**
 * Group chatter: context of unseen lines when she is called, her names and
 * the person she just answered count as calling her, and periodic looks
 * skip groups she is talking in.
 * @module dsh-qq-companion/tests/group-chatter
 */
import { describe, expect, it, vi } from 'vitest'

import { GroupChatter, type GroupChatterConfig } from '../src/companion/index.js'
import { makeCmdHarness } from './helpers/bridge-harness.js'

const config: GroupChatterConfig = {
  contextLines: 15, names: ['大肥鱼', '肥鱼'], followupSeconds: 180,
  peekEnabled: true, peekGapMinutes: 30, peekMinMessages: 3, peekQuietMinutes: 10,
  peekWindowStart: '00:00', peekWindowEnd: '24:00',
}

/** A group message from `userId` that @-s nobody. */
const plain = (text: string, userId: number) => JSON.stringify({
  post_type: 'message', message_type: 'group', user_id: userId, group_id: 888, self_id: 10002,
  message: [{ type: 'text', data: { text } }], raw_message: text,
  sender: { user_id: userId, nickname: '用户' + userId },
})

describe('GroupChatter', () => {
  it('context: unseen lines minus the calling one, then they count as seen', () => {
    let now = 1_000_000
    const c = new GroupChatter({ config, now: () => now })
    for (const t of ['一', '二', '三']) { now += 1000; c.observe('1', '9', '小王', t) }
    now += 1000; c.observe('1', '8', '小李', '@她 在吗')
    const ctx = c.takeContext('1')
    expect(ctx).toContain('小王（9）：一')
    expect(ctx).toContain('小王（9）：三')
    expect(ctx).not.toContain('在吗')
    now += 1000; c.observe('1', '8', '小李', '@她 再问一次')
    expect(c.takeContext('1')).toBe('')
  })

  it('names and the follow-up window', () => {
    let now = 1_000_000
    const c = new GroupChatter({ config, now: () => now })
    expect(c.callsByName('肥鱼你说呢')).toBe(true)
    expect(c.callsByName('今天吃鱼')).toBe(false)
    c.noteCalled('1', '8')
    c.noteSpoke('1')
    now += 60_000
    expect(c.isFollowup('1', '8')).toBe(true)
    expect(c.isFollowup('1', '9')).toBe(false)
    now += 200_000
    expect(c.isFollowup('1', '8')).toBe(false)
  })

  it('a look needs enough new lines, a gap since the last look, and her quiet for a while', () => {
    let now = 10 * 3_600_000
    const c = new GroupChatter({ config, now: () => now })
    for (let i = 0; i < 3; i++) { now += 1000; c.observe('1', '9', '小王', '话' + i) }
    expect(c.peekDue(['1'])).toEqual(['1'])
    c.noteSpoke('1')
    expect(c.peekDue(['1'])).toEqual([])
    now += 11 * 60_000
    for (let i = 0; i < 3; i++) { now += 1000; c.observe('1', '9', '小王', '又' + i) }
    expect(c.peekDue(['1'])).toEqual(['1'])
    const text = c.takePeek('1', '[不发]')
    expect(text).toContain('又2')
    expect(text).toContain('[不发]')
    for (let i = 0; i < 3; i++) { now += 1000; c.observe('1', '9', '小王', '再' + i) }
    expect(c.peekDue(['1'])).toEqual([])
    now += 31 * 60_000
    expect(c.peekDue(['1'])).toEqual(['1'])
  })

  it('no look outside the window', () => {
    const c = new GroupChatter({ config: { ...config, peekWindowStart: '09:00', peekWindowEnd: '10:00' }, now: () => new Date(2026, 9, 21, 8, 0).getTime() })
    for (let i = 0; i < 3; i++) c.observe('1', '9', '小王', '话' + i)
    expect(c.peekDue(['1'])).toEqual([])
  })
})

describe('group chatter in the bridge', () => {
  it('a name calls her with the group context; the person she answered goes on without an @; others do not', async () => {
    const chatter = new GroupChatter({ config })
    const h = await makeCmdHarness({ groupChatter: chatter })
    h.client.send(plain('昨晚的副本好难', 10003))
    h.client.send(plain('大肥鱼你玩过吗', 10004))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const first = h.captured.followups[0].text
    expect(first).toContain('[叫到我]')
    expect(first).toContain('<group_context>')
    expect(first).toContain('昨晚的副本好难')
    await h.bridge.sendToChat('group:888' as never, '没玩过诶', { humanize: true })
    h.client.send(plain('那你玩啥', 10004))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('[接着和我说]')
    h.client.send(plain('我也想知道', 10003))
    h.sendGroupTextAs('在吗', 10005)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(3))
    expect(h.captured.followups[2].text).toContain('在吗')
    expect(h.captured.followups[2].text).toContain('我也想知道') // as context, not as a call
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('a look goes to the group as a pass-able turn', async () => {
    const chatter = new GroupChatter({ config })
    const h = await makeCmdHarness({ groupChatter: chatter })
    h.sendGroupTextAs('先建个会话', 10003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await vi.waitFor(() => expect((h.bridge as unknown as { chats: Map<string, { busy: boolean }> }).chats.get('group:888')?.busy).toBe(false))
    for (const t of ['一', '二', '三']) h.client.send(plain(t, 10006))
    await vi.waitFor(() => expect(chatter.knownGroups()).toContain('888'))
    await new Promise(resolve => setTimeout(resolve, 100))
    await h.bridge.firePeek('888')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('[看一眼群聊')
    expect(h.captured.followups[1].text).toContain('三')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('follow-ups addressed to someone else', () => {
  it('a follow-up that @-s someone else or replies to someone else is not for her', async () => {
    const chatter = new GroupChatter({ config })
    const h = await makeCmdHarness({ groupChatter: chatter })
    h.sendGroupTextAs('你吃了吗', 10004)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    await h.bridge.sendToChat('group:888' as never, '吃了吃了', { humanize: true })
    // @-ing someone else
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 10004, group_id: 888, self_id: 10002,
      message: [{ type: 'at', data: { qq: '10009' } }, { type: 'text', data: { text: ' 晚上打游戏吗' } }],
      raw_message: '[CQ:at,qq=10009] 晚上打游戏吗', sender: { user_id: 10004, nickname: '用户10004' },
    }))
    // replying to someone else's message
    const realCall = h.connection.call
    h.connection.call = (async (action: string, params: unknown) => {
      if (action === 'get_msg') return { message: [{ type: 'text', data: { text: '去哪' } }], raw_message: '去哪', sender: { user_id: 10009, nickname: '小李' } }
      return await realCall(action, params)
    }) as never
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: 10004, group_id: 888, self_id: 10002,
      message: [{ type: 'reply', data: { id: 77 } }, { type: 'text', data: { text: '海底捞' } }],
      raw_message: '[CQ:reply,id=77]海底捞', sender: { user_id: 10004, nickname: '用户10004' },
    }))
    // a plain follow-up still counts
    h.client.send(plain('你呢', 10004))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(h.captured.followups[1].text).toContain('[接着和我说]')
    expect(h.captured.followups[1].text).toContain('你呢')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.captured.followups).toHaveLength(2)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('several people talking with her', () => {
  it('B calling her does not cut A off; each keeps their own window', () => {
    let now = 1_000_000
    const c = new GroupChatter({ config, now: () => now })
    c.noteCalled('1', 'A'); c.noteSpoke('1')
    now += 60_000
    c.noteCalled('1', 'B'); c.noteSpoke('1')
    expect(c.isFollowup('1', 'A')).toBe(true)
    expect(c.isFollowup('1', 'B')).toBe(true)
    now += 130_000 // A answered 190s ago, B 130s ago
    expect(c.isFollowup('1', 'A')).toBe(false)
    expect(c.isFollowup('1', 'B')).toBe(true)
  })
})
