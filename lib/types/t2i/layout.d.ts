/**
 * Line breaking for reply cards, independent of any canvas: text is cut into
 * grapheme clusters (an emoji with skin tone or ZWJ sequence, a flag, a
 * surrogate pair always stays whole), CJK breaks between any two characters,
 * Latin words break at spaces (an over-long word is cut), and closing
 * punctuation never starts a line.
 * @module dsh-qq-companion/t2i/layout
 */
import type { Span } from './markdown.js';
/** Width of `text` drawn in the given span style (pixels). */
export type Measure = (text: string, style: SpanStyle) => number;
export type SpanStyle = Omit<Span, 'text'>;
/** One laid-out line: runs of styled text, left to right. */
export interface Line {
    runs: Array<{
        text: string;
        style: SpanStyle;
        width: number;
    }>;
    width: number;
}
/** Characters that must not begin a line (pulled up onto the previous one). */
export declare const NO_LINE_START: Set<string>;
/** Break units: a CJK / emoji / punctuation grapheme alone, or a Latin word
 * with its trailing spaces, or a run of spaces. */
export declare function breakUnits(text: string): string[];
/** Lay styled spans out into lines no wider than `maxWidth`. Newlines inside
 * spans start new lines. */
export declare function layoutSpans(spans: readonly Span[], maxWidth: number, measure: Measure): Line[];
/** Lay out a plain monospace code line (breaks anywhere). */
export declare function layoutCode(text: string, maxWidth: number, measure: (text: string) => number): string[];
