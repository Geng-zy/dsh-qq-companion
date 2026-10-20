/**
 * Model-facing sticker tools: keep a picture from the chat, find one by
 * mood, send it, and (owner / nightly only) fix tags or delete. At most one
 * sticker goes out per reply — enforced here, not left to the prompt.
 * @module dsh-qq-companion/sticker-tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { StickerLibrary } from './companion/stickers.js';
/** What the sticker tools need from the bridge. */
export interface StickerToolHost {
    chatForSession(sessionId: string): string | undefined;
    /** Whether the running turn was started by the owner (or is a scheduled task). */
    canEditFiles(sessionId: string): boolean;
    /** Roots a picture to keep may come from (the inbound media dir …). */
    mediaSendRoots(sessionId: string | undefined): Promise<{
        roots: string[];
    }>;
    /** Claim this reply's one sticker; false when one already went out this turn. */
    takeStickerSlot(chatId: string): boolean;
    sendSegments(chatId: string, segments: Array<{
        type: string;
        data: Record<string, unknown>;
    }>): Promise<string | undefined>;
}
export declare function registerStickerTools(ctx: Context, host: StickerToolHost, library: StickerLibrary): () => void;
