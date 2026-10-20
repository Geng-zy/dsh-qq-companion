/**
 * A small Markdown reader for reply cards: just the subset a chat model
 * writes — headings, paragraphs, bullet / numbered lists, quotes, fenced code,
 * tables, rules — with inline bold, italic, strikethrough, code and links.
 * Anything it does not recognize stays plain text, so nothing is ever lost.
 * @module dsh-qq-companion/t2i/markdown
 */
/** One styled run of inline text. */
export interface Span {
    text: string;
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    code?: boolean;
    link?: boolean;
}
export type Block = {
    kind: 'heading';
    level: 1 | 2 | 3;
    spans: Span[];
} | {
    kind: 'paragraph';
    spans: Span[];
} | {
    kind: 'list';
    ordered: boolean;
    items: Array<{
        marker: string;
        depth: number;
        spans: Span[];
    }>;
} | {
    kind: 'quote';
    blocks: Block[];
} | {
    kind: 'code';
    lang: string;
    lines: string[];
} | {
    kind: 'table';
    header: Span[][];
    rows: Span[][][];
} | {
    kind: 'rule';
};
/** Split one table row into raw cell texts (outer pipes optional; `\|` is a literal pipe). */
export declare function tableCells(line: string): string[];
/** Parse inline Markdown into styled spans. */
export declare function parseInline(text: string): Span[];
/** Parse a whole reply into blocks. */
export declare function parseMarkdown(source: string): Block[];
/** The plain text of some spans (Markdown markers dropped). */
export declare function spansText(spans: readonly Span[]): string;
