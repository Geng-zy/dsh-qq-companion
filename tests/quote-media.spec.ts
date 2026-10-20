/**
 * Quoted (reply) messages go through the same media path as direct ones:
 * a quoted image is fetched (annotated with a local path she can open), a
 * quoted voice is transcribed, a quoted merged forward (聊天记录) is
 * expanded — instead of reaching her as bare [图片]/[语音]/[合并转发]
 * placeholders. A quote never changes the /ocr target.
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

  it('a quoted image does not become the /ocr target', async () => {
    const h = await makeCmdHarness()
    answerGetMsg(h, {
      message: [{ type: 'image', data: { file: 'base64://' + png } }], raw_message: '[CQ:image,file=base64://...]', sender: { nickname: '小红' },
    })
    h.client.send(quoting('看看'))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const settings = (h.bridge as unknown as { registry: { getSettings(id: string): { lastImagePath?: string } } }).registry.getSettings('group:888')
    expect(settings.lastImagePath).toBeUndefined()
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
