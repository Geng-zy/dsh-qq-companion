/**
 * Long replies as image cards: Markdown → laid-out PNG (title bar, body,
 * footer). Used for replies over textImageThreshold characters and for the
 * interim-message summary card; any failure throws so the caller sends text.
 * @module dsh-qq-companion/t2i
 */
import { fontStacks, registerFontFiles } from './fonts.js';
import { parseMarkdown } from './markdown.js';
import { renderCard } from './render.js';
export { BODY_FONT_SIZE, CARD_WIDTH, MAX_CARD_HEIGHT } from './render.js';
/**
 * Render Markdown text as a PNG card.
 * @throws when no CJK font is available or the card would be too tall.
 */
export function renderTextImage(text, options = {}) {
    registerFontFiles(options.fontFiles ?? []);
    const fonts = fontStacks(options.fontFamilies ?? []);
    return renderCard(parseMarkdown(text), {
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.footerBrand !== undefined ? { footerBrand: options.footerBrand } : {}),
        fonts,
    });
}
