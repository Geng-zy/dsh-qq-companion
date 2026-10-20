/**
 * Voice messages wait for their transcript: the transcript is part of the
 * message she gets, so she answers what was said. Failure, an empty result
 * or a transcription slower than the wait limit hands the message over as a
 * bare [语音]; with transcription off nothing is fetched at all.
 * @module dsh-qq-companion/tests/stt-wait
 */
import { describe, expect, it, vi } from 'vitest'

import { InboundPipeline } from '../src/inbound.js'
import type { InboundContext } from '../src/inbound.js'

import { makeHarness } from './helpers/bridge-harness.js'

/** Minimal pipeline context for direct resolveMediaRef tests (voice path). */
function makePipelineCtx(transcribe: (path: string) => Promise<string>, logs: string[]): InboundContext {
  return {
    call: vi.fn(async () => undefined),
    selfId: () => '10002',
    policy: { dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [], adminUsers: [], allowAllUsers: false, requireMention: true },
    getChat: () => undefined,
    getSettings: () => ({}),
    sweepIdleChats: async () => undefined,
    media: { resolve: async () => ({ kind: 'voice', path: '/tmp/voice-1.mp3' }) } as never,
    transcriber: { enabled: true, transcribe } as never,
    tryHandleCommand: async () => false,
    dispatchFollowup: async () => undefined,
    sendToChat: async () => [],
    log: (level, message) => { logs.push(level + ': ' + message) },
    config: { botQQ: '10002', ignoreSelf: false, requireMention: true, rateLimitPerMinute: 0, restrictedMemberPrefix: false, maxInboundFileBytes: 0 },
  } as never
}

const voiceEvent = {
  post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
  message: [{ type: 'record', data: { file: 'base64://' + Buffer.from('fake-mp3-bytes').toString('base64') } }],
  raw_message: '[CQ:record,file=base64://...]',
  sender: { user_id: 10001, nickname: '小明' },
}

describe('voice transcript wait', () => {
  it('with transcription off, a voice message fetches and converts nothing', async () => {
    const ctx = makePipelineCtx(async () => 'x', [])
    const resolve = vi.fn(async () => ({ kind: 'voice', path: '/tmp/v.mp3' }))
    Object.assign(ctx, { transcriber: { enabled: false }, media: { resolve } })
    const pipeline = new InboundPipeline(ctx)
    const annotation = await pipeline.resolveMediaRef({ kind: 'voice', file: 'abc.amr', url: 'https://x/v.amr' }, 'private:10001')
    expect(annotation).toBe('[语音]')
    expect(ctx.call).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('the transcript becomes part of the message', async () => {
    const logs: string[] = []
    const transcribe = vi.fn(async () => '今晚吃火锅吗')
    const pipeline = new InboundPipeline(makePipelineCtx(transcribe, logs))
    const annotation = await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')
    expect(annotation).toBe('[语音]（语音转写：今晚吃火锅吗）')
    expect(transcribe).toHaveBeenCalledWith('/tmp/voice-1.mp3')
    expect(logs.some(l => l.startsWith('info: 语音转写完成（6 字'))).toBe(true)
  })

  it('a failed transcription hands the message over as a bare [语音]', async () => {
    const logs: string[] = []
    const pipeline = new InboundPipeline(makePipelineCtx(async () => { throw new Error('STT command timed out after 60000ms') }, logs))
    expect(await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')).toBe('[语音]')
    expect(logs.some(line => line.startsWith('warn: STT failed'))).toBe(true)
  })

  it('silence (empty transcript) keeps the bare placeholder', async () => {
    const pipeline = new InboundPipeline(makePipelineCtx(async () => '', []))
    expect(await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')).toBe('[语音]')
  })

  it('a transcription slower than the wait limit is not waited for', async () => {
    const logs: string[] = []
    const pipeline = new InboundPipeline(makePipelineCtx(() => new Promise<string>(() => undefined), logs), { voiceWaitMs: 30 })
    const started = Date.now()
    expect(await pipeline.resolveMediaRef({ kind: 'voice', url: 'https://x/v.mp3' }, 'private:10001')).toBe('[语音]')
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(logs.some(line => line.includes('还没转写完'))).toBe(true)
  })

  it('full pipeline: the turn starts only once the transcript is in, with the transcript in its text', async () => {
    let finish!: (text: string) => void
    const h = await makeHarness({
      transcriber: { enabled: true, transcribe: vi.fn(() => new Promise<string>(resolve => { finish = resolve })) } as never,
    })
    h.captured.steers = []
    h.client.send(JSON.stringify(voiceEvent))
    await vi.waitFor(() => expect(finish).toBeDefined())
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.captured.followups).toHaveLength(0)
    finish('好了')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toContain('[语音]（语音转写：好了）')
    expect(h.captured.steers).toEqual([])
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
