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
export declare function stripMarkdown(text: string): string;
/** default cap for "one line, one message" splitting. */
export declare const DEFAULT_SPLIT_MAX_MESSAGES = 6;
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
export declare function splitHumanMessages(plain: string, maxMessages: number): string[] | null;
/**
 * the pause before sending one split message, as if it were
 * being typed: per-character time clamped to [min, max] milliseconds.
 * Counts code points so emoji count as one character.
 */
export declare function typingDelayMs(text: string, perCharMs: number, minMs: number, maxMs: number): number;
/** One [[qq_forward]] block: a named message node. */
export interface ForwardNode {
    name: string;
    content: string;
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
export declare function extractForwardBlocks(text: string, defaultName: string): {
    body: string;
    nodes: ForwardNode[];
};
/**
 * Check outbound text against sensitive patterns (soft audit, non-blocking).
 * @param text - outbound text.
 * @param patterns - configured patterns; empty list disables the audit.
 * @returns matched patterns (strings), or [] when clean or disabled.
 */
export declare function scanSensitive(text: string, patterns: readonly string[]): string[];
