import type { SKRSContext2D } from '@napi-rs/canvas';
import type { FontStacks } from './fonts.js';
import { type Block, type Span } from './markdown.js';
export declare const CARD_WIDTH = 800;
export declare const BODY_FONT_SIZE = 26;
/** Taller cards are refused (the caller falls back to text). */
export declare const MAX_CARD_HEIGHT = 16000;
export interface CardOptions {
    title?: string;
    footerBrand?: string;
    fonts: FontStacks;
}
/** Lay out a whole card; `measureCtx` is any 2D context used for measuring. */
export declare function layoutCard(blocks: readonly Block[], options: CardOptions, measureCtx: SKRSContext2D): {
    height: number;
    draw: (ctx: SKRSContext2D) => void;
};
/**
 * Table column widths that add up to `width`: every column first gets room
 * for its widest unbreakable word (so "12:00" never splits); spare room then
 * goes to the columns whose content wants more, in proportion.
 */
export declare function columnWidths(rows: ReadonlyArray<ReadonlyArray<readonly Span[]>>, cols: number, width: number, pad: number, measure: (text: string, bold: boolean) => number): number[];
/** Render blocks to PNG bytes. @throws when the card would exceed MAX_CARD_HEIGHT. */
export declare function renderCard(blocks: readonly Block[], options: CardOptions): Buffer;
