/**
 * Outbound text shaping: Markdown stripping for
 * QQ, [[qq_forward]] block parsing, and the sensitive-intent audit.
 * Ported from the Hermes onebot_utils.py split/markdown half.
 * @module dsh-qq-companion/split
 */
/**
 * Strip Markdown into QQ-friendly plain text. QQ does not render Markdown;
 * headings, emphasis, links, code fences, and tables are flattened. The
 * internal [[qq_forward]] markers are preserved (handled before this runs).
 * @param text - model-produced Markdown text.
 * @returns plain text for QQ.
 */
export function stripMarkdown(text) {
    let out = text
        // Code fences: keep the inner text, drop the fence lines.
        .replace(/\x60\x60\x60[^\n]*\n([\s\S]*?)\x60\x60\x60/g, (_, body) => body + '\n')
        .replace(/\x60\x60\x60([\s\S]*?)\x60\x60\x60/g, '$1')
        // Inline code: keep content, drop backticks.
        .replace(/\x60([^\x60\n]+)\x60/g, '$1')
        // Headings.
        .replace(/^#{1,6}[ \t]+/gm, '')
        // Emphasis.
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/(^|[^_])_([^_]+)_([^_]|$)/g, '$1$2$3')
        .replace(/~~([^~]+)~~/g, '$1')
        // Links and images.
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '[图片]')
        .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1 ($2)')
        // Blockquote markers.
        .replace(/^[ \t]*>[ \t]?/gm, '')
        // Table rows: keep cell text separated by spaces; drop divider rows.
        .split('\n')
        .map(line => {
        if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('|') && !line.includes('\n')) {
            const cells = line.split('|').filter(c => c.trim() !== '');
            if (cells.every(c => /^:?-{2,}:?$/.test(c.trim())))
                return '';
        }
        if (line.trim().startsWith('|')) {
            return line.split('|').map(c => c.trim()).filter(c => c !== '').join(' ');
        }
        return line;
    })
        .filter(line => line !== '')
        .join('\n')
        // Horizontal rules.
        .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
        // Collapse 3+ blank lines.
        .replace(/\n{3,}/g, '\n\n');
    return out.trim();
}
/** default cap for "one line, one message" splitting. */
export const DEFAULT_SPLIT_MAX_MESSAGES = 6;
/**
 * split a plain-text chat reply into "one line, one message"
 * chunks, the way a person texts. Returns null when the reply should stay a
 * single message: one line only, splitting disabled (maxMessages <= 1), or
 * more lines than maxMessages (a list or code block the user asked for —
 * sending it line by line would flood the chat).
 * @param plain - reply text after Markdown stripping.
 * @param maxMessages - most messages one reply may become.
 * @returns the non-empty trimmed lines, or null to send as one message.
 */
export function splitHumanMessages(plain, maxMessages) {
    const lines = plain.split('\n').map(line => line.trim()).filter(line => line !== '');
    if (lines.length <= 1 || maxMessages <= 1 || lines.length > maxMessages)
        return null;
    return lines;
}
/**
 * the pause before sending one split message, as if it were
 * being typed: per-character time clamped to [min, max] milliseconds.
 * Counts code points so emoji count as one character.
 */
export function typingDelayMs(text, perCharMs, minMs, maxMs) {
    const raw = Array.from(text).length * perCharMs;
    return Math.max(minMs, Math.min(maxMs, raw));
}
/** The [[qq_forward]] marker regex (imported from cq.ts for single sourcing). */
import { FORWARD_BLOCK_RE } from './cq.js';
export { FORWARD_BLOCK_RE };
/**
 * Extract [[qq_forward]] blocks from reply text. The blocks are removed from
 * the returned body text; empty-name blocks default the sender name.
 * @param text - the reply text (before Markdown stripping).
 * @param defaultName - node name when the block omits one.
 * @returns body text without blocks, plus the parsed nodes.
 */
export function extractForwardBlocks(text, defaultName) {
    const nodes = [];
    const body = text.replace(FORWARD_BLOCK_RE, (_, block) => {
        const trimmed = block.trim();
        if (trimmed === '')
            return '';
        const lines = trimmed.split('\n');
        const first = lines[0].trim();
        let name = defaultName;
        let content = trimmed;
        if (first.length <= 24 && !first.includes('：') && !first.includes(':') && lines.length > 1) {
            name = first;
            content = lines.slice(1).join('\n').trim();
        }
        if (content !== '')
            nodes.push({ name, content });
        return '';
    });
    return { body, nodes };
}
/** Sensitive-intent audit: log a WARNING when outbound text matches. */
const DEFAULT_SENSITIVE_PATTERNS = [
    /(?:rm\s+-rf|format\s+[a-z]:|diskpart|mkfs\.)/i,
    /(?:shutdown|reboot|poweroff|init\s+0)/i,
    /(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)/i,
    /(?:sk-|ghp_|api[_-]?key|password|passwd|secret|token)\s*[:=]\s*\S+/i,
];
/**
 * Check outbound text against sensitive patterns (soft audit, non-blocking).
 * @param text - outbound text.
 * @param patterns - configured patterns; empty list disables the audit.
 * @returns matched patterns (strings), or [] when clean or disabled.
 */
export function scanSensitive(text, patterns) {
    const list = patterns.length > 0 ? patterns : DEFAULT_SENSITIVE_PATTERNS;
    const hits = [];
    for (const p of list) {
        const re = p instanceof RegExp ? p : new RegExp(p, 'i');
        if (re.test(text))
            hits.push(String(p));
    }
    return hits;
}
