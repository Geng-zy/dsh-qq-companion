/**
 * Fonts for reply cards. The canvas falls back glyph by glyph along a CSS
 * font list, so each style is one list: the user's own families first, then
 * common CJK fonts, a color emoji font and a Latin fallback. Configured font
 * files are registered once. A card is only drawn when at least one CJK font
 * is present (otherwise the caller sends plain text).
 * @module dsh-qq-companion/t2i/fonts
 */
import { existsSync } from 'node:fs';
import { GlobalFonts } from '@napi-rs/canvas';
/** CJK-capable families, most preferred first. */
export const CJK_FAMILIES = [
    'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei',
    'Noto Sans CJK JP', 'Noto Sans CJK TC', 'WenQuanYi Zen Hei', 'WenQuanYi Micro Hei', 'Droid Sans Fallback',
];
const EMOJI_FAMILIES = ['Noto Color Emoji', 'Apple Color Emoji', 'Segoe UI Emoji', 'Twemoji Mozilla'];
const LATIN_FAMILIES = ['DejaVu Sans', 'Liberation Sans', 'Arial'];
const MONO_FAMILIES = ['DejaVu Sans Mono', 'Noto Sans Mono CJK SC', 'Noto Sans Mono', 'Liberation Mono', 'Menlo', 'Consolas'];
const registered = new Set();
/** Register configured font files (each path once; missing files skipped). */
export function registerFontFiles(files) {
    for (const file of files) {
        if (file === '' || registered.has(file) || !existsSync(file))
            continue;
        registered.add(file);
        GlobalFonts.registerFromPath(file);
    }
}
const quote = (family) => '"' + family.replace(/"/g, '') + '"';
/** The installed families of a candidate list (case-insensitive). */
function installed(candidates) {
    const have = new Set(GlobalFonts.families.map(f => f.family.toLowerCase()));
    return candidates.filter(f => have.has(f.toLowerCase()));
}
/**
 * Font lists for one configuration.
 * @throws when no CJK font is installed — a card would render tofu.
 */
export function fontStacks(preferred = []) {
    const cjk = installed([...preferred, ...CJK_FAMILIES]);
    if (cjk.length === 0)
        throw new Error('没有可用的中文字体（安装 fonts-noto-cjk，或在 fontFiles 里指定字体文件）');
    const text = [...cjk, ...installed(EMOJI_FAMILIES), ...installed(LATIN_FAMILIES)];
    const mono = [...installed(MONO_FAMILIES), ...text];
    return { text: [...new Set(text)].map(quote).join(', ') + ', sans-serif', mono: [...new Set(mono)].map(quote).join(', ') + ', monospace' };
}
