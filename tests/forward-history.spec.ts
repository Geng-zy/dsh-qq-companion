/**
 * Merged forwards in the shape current NapCat returns (plain message objects
 * with a top-level `message`), and qq_group_history handing her the lines
 * rather than just a count.
 * @module dsh-qq-companion/tests/forward-history
 */
import { describe, expect, it, vi } from 'vitest'

import { renderGroupHistory } from '../src/tools.js'
import { makeHarness } from './helpers/bridge-harness.js'

describe('merged forward, NapCat message-object shape', () => {
  it('reads each node from its top-level message; replies vanish, @ and the card name show', async () => {
    const h = await makeHarness()
    const real = h.connection.call.bind(h.connection)
    h.connection.call = (async (action: string, params: Record<string, unknown>) => {
      if (action === 'get_forward_msg') {
        return {
          messages: [
            { sender: { user_id: 30001, nickname: '昵称甲', card: '群名片甲' }, message: [{ type: 'text', data: { text: '第一季狠就狠在这' } }], raw_message: '第一季狠就狠在这' },
            { sender: { user_id: 30002, nickname: '乙' }, message: [{ type: 'reply', data: { id: '9' } }, { type: 'at', data: { qq: '30001' } }, { type: 'text', data: { text: '同意' } }], raw_message: '' },
          ],
        }
      }
      return await real(action, params)
    }) as never
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'forward', data: { id: 'fwd-9' } }], raw_message: '[CQ:forward,id=fwd-9]',
      sender: { user_id: 10001, nickname: '小明' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const text = h.captured.followups[0].text
    expect(text).toContain('群名片甲: 第一季狠就狠在这')
    expect(text).toContain('乙: @30001 同意')
    expect(text).not.toContain('未展开')
    expect(text).not.toContain('[非文本]')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('renderGroupHistory', () => {
  it('lists every message with time, name and QQ', () => {
    const t = Math.floor(new Date(2026, 9, 21, 16, 5).getTime() / 1000)
    const out = renderGroupHistory([
      { time: String(t), user_id: '30001', nickname: '小王', text: '晚上吃啥' },
      { time: String(t + 60), user_id: '30002', nickname: '小李', text: '[图片]' },
    ])
    expect(out).toContain('2 条历史消息')
    expect(out).toContain('[16:05] 小王（30001）：晚上吃啥')
    expect(out).toContain('[16:06] 小李（30002）：[图片]')
    expect(renderGroupHistory([])).toBe('没有拉到历史消息')
  })
})
