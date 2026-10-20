/**
 * Reply cards: the Markdown reader, line breaking (with a fake measure) and
 * the PNG renderer (skipped where no CJK font is installed).
 * @module dsh-qq-companion/tests/t2i
 */
import { GlobalFonts, loadImage, createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'

import { CARD_WIDTH, MAX_CARD_HEIGHT, renderTextImage } from '../src/t2i/index.js'
import { CJK_FAMILIES } from '../src/t2i/fonts.js'
import { breakUnits, layoutCode, layoutSpans, type Measure } from '../src/t2i/layout.js'
import { parseInline, parseMarkdown, spansText, tableCells } from '../src/t2i/markdown.js'

describe('parseMarkdown', () => {
  it('reads the block kinds a chat model writes', () => {
    const blocks = parseMarkdown([
      '# 标题', '', '第一段 **加粗** 和 `代码`', '第一段第二行', '', '- 苹果', '- 香蕉', '  - 小香蕉', '', '1. 一', '2) 二',
      '', '> 引用一行', '> 引用二行', '', '```ts', 'const a = "x\\n"', '```', '', '| 名字 | 说明 |', '|---|:---:|', '| a \\| b | 第二列 |', '', '---',
    ].join('\n'))
    expect(blocks.map(b => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'code', 'table', 'rule'])
    const para = blocks[1] as Extract<typeof blocks[number], { kind: 'paragraph' }>
    expect(spansText(para.spans)).toBe('第一段 加粗 和 代码\n第一段第二行')
    const bullets = blocks[2] as Extract<typeof blocks[number], { kind: 'list' }>
    expect(bullets.items.map(i => [i.marker, i.depth, spansText(i.spans)])).toEqual([['•', 0, '苹果'], ['•', 0, '香蕉'], ['•', 1, '小香蕉']])
    const numbered = blocks[3] as Extract<typeof blocks[number], { kind: 'list' }>
    expect(numbered.items.map(i => i.marker)).toEqual(['1.', '2.'])
    expect((blocks[5] as Extract<typeof blocks[number], { kind: 'code' }>).lines).toEqual(['const a = "x\\n"'])
    const table = blocks[6] as Extract<typeof blocks[number], { kind: 'table' }>
    expect(table.rows[0].map(spansText)).toEqual(['a | b', '第二列'])
  })

  it('converts literal \\n only when the text has no real newline', () => {
    expect(parseMarkdown('第一行\\n第二行').length).toBe(1)
    expect(spansText((parseMarkdown('第一行\\n第二行')[0] as { spans: never }).spans)).toBe('第一行\n第二行')
    expect(spansText((parseMarkdown('a\nprintf("x\\n")')[0] as { spans: never }).spans)).toBe('a\nprintf("x\\n")')
  })

  it('inline styles nest and unknown markup stays text', () => {
    expect(parseInline('**粗 `码` 粗** ~~删~~ [链接](https://x.y) *斜* 2*3*4')).toEqual([
      { text: '粗 ', bold: true }, { text: '码', bold: true, code: true }, { text: ' 粗', bold: true }, { text: ' ' },
      { text: '删', strike: true }, { text: ' ' }, { text: '链接', link: true }, { text: ' ' }, { text: '斜', italic: true }, { text: ' 2*3*4' },
    ])
    expect(tableCells('| a | b |')).toEqual(['a', 'b'])
  })
})

describe('line breaking', () => {
  // Fake metrics: CJK / emoji 2 units, everything else 1.
  const measure: Measure = text => Array.from(new Intl.Segmenter().segment(text)).reduce((w, { segment }) => w + (/[　-鿿＀-￯]|\p{Extended_Pictographic}/u.test(segment) ? 2 : 1), 0)
  const lines = (text: string, width: number) => layoutSpans([{ text }], width, measure).map(l => l.runs.map(r => r.text).join(''))

  it('breaks CJK anywhere, Latin at spaces, never starts a line with closing punctuation', () => {
    expect(lines('今天吃了三碗饭', 6)).toEqual(['今天吃', '了三碗', '饭'])
    expect(lines('hello world again', 12)).toEqual(['hello world', 'again'])
    expect(lines('吃饱了。睡觉', 6)).toEqual(['吃饱了。', '睡觉'])
  })

  it('cuts an over-long word, keeps emoji sequences whole, honors newlines', () => {
    expect(lines('https://example.com/a/very/long/path', 10)).toEqual(['https://ex', 'ample.com/', 'a/very/lon', 'g/path'])
    expect(breakUnits('👨‍👩‍👧好')).toEqual(['👨‍👩‍👧', '好'])
    expect(lines('一\n二', 10)).toEqual(['一', '二'])
    expect(layoutCode('abcdef', 4, t => t.length)).toEqual(['abcd', 'ef'])
  })

  it('an empty paragraph is one empty line', () => {
    expect(layoutSpans([{ text: '' }], 10, measure)).toHaveLength(1)
  })
})

const hasCjkFont = GlobalFonts.families.some(f => CJK_FAMILIES.some(c => c.toLowerCase() === f.family.toLowerCase()))
const hasEmojiFont = GlobalFonts.families.some(f => /color emoji/i.test(f.family))

describe.skipIf(!hasCjkFont)('renderTextImage', () => {
  async function pixels(png: Buffer) {
    const image = await loadImage(png)
    const canvas = createCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    return { width: image.width, height: image.height, data: ctx.getImageData(0, 0, image.width, image.height).data }
  }

  it('draws an 800px card whose height grows with the content, with real ink', async () => {
    const short = await pixels(renderTextImage('你好', { title: 'To 主人' }))
    const long = await pixels(renderTextImage('# 标题\n\n' + '很长的一段话。'.repeat(80) + '\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```'))
    expect(short.width).toBe(CARD_WIDTH)
    expect(long.height).toBeGreaterThan(short.height + 300)
    let dark = 0
    for (let i = 0; i < short.data.length; i += 4) if (short.data[i] < 100 && short.data[i + 1] < 100 && short.data[i + 2] < 100) dark++
    expect(dark).toBeGreaterThan(200) // the CJK text was really drawn
  })

  it.skipIf(!hasEmojiFont)('draws emoji in color', async () => {
    const { data } = await pixels(renderTextImage('😀😀😀😀'))
    let colored = 0
    for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - data[i + 1]) > 60 && data[i + 3] > 200) colored++
    expect(colored).toBeGreaterThan(300)
  })

  it('refuses a card taller than the cap (the caller then sends text)', () => {
    expect(() => renderTextImage('字\n\n'.repeat(Math.ceil(MAX_CARD_HEIGHT / 40) + 10))).toThrow(/卡片高度/)
  })

  it('uses the built-in CJK font list when no families are configured', () => {
    expect(() => renderTextImage('x', { fontFamilies: [] })).not.toThrow()
  })
})

describe('table column widths', () => {
  it('never splits an unbreakable word, fills the row, and shares spare room by need', async () => {
    const { columnWidths } = await import('../src/t2i/render.js')
    const cell = (text: string) => [{ text }]
    const measure = (text: string) => Array.from(text).length * 10
    const narrow = columnWidths([[cell('时间'), cell('事情')], [cell('12:00'), cell('吃了很多很多很多很多很多很多很多很多很多很多很多')]], 2, 400, 10, measure)
    expect(narrow.reduce((a, b) => a + b, 0)).toBe(400)
    expect(narrow[0]).toBeGreaterThanOrEqual(5 * 10 + 20)
    const wide = columnWidths([[cell('a'), cell('bbbbbbbbbb')]], 2, 400, 10, measure)
    expect(wide.reduce((a, b) => a + b, 0)).toBe(400)
    expect(wide[1]).toBeGreaterThan(wide[0])
  })
})
