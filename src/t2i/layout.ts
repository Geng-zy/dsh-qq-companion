/**
 * Line breaking for reply cards, independent of any canvas: text is cut into
 * grapheme clusters (an emoji with skin tone or ZWJ sequence, a flag, a
 * surrogate pair always stays whole), CJK breaks between any two characters,
 * Latin words break at spaces (an over-long word is cut), and closing
 * punctuation never starts a line.
 * @module dsh-qq-companion/t2i/layout
 */
import type { Span } from './markdown.js'

/** Width of `text` drawn in the given span style (pixels). */
export type Measure = (text: string, style: SpanStyle) => number

export type SpanStyle = Omit<Span, 'text'>

/** One laid-out line: runs of styled text, left to right. */
export interface Line {
  runs: Array<{ text: string; style: SpanStyle; width: number }>
  width: number
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Characters that must not begin a line (pulled up onto the previous one). */
export const NO_LINE_START = new Set(Array.from('，。、；：？！）》」』】〕〉…—～·,.;:?!)]}%'))

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/u
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u

/** Break units: a CJK / emoji / punctuation grapheme alone, or a Latin word
 * with its trailing spaces, or a run of spaces. */
export function breakUnits(text: string): string[] {
  const units: string[] = []
  let word = ''
  for (const { segment } of segmenter.segment(text)) {
    // Full-width punctuation stands alone; ASCII punctuation stays inside its
    // word (a URL or "Hello," is not split at the dot or comma).
    if (CJK.test(segment) || EMOJI.test(segment) || (NO_LINE_START.has(segment) && segment.charCodeAt(0) > 0x7f)) {
      if (word !== '') { units.push(word); word = '' }
      units.push(segment)
    } else if (segment === ' ' || segment === '\t') {
      word += ' '
      units.push(word)
      word = ''
    } else {
      if (word.endsWith(' ')) { units.push(word); word = '' }
      word += segment
    }
  }
  if (word !== '') units.push(word)
  return units
}

/** Lay styled spans out into lines no wider than `maxWidth`. Newlines inside
 * spans start new lines. */
export function layoutSpans(spans: readonly Span[], maxWidth: number, measure: Measure): Line[] {
  const lines: Line[] = []
  let line: Line = { runs: [], width: 0 }
  const pushLine = () => {
    // Trailing spaces do not count toward the line width.
    const last = line.runs[line.runs.length - 1]
    if (last !== undefined && /\s$/.test(last.text)) {
      const trimmed = last.text.replace(/\s+$/, '')
      line.width -= last.width - (trimmed === '' ? 0 : measure(trimmed, last.style))
      last.text = trimmed
      last.width = trimmed === '' ? 0 : measure(trimmed, last.style)
      if (trimmed === '') line.runs.pop()
    }
    lines.push(line)
    line = { runs: [], width: 0 }
  }
  const append = (text: string, style: SpanStyle, width: number) => {
    const last = line.runs[line.runs.length - 1]
    if (last !== undefined && sameStyle(last.style, style)) {
      last.text += text
      last.width += width
    } else {
      line.runs.push({ text, style, width })
    }
    line.width += width
  }
  for (const span of spans) {
    const { text, ...style } = span
    const paragraphs = text.split('\n')
    paragraphs.forEach((part, index) => {
      if (index > 0) pushLine()
      for (const unit of breakUnits(part)) {
        const width = measure(unit, style)
        if (line.width + width <= maxWidth || line.runs.length === 0 && width <= maxWidth) {
          append(unit, style, width)
          continue
        }
        if (NO_LINE_START.has(unit) && line.runs.length > 0) {
          // Hang closing punctuation on the current line instead of starting one with it.
          append(unit, style, width)
          continue
        }
        if (unit.trim() === '') { pushLine(); continue }
        if (line.runs.length > 0) pushLine()
        if (width <= maxWidth) { append(unit, style, width); continue }
        // A single unit wider than the line (a long URL): cut it by grapheme.
        for (const { segment } of segmenter.segment(unit)) {
          const w = measure(segment, style)
          if (line.width + w > maxWidth && line.runs.length > 0) pushLine()
          append(segment, style, w)
        }
      }
    })
  }
  if (line.runs.length > 0 || lines.length === 0) pushLine()
  return lines
}

function sameStyle(a: SpanStyle, b: SpanStyle): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.strike === !!b.strike && !!a.code === !!b.code && !!a.link === !!b.link
}

/** Lay out a plain monospace code line (breaks anywhere). */
export function layoutCode(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  if (text === '') return ['']
  const out: string[] = []
  let current = ''
  let width = 0
  for (const { segment } of segmenter.segment(text)) {
    const w = measure(segment)
    if (width + w > maxWidth && current !== '') { out.push(current); current = ''; width = 0 }
    current += segment
    width += w
  }
  out.push(current)
  return out
}
