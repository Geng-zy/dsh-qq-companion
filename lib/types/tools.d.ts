/**
 * Model-facing tools for the OneBot channel: media sends, merged forwards,
 * the whitelisted NapCat API proxy, and group history. Tools infer the target
 * chat from the calling agent's session; an explicit chat_id overrides.
 * @module dsh-qq-companion/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatBridge } from './bridge.js';
import type { OneBotConnection } from './connection.js';
/**
 * Register all qq_* tools on the context. Registration is effect-based: the
 * returned disposer unregisters them.
 * @param ctx - plugin context.
 * @param bridge - the chat bridge.
 * @param connection - the OneBot connection.
 * @param limits - media size caps.
 * @returns the disposer.
 */
export declare function registerTools(ctx: Context, bridge: ChatBridge, connection: OneBotConnection, limits: {
    maxImageBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
}): () => void;
/** What the model reads from qq_group_history: one line per message
 * ("[HH:MM] 昵称（QQ）：内容"); the count alone left her with nothing. */
export declare function renderGroupHistory(list: readonly unknown[]): string;
/**
 * qq_memory_note — the one memory write a chat-only (group)
 * session gets: append a short hearsay line to the PUBLIC memory file. The
 * file and section are fixed by config; caps and the keyword fence live in
 * appendMemoryNote.
 */
export declare function registerMemoryNoteTool(ctx: Context, bridge: ChatBridge, append: (chatId: string, text: string, byAdmin: boolean) => Promise<{
    ok: true;
    line: string;
} | {
    ok: false;
    reason: string;
}>): () => void;
