/**
 * "one line, one message" splitting of model final replies.
 * @module dsh-qq-companion/tests/companion-split
 */
import { describe, expect, it } from 'vitest'

import { OutboundPipeline } from '../src/outbound.js'
import type { SendOptions } from '../src/outbound.js'
import { splitHumanMessages, typingDelayMs } from '../src/split.js'

describe('splitHumanMessages', () => {
  it('splits a multi-line reply into trimmed non-empty lines', () => {
    expect(splitHumanMessages('呜 摸摸\n\n  是上班累还是心累呀 \n要不要宵夜', 6))
      .toEqual(['呜 摸摸', '是上班累还是心累呀', '要不要宵夜'])
  })

  it('keeps a single line as one message', () => {
    expect(splitHumanMessages('晚安主人～', 6)).toBeNull()
    expect(splitHumanMessages('晚安主人～\n\n', 6)).toBeNull()
  })

  it('keeps long structured replies (more lines than the cap) as one message', () => {
    const list = Array.from({ length: 7 }, (_, i) => String(i + 1) + '. 第' + String(i + 1) + '步').join('\n')
    expect(splitHumanMessages(list, 6)).toBeNull()
    expect(splitHumanMessages(list, 7)).toHaveLength(7)
  })

  it('treats a cap of 1 or less as splitting disabled', () => {
    expect(splitHumanMessages('a\nb', 1)).toBeNull()
    expect(splitHumanMessages('a\nb', 0)).toBeNull()
  })
})

describe('typingDelayMs', () => {
  it('scales with length and clamps to [min, max]', () => {
    expect(typingDelayMs('好', 80, 500, 2500)).toBe(500)
    expect(typingDelayMs('一二三四五六七八九十', 80, 500, 2500)).toBe(800)
    expect(typingDelayMs('字'.repeat(100), 80, 500, 2500)).toBe(2500)
  })

  it('counts an emoji as one character', () => {
    expect(typingDelayMs('😀😀😀😀😀😀😀😀😀😀', 100, 0, 10_000)).toBe(1000)
  })
})

describe('OutboundPipeline humanized sends', () => {
  function makePipeline(config: Partial<{ splitLines: boolean; splitMaxMessages: number }> = {}) {
    const sent: Array<{ action: string; params: Record<string, unknown> }> = []
    const sleeps: number[] = []
    let nextId = 100
    const pipeline = new OutboundPipeline({
      getChat: () => ({ lastNickname: '' }),
      connected: () => true,
      selfId: () => '10002',
      call: async (action, params) => {
        sent.push({ action, params: params as Record<string, unknown> })
        return { message_id: nextId++ }
      },
      isStopping: () => false,
      log: () => undefined,
      config: {
        botQQ: '10002', sensitivePatterns: [], textImageThreshold: 0, maxImageBytes: 8 * 1024 * 1024,
        cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        typingDelayPerCharMs: 80, typingDelayMinMs: 500, typingDelayMaxMs: 2500,
        ...config,
      },
    }, { sleep: async ms => { sleeps.push(ms) } })
    const texts = () => sent.map(f => ((f.params.message as Array<{ type: string; data: { text?: string } }>)
      .find(s => s.type === 'text')?.data.text) ?? '')
    return { pipeline, sent, sleeps, texts }
  }

  const reply = '呜 摸摸\n是上班累还是心累呀\n要不要一起点个宵夜'
  const final: SendOptions = { queuable: true, humanize: true }

  it('sends a final reply line by line with a typing pause before each follow-up', async () => {
    const h = makePipeline({ splitLines: true })
    const ids = await h.pipeline.sendToChat('private:10001', reply, final)
    expect(h.texts()).toEqual(['呜 摸摸', '是上班累还是心累呀', '要不要一起点个宵夜'])
    expect(ids).toEqual(['100', '101', '102'])
    // No pause before the first line; then length-based pauses.
    expect(h.sleeps).toEqual([typingDelayMs('是上班累还是心累呀', 80, 500, 2500), typingDelayMs('要不要一起点个宵夜', 80, 500, 2500)])
  })

  it('quotes the replied-to message on the first line only', async () => {
    const h = makePipeline({ splitLines: true })
    await h.pipeline.sendToChat('group:20001', reply, { ...final, replyTo: '555' })
    const firstSegs = h.sent[0].params.message as Array<{ type: string }>
    const secondSegs = h.sent[1].params.message as Array<{ type: string }>
    expect(firstSegs[0].type).toBe('reply')
    expect(secondSegs.some(s => s.type === 'reply')).toBe(false)
  })

  it('leaves non-final sends (commands, notices) as one message even when enabled', async () => {
    const h = makePipeline({ splitLines: true })
    await h.pipeline.sendToChat('private:10001', reply, { queuable: true })
    await h.pipeline.sendToChat('private:10001', reply)
    expect(h.sent).toHaveLength(2)
    expect(h.sleeps).toEqual([])
  })

  it('is off by default (upstream behavior unchanged)', async () => {
    const h = makePipeline()
    await h.pipeline.sendToChat('private:10001', reply, final)
    expect(h.texts()).toEqual([reply])
  })

  it('sends a reply longer than splitMaxMessages lines as one message', async () => {
    const h = makePipeline({ splitLines: true, splitMaxMessages: 2 })
    await h.pipeline.sendToChat('private:10001', reply, final)
    expect(h.texts()).toEqual([reply])
  })
})

describe('OutboundPipeline durable offline queue', () => {
  it('replies queued while disconnected survive a restart and drain on reconnect', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'pending-'))
    const mk = (connected: () => boolean, sent: string[]) => new OutboundPipeline({
      getChat: () => ({ lastNickname: '' }),
      connected,
      selfId: () => '10002',
      call: async (_action, params) => {
        const seg = ((params as { message: Array<{ data: { text?: string } }> }).message[0])
        sent.push(seg.data.text ?? '')
        return { message_id: 1 }
      },
      isStopping: () => false,
      log: () => undefined,
      config: { botQQ: '10002', sensitivePatterns: [], textImageThreshold: 0, maxImageBytes: 1 << 23, cardFooter: 'dsh', fontFiles: [], fontFamilies: [], mediaDir: dir },
    })
    const sent1: string[] = []
    const before = mk(() => false, sent1)
    await before.sendToChat('private:10001', '断线时的回复', { queuable: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    // "Restart": a fresh pipeline over the same mediaDir.
    const sent2: string[] = []
    const after = mk(() => true, sent2)
    await after.loadPending()
    after.drainPendingSends()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sent2).toEqual(['断线时的回复'])
    expect(sent1).toEqual([])
  })
})
