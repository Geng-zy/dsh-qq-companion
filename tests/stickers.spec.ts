/**
 * Sticker library and tools: keep a picture from the chat (tags required,
 * images only, dedupe by content, caps), find by mood, send at most one per
 * reply, owner-only edit/delete; and stickers marked as such when parsed.
 * @module dsh-qq-companion/tests/stickers
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { StickerLibrary, normalizeTags, sniffImage } from '../src/companion/stickers.js'
import { parseMessage } from '../src/cq.js'
import { registerStickerTools, type StickerToolHost } from '../src/sticker-tools.js'

import { makeCmdHarness } from './helpers/bridge-harness.js'

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const GIF = Buffer.from('GIF89a' + 'x'.repeat(20), 'latin1')

function image(dir: string, name: string, bytes: Buffer = PNG, salt = ''): string {
  const file = join(dir, name)
  writeFileSync(file, Buffer.concat([bytes, Buffer.from(salt)]))
  return file
}

describe('sniffImage / normalizeTags', () => {
  it('recognizes png, jpg, gif, webp by content and nothing else', () => {
    expect(sniffImage(PNG)).toBe('png')
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniffImage(GIF)).toBe('gif')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('webp')
    expect(sniffImage(Buffer.from('<svg xmlns='))).toBeUndefined()
  })

  it('cleans, shortens and dedupes tags, at most 8', () => {
    expect(normalizeTags([' 摸头 ', '#可爱', '摸头', 1, '', '一二三四五六七八九十一二三'])).toEqual(['摸头', '可爱', '一二三四五六七八九十一二'])
    expect(normalizeTags(Array.from({ length: 12 }, (_, i) => 't' + i))).toHaveLength(8)
  })
})

describe('StickerLibrary', () => {
  it('saves a copy with tags, persists the index and reloads it', async () => {
    const dir = tmp('stk-'), media = tmp('stk-media-')
    const lib = new StickerLibrary({ dir })
    await lib.load()
    const r = await lib.save(image(media, 'a.png'), ['摸头', '安慰'], '一只猫在摸头', 'group:888')
    expect(r).toMatchObject({ ok: true, merged: false, sticker: { id: 's0001', file: 's0001.png', tags: ['摸头', '安慰'], from: 'group:888' } })
    expect(existsSync(join(dir, 's0001.png'))).toBe(true)
    const again = new StickerLibrary({ dir })
    await again.load()
    expect(again.count).toBe(1)
    expect(again.get('s0001')?.description).toBe('一只猫在摸头')
    const next = await again.save(image(media, 'b.gif', GIF), ['无语'], '', 'private:1')
    expect(next.ok && next.sticker.id).toBe('s0002')
  })

  it('the same picture is kept once; saving it again merges the tags', async () => {
    const dir = tmp('stk-'), media = tmp('stk-media-')
    const lib = new StickerLibrary({ dir })
    await lib.load()
    await lib.save(image(media, 'a.png'), ['摸头'], '', 'group:888')
    const r = await lib.save(image(media, 'copy.png'), ['安慰'], '摸头猫', 'private:1')
    expect(r).toMatchObject({ ok: true, merged: true, sticker: { id: 's0001', tags: ['摸头', '安慰'], description: '摸头猫' } })
    expect(lib.count).toBe(1)
  })

  it('concurrent saves of the same picture still keep one copy', async () => {
    const dir = tmp('stk-'), media = tmp('stk-media-')
    const lib = new StickerLibrary({ dir })
    await lib.load()
    const results = await Promise.all([1, 2, 3].map(i => lib.save(image(media, i + '.png'), ['t' + i], '', 'g')))
    expect(lib.count).toBe(1)
    expect(results.filter(r => r.ok && !r.merged)).toHaveLength(1)
  })

  it('refuses: no tags, not an image, too big, library full, daily cap', async () => {
    const dir = tmp('stk-'), media = tmp('stk-media-')
    const lib = new StickerLibrary({ dir, maxCount: 2, maxBytes: 64, dailyMax: 5 })
    await lib.load()
    expect(await lib.save(image(media, 'a.png'), [], '', 'g')).toMatchObject({ ok: false, reason: expect.stringContaining('标签') })
    expect(await lib.save(image(media, 'x.txt', Buffer.from('hello')), ['t'], '', 'g')).toMatchObject({ ok: false, reason: expect.stringContaining('不是') })
    expect(await lib.save(image(media, 'big.png', PNG, 'x'.repeat(100)), ['t'], '', 'g')).toMatchObject({ ok: false, reason: expect.stringContaining('太大') })
    expect(await lib.save(join(media, 'missing.png'), ['t'], '', 'g')).toMatchObject({ ok: false, reason: expect.stringContaining('找不到') })
    await lib.save(image(media, '1.png', PNG, '1'), ['t'], '', 'g')
    await lib.save(image(media, '2.png', PNG, '2'), ['t'], '', 'g')
    expect(await lib.save(image(media, '3.png', PNG, '3'), ['t'], '', 'g')).toMatchObject({ ok: false, reason: expect.stringContaining('满了') })

    const daily = new StickerLibrary({ dir: tmp('stk-'), dailyMax: 2 })
    await daily.load()
    await daily.save(image(media, 'd1.png', PNG, 'd1'), ['t'], '', 'g')
    await daily.save(image(media, 'd2.png', PNG, 'd2'), ['t'], '', 'g')
    expect(await daily.save(image(media, 'd3.png', PNG, 'd3'), ['t'], '', 'g')).toMatchObject({ ok: false, reason: expect.stringContaining('明天') })
    // merging tags into a kept picture does not count against the daily cap
    expect(await daily.save(image(media, 'd1-again.png', PNG, 'd1'), ['新'], '', 'g')).toMatchObject({ ok: true, merged: true })
  })

  it('searches tags and descriptions, least used first; today lists new ones', async () => {
    let now = new Date(2026, 9, 19, 12).getTime()
    const dir = tmp('stk-'), media = tmp('stk-media-')
    const lib = new StickerLibrary({ dir, now: () => now })
    await lib.load()
    await lib.save(image(media, '1.png', PNG, '1'), ['摸头', '安慰'], '猫猫', 'g')
    now = new Date(2026, 9, 20, 12).getTime()
    await lib.save(image(media, '2.png', PNG, '2'), ['摸头'], '狗狗', 'g')
    await lib.save(image(media, '3.png', PNG, '3'), ['无语'], '黑人问号', 'g')
    await lib.markUsed('s0002')
    expect(lib.search('摸头').map(s => s.id)).toEqual(['s0001', 's0002'])
    expect(lib.search('安慰 摸头')[0].id).toBe('s0001')
    expect(lib.search('问号').map(s => s.id)).toEqual(['s0003'])
    expect(lib.search('')).toEqual([])
    expect(lib.search('', { today: true }).map(s => s.id)).toEqual(['s0002', 's0003'])
    expect(lib.snapshot()).toEqual({ count: 3, maxCount: 300, today: 2, dailyMax: 20 })
  })

  it('edits and deletes (file removed); a corrupt index loads as empty', async () => {
    const dir = tmp('stk-'), media = tmp('stk-media-')
    const lib = new StickerLibrary({ dir })
    await lib.load()
    await lib.save(image(media, '1.png'), ['旧'], '', 'g')
    expect((await lib.edit('s0001', { tags: ['新', '标签'], description: '改过' }))?.tags).toEqual(['新', '标签'])
    expect(await lib.delete('s0001')).toBe(true)
    expect(existsSync(join(dir, 's0001.png'))).toBe(false)
    expect(await lib.delete('s0001')).toBe(false)
    writeFileSync(join(dir, 'index.json'), '{ broken')
    const logs: string[] = []
    const reloaded = new StickerLibrary({ dir, log: (_l, m) => logs.push(m) })
    await reloaded.load()
    expect(reloaded.count).toBe(0)
    expect(logs.join()).toContain('表情包索引读取失败')
  })
})

describe('sticker tools', () => {
  type Tool = { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }
  async function setup(opts: { admin?: boolean } = {}) {
    const dir = tmp('stk-'), media = tmp('stk-media-')
    const lib = new StickerLibrary({ dir })
    await lib.load()
    const tools = new Map<string, Tool>()
    const ctx = { tools: { register: (t: Tool) => { tools.set(t.name, t); return () => undefined } } }
    const sent: unknown[] = []
    const slots = new Set<string>()
    const host: StickerToolHost = {
      chatForSession: () => 'group:888',
      canEditFiles: () => opts.admin === true,
      mediaSendRoots: async () => ({ roots: [media] }),
      takeStickerSlot: chatId => { if (slots.has(chatId)) return false; slots.add(chatId); return true },
      sendSegments: vi.fn(async (_chat, segments) => { sent.push(segments); return '42' }),
    }
    registerStickerTools(ctx as never, host, lib)
    const exec = { agent: { session: { id: 'sess-1' } } }
    const run = (name: string, args: unknown) => tools.get(name)!.execute(args, exec)
    return { lib, media, run, sent, slots, tools }
  }

  it('registers the five tools', async () => {
    const { tools } = await setup()
    expect([...tools.keys()].sort()).toEqual(['qq_sticker_delete', 'qq_sticker_edit', 'qq_sticker_save', 'qq_sticker_search', 'qq_sticker_send'])
  })

  it('save only takes pictures from the chat media dir', async () => {
    const { run, media } = await setup()
    expect(await run('qq_sticker_save', { path: image(media, 'a.png'), tags: ['开心'], description: '笑脸' })).toMatchObject({ ok: true, id: 's0001' })
    const outside = image(tmp('elsewhere-'), 'b.png', PNG, 'b')
    expect(await run('qq_sticker_save', { path: outside, tags: ['开心'] })).toMatchObject({ ok: false, reason: expect.stringContaining('只能存聊天里收到的图片') })
  })

  it('send: one sticker per reply, as a QQ sticker segment, and counts the use', async () => {
    const { run, media, sent, slots, lib } = await setup()
    await run('qq_sticker_save', { path: image(media, 'a.png'), tags: ['开心'] })
    expect(await run('qq_sticker_send', { id: 's0001' })).toMatchObject({ sent: true, messageId: '42' })
    expect(sent[0]).toEqual([{ type: 'image', data: { file: expect.stringMatching(/^base64:\/\//), sub_type: 1, summary: '[动画表情]' } }])
    expect(await run('qq_sticker_send', { id: 's0001' })).toMatchObject({ sent: false, reason: expect.stringContaining('已经发过') })
    expect(lib.get('s0001')?.uses).toBe(1)
    slots.clear() // next turn
    expect(await run('qq_sticker_send', { id: 'nope' })).toMatchObject({ sent: false, reason: expect.stringContaining('没有这个编号') })
  })

  it('edit and delete need the owner (or the nightly task)', async () => {
    const member = await setup()
    await member.run('qq_sticker_save', { path: image(member.media, 'a.png'), tags: ['开心'] })
    expect(await member.run('qq_sticker_delete', { id: 's0001' })).toMatchObject({ ok: false, reason: expect.stringContaining('主人') })
    expect(await member.run('qq_sticker_edit', { id: 's0001', tags: ['x'] })).toMatchObject({ ok: false })
    expect(member.lib.count).toBe(1)

    const owner = await setup({ admin: true })
    await owner.run('qq_sticker_save', { path: image(owner.media, 'a.png'), tags: ['开心'] })
    expect(await owner.run('qq_sticker_edit', { id: 's0001', tags: ['大笑'] })).toMatchObject({ ok: true, tags: ['大笑'] })
    expect(await owner.run('qq_sticker_delete', { id: 's0001' })).toEqual({ ok: true })
    expect(owner.lib.count).toBe(0)
  })

  it('search returns brief entries', async () => {
    const { run, media } = await setup()
    await run('qq_sticker_save', { path: image(media, 'a.png'), tags: ['摸头'], description: '摸摸' })
    expect(await run('qq_sticker_search', { query: '摸头' })).toEqual([{ id: 's0001', tags: ['摸头'], description: '摸摸', uses: 0 }])
  })
})

describe('stickers are marked when parsed', () => {
  it('NapCat sticker (sub_type as a number) → sticker media and [表情包]', () => {
    const parsed = parseMessage([{ type: 'image', data: { file: 'a.gif', url: 'https://x/a.gif', sub_type: 1 as unknown as string, summary: '[动画表情]' } }], '')
    expect(parsed.text).toBe('[表情包]')
    expect(parsed.media).toEqual([expect.objectContaining({ kind: 'image', sticker: true, subType: '1' })])
  })

  it('a photo stays an image; a CQ string sticker is a sticker too', () => {
    expect(parseMessage([{ type: 'image', data: { file: 'p.jpg', sub_type: 0 as unknown as string } }], '').text).toBe('[图片]')
    const cq = parseMessage(undefined, '[CQ:image,file=a.gif,sub_type=1]')
    expect(cq.text).toBe('[表情包]')
    expect(cq.media[0].sticker).toBe(true)
  })

  it('商城表情 (mface): fetched as a sticker with a URL, otherwise its name', () => {
    expect(parseMessage([{ type: 'mface', data: { url: 'https://x/m.gif', summary: '[狗头]' } }], '').media[0]).toMatchObject({ kind: 'image', sticker: true })
    expect(parseMessage([{ type: 'mface', data: { summary: '[狗头]' } }], '')).toMatchObject({ text: '[狗头]', media: [] })
  })
})

describe('a sticker reaches her as [表情包:path]', () => {
  it('a received QQ sticker is fetched and annotated as a sticker, a photo as an image', async () => {
    const h = await makeCmdHarness()
    const b64 = 'base64://' + PNG.toString('base64')
    h.client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'image', data: { file: b64, sub_type: 1, summary: '[动画表情]' } }, { type: 'image', data: { file: 'base64://' + Buffer.concat([PNG, Buffer.from('p')]).toString('base64'), sub_type: 0 } }],
      raw_message: '[CQ:image][CQ:image]', sender: { user_id: 10001, nickname: '主人' },
    }))
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(h.captured.followups[0].text).toMatch(/\[表情包:[^\]]+\]\[图片:[^\]]+\]/)
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
