/**
 * Outbound tests (send chain, offline queue, write gate, image cards,
 * host card relay) on the shared makeHarness. The three golden end-to-end cases
 * stay in bridge.spec.ts — they are the cross-module full-pipeline gate.
 * @module dsh-qq-companion/tests/outbound
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OneBotActionError, OneBotNotConnectedError } from '../src/connection.js'
import { ACTION_AUDIT_FILE, OutboundPipeline } from '../src/outbound.js'

import { inboundAndDisconnect, makeCmdHarness, makeEvent, makeHarness, reconnect, sentTexts } from './helpers/bridge-harness.js'

// Test isolation (0.6.0 flake hygiene): a test failing mid-way must never leak
// fake timers into the rest of the file (mirrors connection.spec.ts).
afterEach(() => {
  vi.useRealTimers()
})

describe('outbound pipeline', () => {
  it('renders a t2i card for long replies (image segment)', async () => {
    const h = await makeHarness({ textImageThreshold: 10 })
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    const longText = '这是一段非常长的回复内容，长度超过了阈值十，因此应该渲染成文字图卡片发送，而不是分段文本。'.repeat(2)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('base64://'))).toBe(true)
    })
    const imageFrame = h.outbound.find(f => f.action === 'send_msg')!
    const segments = imageFrame.params.message as Array<{ type: string }>
    expect(segments.some(s => s.type === 'image')).toBe(true)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('falls back to a single plain text message when the card exceeds maxImageBytes', async () => {
    const h = await makeHarness({ textImageThreshold: 10, maxImageBytes: 500 })
    h.sendText('hi')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }
    const longText = '这是一段非常长的回复内容，图片超限，应该回退为分段文本发送。'.repeat(2)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: longText }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await vi.waitFor(() => {
      expect(h.outbound.filter(f => f.action === 'send_msg')).toHaveLength(1)
    })
    const textFrame = h.outbound.find(f => f.action === 'send_msg')!
    const segments = textFrame.params.message as Array<{ type: string; data: { text: string } }>
    expect(segments.filter(s => s.type === 'text').map(s => s.data.text).join('')).toBe(longText)
    expect(h.outbound.some(f => JSON.stringify(f.params).includes('base64://'))).toBe(false)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 60_000)

  it('queues interim-mode final flushes while disconnected and resends them in order on reconnect', async () => {
    const h = await makeHarness()
    const session = await inboundAndDisconnect(h)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终回复一' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // Let settle-loop #1 park its final before the next cycle starts, or the
    // next assistant/message proves it interim (bridge semantics) and drops it.
    await new Promise(resolve => setTimeout(resolve, 50))
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终回复二' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }))
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      const texts = sentTexts(outbound2)
      expect(texts.some(t => t.includes('最终回复一'))).toBe(true)
      expect(texts.some(t => t.includes('最终回复二'))).toBe(true)
    })
    const texts = sentTexts(outbound2)
    expect(texts.findIndex(t => t.includes('最终回复一'))).toBeLessThan(texts.findIndex(t => t.includes('最终回复二')))
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('queues instant finals and error notices while disconnected and resends them in order', async () => {
    const h = await makeHarness({ interimMessages: false })
    const session = await inboundAndDisconnect(h)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终答案' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', {
      turn: 2, reason: { kind: 'error', error: { code: 'E_TEST', message: '模型炸了' } },
    }))
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      const texts = sentTexts(outbound2)
      expect(texts.some(t => t.includes('最终答案'))).toBe(true)
      expect(texts.some(t => t.includes('运行出错'))).toBe(true)
    })
    const texts = sentTexts(outbound2)
    expect(texts.findIndex(t => t.includes('最终答案'))).toBeLessThan(texts.findIndex(t => t.includes('运行出错')))
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('does not queue interim sends while disconnected', async () => {
    const h = await makeHarness()
    const session = await inboundAndDisconnect(h)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', toolName: 'x' }, { type: 'text', text: '中间过程' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(sentTexts(outbound2)).toHaveLength(0)
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('caps the per-chat queue at 20 and drops the oldest while disconnected', async () => {
    const h = await makeHarness({ interimMessages: false })
    const session = await inboundAndDisconnect(h)
    for (let i = 1; i <= 21; i++) {
      h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
        turn: i, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '最终答案' + i }] },
      }))
      h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: i, reason: { kind: 'completed' } }))
    }
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => expect(sentTexts(outbound2).some(t => t.includes('最终答案21"'))).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 200))
    const finals = sentTexts(outbound2).filter(t => t.includes('最终答案'))
    expect(finals).toHaveLength(20)
    expect(finals.some(t => t.includes('最终答案1"'))).toBe(false)
    expect(finals[0].includes('最终答案2"')).toBe(true)
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('drops queued finals older than the TTL instead of resending them', async () => {
    const h = await makeHarness()
    const session = await inboundAndDisconnect(h)
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '过期回复' }] },
    }))
    h.ctx.emit('session/event', session as never, makeEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    // Deterministic isolation fix (0.6.0 flake): wait until the settle loop has
    // actually PARKED the final itself before jumping the clock — the former
    // fixed 50ms sleep raced the park; a park landing after the jump stamped a
    // post-jump sentAt and the entry then never expired (resent, test failed).
    // The queue holds the summary card too, so match the final's text, not a
    // count.
    const parkedTexts = (): string[] =>
      ((h.bridge as unknown as { outbound: { pendingSends: Map<string, Array<{ text: string }>> } }).outbound)
        .pendingSends.get('private:10001')?.map(item => item.text) ?? []
    await vi.waitFor(() => expect(parkedTexts().some(t => t.includes('过期回复'))).toBe(true))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.advanceTimersByTime(5 * 60_000 + 1_000)
      const { client: client2, outbound: outbound2 } = await reconnect(h)
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(sentTexts(outbound2).some(t => t.includes('过期回复'))).toBe(false)
      client2.close()
    } finally {
      vi.useRealTimers()
    }
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('sendToChat while disconnected: queuable final parks and drains on reconnect, non-queuable throws', async () => {
    const h = await makeHarness()
    await inboundAndDisconnect(h)
    await expect(h.bridge.sendToChat('private:10001', '排队最终回复', { queuable: true })).resolves.toEqual([])
    await expect(h.bridge.sendToChat('private:10001', '即时回复')).rejects.toThrow(OneBotNotConnectedError)
    const { client: client2, outbound: outbound2 } = await reconnect(h)
    await vi.waitFor(() => {
      expect(sentTexts(outbound2).some(t => t.includes('排队最终回复'))).toBe(true)
    })
    expect(sentTexts(outbound2).some(t => t.includes('即时回复'))).toBe(false)
    client2.close()
    await h.bridge.stop()
    await h.connection.stop()
  }, 30_000)

  it('relays host plan books and option cards to the chat (exit_plan_mode / ask_user_question)', async () => {
    const h = await makeCmdHarness()
    h.sendText('你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const session = { id: h.sessionIds[0] }

    // A plan review tool call (empty text block) must still reach QQ.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'relay-plan-1', content: [
        { type: 'text', text: '' },
        { type: 'tool-call', id: 'c1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 测试计划\n\n实现 A 与 B。' }) },
      ] },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('计划书'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('实现 A 与 B'))).toBe(true)
    })

    // Re-emitting the same message id consecutively (streaming/usage) must not
    // double-relay — dedupe keys on the latest handled id, re-emits arrive in order.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'relay-plan-1', content: [
        { type: 'tool-call', id: 'c1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 测试计划\n\n实现 A 与 B。' }) },
      ] },
    }))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.outbound.filter(f => JSON.stringify(f.params).includes('计划书'))).toHaveLength(1)

    // An option card (ask_user_question) with questions/options.
    h.ctx.emit('session/event', session as never, makeEvent('assistant/message', {
      turn: 1, step: 2, message: { role: 'assistant', id: 'relay-q-1', content: [
        { type: 'tool-call', id: 'c2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [
          { id: 'q1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B' }], multi_select: true },
        ] }) },
      ] },
    }))
    await vi.waitFor(() => {
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('选哪个方案？'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('方案A'))).toBe(true)
      expect(h.outbound.some(f => JSON.stringify(f.params).includes('可多选'))).toBe(true)
    })

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})

describe('outbound tool-send audit', () => {
  /** Minimal OutboundPipeline harness: a connected fake transport capturing
   * every send action, optional audit dir, an injected monotonic clock. */
  const makeAuditHarness = (opts?: { mediaDir?: string }) => {
    const sent: Array<{ action: string; params: Record<string, unknown> }> = []
    const logs: string[] = []
    let clock = 1_700_000_000_000
    const pipeline = new OutboundPipeline({
      getChat: () => ({ lastNickname: '' }),
      connected: () => true,
      selfId: () => '10002',
      call: async (action, params) => {
        sent.push({ action, params: params as Record<string, unknown> })
        return { message_id: 7 }
      },
      isStopping: () => false,
      log: (level, message) => { logs.push(level + ':' + message) },
      config: {
        botQQ: '10002', sensitivePatterns: [], textImageThreshold: 0, maxImageBytes: 8 * 1024 * 1024,
        cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        ...(opts?.mediaDir !== undefined ? { mediaDir: opts.mediaDir } : {}),
      },
    }, { now: () => (clock += 25) })
    return { pipeline, sent, logs }
  }

  const readAudit = (mediaDir: string): Array<Record<string, unknown>> =>
    readFileSync(join(mediaDir, ACTION_AUDIT_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)

  it('tool sends are never capped: every one goes out and is audited (jsonl, appended)', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-audit-'))
    const { pipeline, sent } = makeAuditHarness({ mediaDir })
    for (let i = 0; i < 25; i++) {
      await pipeline.sendSegments(i % 2 === 0 ? 'group:888' : 'private:10001', [{ type: 'text', data: { text: '第' + i + '条' } }])
    }
    expect(sent).toHaveLength(25)
    await vi.waitFor(() => expect(readAudit(mediaDir)).toHaveLength(25))
    const lines = readAudit(mediaDir)
    expect(lines[0]).toMatchObject({ chatId: 'group:888', action: 'send_msg', ok: true, reason: '发送成功' })
    expect(typeof lines[0].ts).toBe('number')
    expect(lines.every(l => l.ok === true)).toBe(true)
    expect(readFileSync(join(mediaDir, ACTION_AUDIT_FILE), 'utf8').endsWith('\n')).toBe(true)
  })

  it('a failed tool send is audited as ok:false and rethrown', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-audit-'))
    const pipeline = new OutboundPipeline({
      getChat: () => undefined, connected: () => true, selfId: () => '10002',
      call: async () => { throw new OneBotActionError('boom') },
      isStopping: () => false, log: () => undefined,
      config: { botQQ: '10002', sensitivePatterns: [], textImageThreshold: 0, maxImageBytes: 1, cardFooter: '', fontFiles: [], fontFamilies: [], mediaDir },
    })
    await expect(pipeline.sendSegments('group:888', [{ type: 'text', data: { text: 'x' } }])).rejects.toThrow('boom')
    await vi.waitFor(() => expect(readAudit(mediaDir)).toHaveLength(1))
    expect(readAudit(mediaDir)[0]).toMatchObject({ action: 'send_msg', ok: false })
    expect(String(readAudit(mediaDir)[0].reason)).toContain('boom')
  })

  it('audits tool forward sends (send_forward_msg) but not the [[qq_forward]] reply blocks', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-audit-'))
    const { pipeline, sent } = makeAuditHarness({ mediaDir })
    await pipeline.sendForward('group:888', [{ name: '助手', content: '节点内容' }])
    expect(sent).toEqual([expect.objectContaining({ action: 'send_forward_msg' })])
    await pipeline.sendToChat('group:888', '回复一')
    await pipeline.sendToChat('group:888', '前言 [[qq_forward]]标题\n内容[[/qq_forward]]')
    expect(sent.some(f => f.action === 'send_forward_msg' && JSON.stringify(f.params).includes('内容'))).toBe(true)
    expect(sent.some(f => f.action === 'send_msg' && JSON.stringify(f.params).includes('回复一'))).toBe(true)
    await vi.waitFor(() => expect(readAudit(mediaDir)).toHaveLength(1))
    expect(readAudit(mediaDir)[0]).toMatchObject({ chatId: 'group:888', action: 'send_forward_msg', ok: true })
  })

  it('degrades gracefully when the audit write fails (warn only, send unaffected)', async () => {
    // mediaDir points inside a regular file → mkdir/append must fail.
    const blockFile = join(tmpdir(), 'onebot-audit-block-' + Date.now() + '-' + Math.random().toString(16).slice(2))
    writeFileSync(blockFile, 'not a dir')
    const { pipeline, sent, logs } = makeAuditHarness({ mediaDir: join(blockFile, 'sub') })
    await expect(pipeline.sendSegments('group:888', [{ type: 'text', data: { text: '照发' } }])).resolves.toBe('7')
    expect(sent).toHaveLength(1)
    await vi.waitFor(() => {
      expect(logs.some(l => l.startsWith('warn:写操作审计写入失败'))).toBe(true)
    })
  })
})
