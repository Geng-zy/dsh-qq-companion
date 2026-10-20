/**
 * A small Markdown reader for reply cards: just the subset a chat model
 * writes — headings, paragraphs, bullet / numbered lists, quotes, fenced code,
 * tables, rules — with inline bold, italic, strikethrough, code and links.
 * Anything it does not recognize stays plain text, so nothing is ever lost.
 * @module dsh-qq-companion/t2i/markdown
 */

/** One styled run of inline text. */
export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  link?: boolean
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'list'; ordered: boolean; items: Array<{ marker: string; depth: number; spans: Span[] }> }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'table'; header: Span[][]; rows: Span[][][] }
  | { kind: 'rule' }

const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Split one table row into raw cell texts (outer pipes optional; `\|` is a literal pipe). */
export function tableCells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') { current += '|'; i++; continue }
    if (body[i] === '|') { cells.push(current.trim()); current = ''; continue }
    current += body[i]
  }
  cells.push(current.trim())
  return cells
}

const isTableRow = (line: string): boolean => line.includes('|') && tableCells(line).length >= 2

/** Parse inline Markdown into styled spans. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = []
  const push = (span: Span) => {
    if (span.text === '') return
    const last = spans[spans.length - 1]
    const same = last !== undefined && !!last.bold === !!span.bold && !!last.italic === !!span.italic &&
      !!last.strike === !!span.strike && !!last.code === !!span.code && !!last.link === !!span.link
    if (same) last.text += span.text
    else spans.push({ ...span })
  }
  const walk = (input: string, style: Omit<Span, 'text'>) => {
    // Order matters: code first (its content is literal), then links, then emphasis.
    const re = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|~~([^~\n]+?)~~|(?<![\w*])\*([^*\n]+?)\*(?!\w)|(?<![\w_])_([^_\n]+?)_(?!\w)/g
    let last = 0
    for (const m of input.matchAll(re)) {
      const at = m.index ?? 0
      push({ ...style, text: input.slice(last, at) })
      if (m[1] !== undefined) push({ ...style, code: true, text: m[1] })
      else if (m[2] !== undefined) walk(m[2], { ...style, link: true })
      else if (m[4] !== undefined || m[5] !== undefined) walk(m[4] ?? m[5], { ...style, bold: true })
      else if (m[6] !== undefined) walk(m[6], { ...style, strike: true })
      else walk(m[7] ?? m[8], { ...style, italic: true })
      last = at + m[0].length
    }
    push({ ...style, text: input.slice(last) })
  }
  walk(text, {})
  return spans
}

/** Parse a whole reply into blocks. */
export function parseMarkdown(source: string): Block[] {
  // A model sometimes writes the two characters "\n" instead of newlines; only
  // then (no real newline at all) are they converted, so code stays intact.
  let text = source.replace(/\r\n?/g, '\n')
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n')
  const lines = text.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join('\n')) })
    paragraph = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = FENCE.exec(line)
    if (fence !== null) {
      flush()
      const code: string[] = []
      i++
      while (i < lines.length && !(FENCE.exec(lines[i])?.[1] === fence[1])) code.push(lines[i++].replace(/\t/g, '  '))
      blocks.push({ kind: 'code', lang: fence[2], lines: code })
      continue
    }
    if (line.trim() === '') { flush(); continue }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      flush()
      blocks.push({ kind: 'heading', level: Math.min(3, heading[1].length) as 1 | 2 | 3, spans: parseInline(heading[2]) })
      continue
    }
    if (RULE.test(line)) { flush(); blocks.push({ kind: 'rule' }); continue }
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush()
      const header = tableCells(line).map(parseInline)
      const rows: Span[][][] = []
      i += 2
      while (i < lines.length && isTableRow(lines[i])) rows.push(tableCells(lines[i++]).map(parseInline))
      i--
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    if (QUOTE.test(line)) {
      flush()
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1])
      i--
      blocks.push({ kind: 'quote', blocks: parseMarkdown(inner.join('\n')) })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      flush()
      const ordered = /\d/.test(item[2])
      const items: Array<{ marker: string; depth: number; spans: Span[] }> = []
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i])
        if (m === null) {
          // A plain indented line continues the previous item.
          if (lines[i].trim() !== '' && /^\s+/.test(lines[i]) && items.length > 0) {
            const prev = items[items.length - 1]
            prev.spans = parseInline(spansText(prev.spans) + ' ' + lines[i].trim())
            i++
            continue
          }
          break
        }
        const depth = Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2))
        items.push({ marker: /\d/.test(m[2]) ? m[2].replace(')', '.') : '•', depth, spans: parseInline(m[3]) })
        i++
      }
      i--
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    paragraph.push(line)
  }
  flush()
  return blocks
}

/** The plain text of some spans (Markdown markers dropped). */
export function spansText(spans: readonly Span[]): string {
  return spans.map(s => s.text).join('')
}
