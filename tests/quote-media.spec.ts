/**
 * Quoted (reply) messages go through the same media path as direct ones:
 * a quoted image is fetched (annotated with a local path she can open), a
 * quoted voice is transcribed, a quoted merged forward (聊天记录) is
 * expanded — instead of reaching her as bare [图片]/[语音]/[合并转发]
 * placeholders.
 * @module dsh-qq-companion/tests/quote-media
 */
import { describe, expect, it, vi } from 'vitest'

import { makeCmdHarness, makeHarness } from './helpers/bridge-harness.js'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')

/** A group message quoting message 555 and @-ing the bot. */
const quoting = (text: string) => JSON.stringify({
  post_type: 'message', message_type: 'group', user_id: 10001, group_id: 888, self_id: 10002,
  message: [{ type: 'reply', data: { id: 555 } }, { type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text } }],
  raw_message: '[CQ:reply,id=555][CQ:at,qq=10002]' + text,
  sender: { user_id: 10001, nickname: '小明' },
})

type Harness = Awaited<ReturnType<typeof makeCmdHarness>>

function answerGetMsg(h: Harness, quoted: unknown, extra: Record<string, unknown> = {}): void {
  const realCall = h.connection.call.bind(h.connection)
  h.connection.call = (async (action: string, params: unknown) => {
    if (action === 'get_msg') return quoted
    if (action in extra) return extra[action]
    return await realCall(action, params)
  }) as never
}

async function stop(h: Harness): Promise<void> {
  h.client.close()
  await h.bridge.stop()
  await h.connection.stop()
}

describe('quoted media', () => {
  it('a quoted image is fetched and annotated with its local path', async () => {
    const h = await makeCmdHarness()
    answerGetMsg(h, {
      message: [{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: { file: 'base64://' + png } }],
      raw_message: '看这个[CQ:image,file=base64://...]', sender: { nickname: '小红' },
    })
    h.client.send(quoting('这张图里是什么'))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const text = h.captured.followups[0].text
    expect(text).toMatch(/\[引用\]小红: 看这个\[图片:[^\]]+\]/)
    expect(text).not.toMatch(/\[引用\][^\n]*\[图片\]/)
    await stop(h)
  })

  it('a quoted voice is transcribed', async () => {
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(async () => '明天几点出发') } as never,
    }) as unknown as Harness
    answerGetMsg(h, {
      message: [{ type: 'record', data: { file: 'base64://' + Buffer.from('fake-mp3').toString('base64') } }],
      raw_message: '[CQ:record,file=base64://...]', sender: { nickname: '小红' },
    })
    h.client.send(quoting('她说的你听到了吗'))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('[引用]小红: [语音]（语音转写：明天几点出发）')
    await stop(h)
  })

  it('a quoted merged forward (聊天记录) is expanded', async () => {
    const h = await makeCmdHarness()
    answerGetMsg(h, {
      message: [{ type: 'forward', data: { id: 'fw-1' } }], raw_message: '[CQ:forward,id=fw-1]', sender: { nickname: '小红' },
    }, {
      get_forward_msg: { messages: [
        { data: { nickname: '甲', message: [{ type: 'text', data: { text: '周六去爬山' } }] } },
        { data: { nickname: '乙', message: [{ type: 'text', data: { text: '好啊' } }] } },
      ] },
    })
    h.client.send(quoting('帮我总结一下'))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const text = h.captured.followups[0].text
    expect(text).toContain('[引用]小红: [合并转发]\n甲: 周六去爬山\n乙: 好啊')
    await stop(h)
  })

  it('a quote whose get_msg fails degrades to no quote, the message still goes through', async () => {
    const h = await makeCmdHarness()
    const realCall = h.connection.call.bind(h.connection)
    h.connection.call = (async (action: string, params: unknown) => {
      if (action === 'get_msg') throw new Error('message not found')
      return await realCall(action, params)
    }) as never
    h.client.send(quoting('还在吗'))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('还在吗')
    expect(h.captured.followups[0].text).not.toContain('[引用]小红')
    await stop(h)
  })
})

/** A group reply quoting message 555 without @-ing anyone. */
const replyOnly = (text: string) => JSON.stringify({
  post_type: 'message', message_type: 'group', user_id: 10003, group_id: 888, self_id: 10002,
  message: [{ type: 'reply', data: { id: 555 } }, { type: 'text', data: { text } }],
  raw_message: '[CQ:reply,id=555]' + text,
  sender: { user_id: 10003, nickname: '小李' },
})

describe('replies and mentions', () => {
  it('a reply to someone else is not for her; a reply to her own message is', async () => {
    const h = await makeCmdHarness()
    let quotedSender = 10004
    answerGetMsg(h, {})
    const realCall = h.connection.call
    h.connection.call = (async (action: string, params: unknown) => {
      if (action === 'get_msg') return { message: [{ type: 'text', data: { text: '原话' } }], raw_message: '原话', sender: { user_id: quotedSender, nickname: quotedSender === 10002 ? '大肥鱼' : '小王' } }
      return await realCall(action, params)
    }) as never
    h.client.send(replyOnly('哈哈哈'))
    h.sendGroupTextAs('在吗', 10003)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('在吗')
    quotedSender = 10002
    h.client.send(replyOnly('你说得对'))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    const text = h.captured.followups[1].text
    // The quote is spelled out once; her words are not tagged as a quote.
    expect(text).toContain('[引用]大肥鱼: 原话\n你说得对')
    expect(text.split('[引用]')).toHaveLength(2)
    await stop(h)
  })
})
