/**
 * Draw parsed Markdown as a PNG card: a title bar, the blocks, a footer.
 * Layout runs first (so the canvas height is exact), then everything is
 * drawn at 1:1 on an 800px-wide card.
 * @module dsh-qq-companion/t2i/render
 */
import { createCanvas } from '@napi-rs/canvas';
import { breakUnits, layoutCode, layoutSpans } from './layout.js';
import { spansText } from './markdown.js';
export const CARD_WIDTH = 800;
export const BODY_FONT_SIZE = 26;
/** Taller cards are refused (the caller falls back to text). */
export const MAX_CARD_HEIGHT = 16_000;
const PAD_X = 44;
const CONTENT_W = CARD_WIDTH - PAD_X * 2;
const LINE_H = 1.6;
const COLORS = {
    background: '#ffffff', text: '#1f2328', muted: '#57606a', title: '#ffffff', titleBar: '#2f6feb',
    code: '#24292f', codeBg: '#f3f4f6', inlineCodeBg: '#eef0f3', quoteBar: '#d0d7de', rule: '#d8dee4',
    link: '#0969da', tableBorder: '#d0d7de', tableHeadBg: '#f6f8fa', footer: '#8c959f', brand: '#002fa7',
};
const HEADING_SIZE = { 1: 36, 2: 31, 3: 28 };
function fontFor(fonts, style, size) {
    if (style.code)
        return Math.round(size * 0.9) + 'px ' + fonts.mono;
    return (style.italic ? 'italic ' : '') + (style.bold ? 'bold ' : '') + size + 'px ' + fonts.text;
}
/** Lay out a whole card; `measureCtx` is any 2D context used for measuring. */
export function layoutCard(blocks, options, measureCtx) {
    const { fonts } = options;
    const measureWith = (size) => (text, style) => {
        measureCtx.font = fontFor(fonts, style, size);
        return measureCtx.measureText(text).width;
    };
    /** Lines of spans as one laid block. */
    const textBlock = (spans, size, width, x, color, extra = {}) => {
        const styled = spans.map(s => ({ ...s, ...extra }));
        const lines = layoutSpans(styled, width, measureWith(size));
        const lh = Math.round(size * LINE_H);
        return {
            height: lines.length * lh,
            draw: (ctx, y) => lines.forEach((line, i) => drawLine(ctx, line, x, y + i * lh, lh, size, color)),
        };
    };
    const drawLine = (ctx, line, x, top, lh, size, color) => {
        let cx = x;
        const baseline = top + Math.round(lh * 0.72);
        for (const run of line.runs) {
            ctx.font = fontFor(fonts, run.style, size);
            if (run.style.code) {
                ctx.fillStyle = COLORS.inlineCodeBg;
                roundRect(ctx, cx - 2, top + lh * 0.14, run.width + 4, lh * 0.74, 5);
                ctx.fill();
            }
            ctx.fillStyle = run.style.link ? COLORS.link : run.style.code ? COLORS.code : color;
            ctx.fillText(run.text, cx, baseline);
            if (run.style.strike || run.style.link) {
                const yLine = run.style.strike ? baseline - size * 0.32 : baseline + 3;
                ctx.fillRect(cx, yLine, run.width, run.style.strike ? 2 : 1);
            }
            cx += run.width;
        }
    };
    const blockLaid = (block, x, width) => {
        switch (block.kind) {
            case 'heading': {
                const laid = textBlock(block.spans, HEADING_SIZE[block.level], width, x, COLORS.text, { bold: true });
                const ruled = block.level === 1;
                return { height: laid.height + (ruled ? 12 : 0), draw: (ctx, y) => {
                        laid.draw(ctx, y);
                        if (ruled) {
                            ctx.fillStyle = COLORS.rule;
                            ctx.fillRect(x, y + laid.height + 6, width, 1);
                        }
                    } };
            }
            case 'paragraph':
                return textBlock(block.spans, BODY_FONT_SIZE, width, x, COLORS.text);
            case 'rule':
                return { height: 20, draw: (ctx, y) => { ctx.fillStyle = COLORS.rule; ctx.fillRect(x, y + 10, width, 2); } };
            case 'list': {
                const parts = block.items.map(item => {
                    const indent = item.depth * 30;
                    measureCtx.font = fontFor(fonts, {}, BODY_FONT_SIZE);
                    const markerW = Math.max(30, measureCtx.measureText(item.marker + ' ').width + 6);
                    const laid = textBlock(item.spans, BODY_FONT_SIZE, width - indent - markerW, x + indent + markerW, COLORS.text);
                    return { item, indent, laid };
                });
                const gap = 6;
                return {
                    height: parts.reduce((h, p) => h + p.laid.height, 0) + gap * (parts.length - 1),
                    draw: (ctx, y) => {
                        let cy = y;
                        const lh = Math.round(BODY_FONT_SIZE * LINE_H);
                        for (const p of parts) {
                            ctx.font = fontFor(fonts, { bold: p.item.marker !== '•' }, BODY_FONT_SIZE);
                            ctx.fillStyle = COLORS.muted;
                            ctx.fillText(p.item.marker, x + p.indent, cy + Math.round(lh * 0.72));
                            p.laid.draw(ctx, cy);
                            cy += p.laid.height + gap;
                        }
                    },
                };
            }
            case 'quote': {
                const inner = stack(block.blocks, x + 22, width - 22);
                return { height: inner.height, draw: (ctx, y) => {
                        ctx.fillStyle = COLORS.quoteBar;
                        ctx.fillRect(x, y, 5, inner.height);
                        ctx.save();
                        ctx.globalAlpha = 0.85;
                        inner.draw(ctx, y);
                        ctx.restore();
                    } };
            }
            case 'code': {
                const size = Math.round(BODY_FONT_SIZE * 0.82);
                const lh = Math.round(size * 1.5);
                const font = size + 'px ' + fonts.mono;
                measureCtx.font = font;
                const lines = block.lines.flatMap(l => layoutCode(l, width - 36, t => measureCtx.measureText(t).width));
                const height = lines.length * lh + 28;
                return { height, draw: (ctx, y) => {
                        ctx.fillStyle = COLORS.codeBg;
                        roundRect(ctx, x, y, width, height, 10);
                        ctx.fill();
                        ctx.font = font;
                        ctx.fillStyle = COLORS.code;
                        lines.forEach((l, i) => ctx.fillText(l, x + 18, y + 14 + i * lh + Math.round(lh * 0.72)));
                    } };
            }
            case 'table':
                return tableLaid(block, x, width);
        }
    };
    const tableLaid = (block, x, width) => {
        const cols = Math.max(block.header.length, ...block.rows.map(r => r.length));
        const size = Math.round(BODY_FONT_SIZE * 0.88);
        const pad = 12;
        const measure = measureWith(size);
        const all = [block.header, ...block.rows];
        const colW = columnWidths(all, cols, width, pad, (text, bold) => measure(text, { bold }));
        const rows = all.map((row, r) => {
            const cells = Array.from({ length: cols }, (_, c) => textBlock(row[c] ?? [], size, colW[c] - pad * 2, 0, COLORS.text, r === 0 ? { bold: true } : {}));
            return { cells, height: Math.max(...cells.map(cell => cell.height)) + pad * 2 };
        });
        const height = rows.reduce((h, row) => h + row.height, 0);
        const tableW = colW.reduce((a, b) => a + b, 0);
        return { height, draw: (ctx, y) => {
                let cy = y;
                rows.forEach((row, r) => {
                    if (r === 0) {
                        ctx.fillStyle = COLORS.tableHeadBg;
                        ctx.fillRect(x, cy, tableW, row.height);
                    }
                    let cx = x;
                    row.cells.forEach((cell, c) => {
                        ctx.save();
                        ctx.translate(cx + pad, 0);
                        cell.draw(ctx, cy + pad);
                        ctx.restore();
                        cx += colW[c];
                    });
                    cy += row.height;
                });
                ctx.strokeStyle = COLORS.tableBorder;
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 0.5, y + 0.5, tableW - 1, height - 1);
                let lineY = y;
                for (const row of rows.slice(0, -1)) {
                    lineY += row.height;
                    ctx.beginPath();
                    ctx.moveTo(x, lineY + 0.5);
                    ctx.lineTo(x + tableW, lineY + 0.5);
                    ctx.stroke();
                }
                let lineX = x;
                for (const w of colW.slice(0, -1)) {
                    lineX += w;
                    ctx.beginPath();
                    ctx.moveTo(lineX + 0.5, y);
                    ctx.lineTo(lineX + 0.5, y + height);
                    ctx.stroke();
                }
            } };
    };
    const stack = (items, x, width) => {
        const laid = items.map(b => blockLaid(b, x, width));
        const gap = 18;
        return {
            height: laid.reduce((h, l) => h + l.height, 0) + gap * Math.max(0, laid.length - 1),
            draw: (ctx, y) => { let cy = y; for (const l of laid) {
                l.draw(ctx, cy);
                cy += l.height + gap;
            } },
        };
    };
    const titleH = options.title !== undefined && options.title !== '' ? 76 : 0;
    const footerH = 56;
    const body = stack(blocks, PAD_X, CONTENT_W);
    const height = titleH + 36 + body.height + 28 + footerH;
    return {
        height,
        draw: ctx => {
            ctx.fillStyle = COLORS.background;
            ctx.fillRect(0, 0, CARD_WIDTH, height);
            if (titleH > 0) {
                ctx.fillStyle = COLORS.titleBar;
                ctx.fillRect(0, 0, CARD_WIDTH, titleH);
                ctx.font = 'bold 30px ' + fonts.text;
                ctx.fillStyle = COLORS.title;
                ctx.fillText(ellipsize(ctx, options.title, CONTENT_W), PAD_X, 49);
            }
            body.draw(ctx, titleH + 36);
            const brand = options.footerBrand ?? 'dsh';
            ctx.font = '20px ' + fonts.text;
            const prefix = 'Powered by ';
            const pw = ctx.measureText(prefix).width;
            const bw = ctx.measureText(brand).width;
            const fx = (CARD_WIDTH - pw - bw) / 2;
            const fy = height - 22;
            ctx.fillStyle = COLORS.footer;
            ctx.fillText(prefix, fx, fy);
            ctx.fillStyle = COLORS.brand;
            ctx.fillText(brand, fx + pw, fy);
        },
    };
}
/**
 * Table column widths that add up to `width`: every column first gets room
 * for its widest unbreakable word (so "12:00" never splits); spare room then
 * goes to the columns whose content wants more, in proportion.
 */
