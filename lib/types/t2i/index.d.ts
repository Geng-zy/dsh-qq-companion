export { BODY_FONT_SIZE, CARD_WIDTH, MAX_CARD_HEIGHT } from './render.js';
export interface RenderOptions {
    /** Title bar text (e.g. "To 昵称"); absent = no title bar. */
    title?: string;
    /** Footer brand after "Powered by" (default "dsh"). */
    footerBrand?: string;
    /** Font files to register before drawing. */
    fontFiles?: readonly string[];
    /** Preferred font families (tried before the built-in CJK list). */
    fontFamilies?: readonly string[];
}
/**
 * Render Markdown text as a PNG card.
 * @throws when no CJK font is available or the card would be too tall.
 */
export declare function renderTextImage(text: string, options?: RenderOptions): Buffer;