export function columnWidths(rows, cols, width, pad, measure) {
    const natural = new Array(cols).fill(0);
    const minimum = new Array(cols).fill(0);
    rows.forEach((row, r) => {
        for (let c = 0; c < cols; c++) {
            const text = spansText(row[c] ?? []);
            const bold = r === 0;
            natural[c] = Math.max(natural[c], measure(text, bold) + pad * 2);
            const widestUnit = Math.max(0, ...breakUnits(text).map(u => measure(u.trim(), bold)));
            minimum[c] = Math.max(minimum[c], widestUnit + pad * 2, 48);
        }
    });
    for (let c = 0; c < cols; c++)
        natural[c] = Math.max(natural[c], minimum[c]);
    const minSum = minimum.reduce((a, b) => a + b, 0);
    const natSum = natural.reduce((a, b) => a + b, 0);
    let widths;
    if (natSum <= width) {
        // Everything fits on one line: stretch proportionally to fill the row.
        widths = natural.map(n => n * width / natSum);
    }
    else if (minSum >= width) {
        widths = minimum.map(m => m * width / minSum);
    }
    else {
        const spare = width - minSum;
        const wants = natural.map((n, c) => n - minimum[c]);
        const wantSum = wants.reduce((a, b) => a + b, 0);
        widths = minimum.map((m, c) => m + spare * wants[c] / wantSum);
    }
    const floored = widths.map(Math.floor);
    floored[cols - 1] += width - floored.reduce((a, b) => a + b, 0);
    return floored;
}
function ellipsize(ctx, text, width) {
    if (ctx.measureText(text).width <= width)
        return text;
    const chars = Array.from(text);
    while (chars.length > 0 && ctx.measureText(chars.join('') + '…').width > width)
        chars.pop();
    return chars.join('') + '…';
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
}
/** Render blocks to PNG bytes. @throws when the card would exceed MAX_CARD_HEIGHT. */
export function renderCard(blocks, options) {
    const probe = createCanvas(CARD_WIDTH, 10).getContext('2d');
    const card = layoutCard(blocks, options, probe);
    if (card.height > MAX_CARD_HEIGHT)
        throw new Error('内容太长，卡片高度 ' + card.height + 'px 超过上限 ' + MAX_CARD_HEIGHT + 'px');
    const canvas = createCanvas(CARD_WIDTH, card.height);
    card.draw(canvas.getContext('2d'));
    return canvas.toBuffer('image/png');
}
