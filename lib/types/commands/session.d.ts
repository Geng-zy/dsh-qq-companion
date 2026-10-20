/**
 * Session commands: /stop, /steer, /retry, /goal and /session (with the retired-session previews).
 * @module dsh-qq-companion/commands/session
 */
import { CommandContext, CommandSender } from './types.js';
import { type ChatId } from '../chat.js';
import type { SessionPreviewEvent } from '../bridge.js';
/** /stop: cancel the running generation and drop deferred loop state. */
export declare function handleStopCommand(ctx: CommandContext, chatId: ChatId): Promise<void>;
/** the /steer submit notice — one line per accepted instruction.
 * Shared with the bridge's auto-steer path ('steer' policy) so both surfaces
 * word the confirmation identically; exported for the deterministic text
 * wait in tests. */
export declare const STEER_ACCEPTED_NOTICE = "\u2705 \u5DF2\u4F5C\u4E3A\u8865\u5145\u6307\u4EE4\u63D0\u4EA4\u7ED9\u5F53\u524D\u4EFB\u52A1\uFF0C\u6A21\u578B\u5C06\u5728\u4E0B\u4E00\u6B65\u8BFB\u53D6\u3002";
/** the /steer usage hint — replied whenever the command cannot
 * steer (empty argument, no live chat, or no running task). Never crashes,
 * never silently no-ops. */
export declare const STEER_USAGE_HINT = "\u7528\u6CD5\uFF1A/steer <\u8865\u5145\u5185\u5BB9> \u2014\u2014 \u5728\u4EFB\u52A1\u8FD0\u884C\u671F\u95F4\u5411\u5F53\u524D\u4EFB\u52A1\u8FFD\u52A0\u4E00\u6761\u8865\u5145\u6307\u4EE4\uFF0C\u6A21\u578B\u4F1A\u5728\u4E0B\u4E00\u6B65\u8BFB\u53D6\uFF1B\u5F53\u524D\u6CA1\u6709\u8FD0\u884C\u4E2D\u7684\u4EFB\u52A1\uFF0C\u76F4\u63A5\u53D1\u9001\u6D88\u606F\u5373\u53EF\u5F00\u59CB\u65B0\u4EFB\u52A1\u3002";
/** /steer: steer one supplementary instruction into the RUNNING
 * turn (both newMessagePolicy modes — an explicit /steer is always allowed).
 * Without a running task (or with an empty argument, or no live chat) it
 * replies with the usage hint instead of steering — the idle-driver steer
 * would otherwise open a turn, which is what plain messages already do.
 * the argument enters the prompt wrapped in the same <user_message>
 * boundary as every inbound payload (same wrapUserMessage shape, qq +
 * nickname attributes) — /steer is admin-gated (trusted sender) but the
 * boundary posture must not fork between the two steerMessage callers. */
export declare function handleSteerCommand(ctx: CommandContext, chatId: ChatId, arg: string, sender: CommandSender): Promise<void>;
/** /retry: re-feed the last user message into the agent. */
export declare function handleRetryCommand(ctx: CommandContext, chatId: ChatId): Promise<void>;
/** /session list-item preview bound, in code points (emoji-safe — see
 * truncatePreview). */
export declare const SESSION_PREVIEW_MAX_CHARS = 40;
/** How many leading events of a stored log the preview cold-reads. The first
 * real user input of a session sits within the first handful of events
 * (turn/start, the claimed user/message, the surface system message), so a
 * bounded prefix read keeps a 20-item list cheap where a full inspect would
 * decode the entire log per item. A log whose prefix holds no user/message
 * at all degrades to 「（无对话内容）」 like an empty one. */
export declare const SESSION_PREVIEW_EVENT_PREFIX = 24;
/** Item text when the log carries no readable user input. */
export declare const PREVIEW_NO_CONTENT = "\uFF08\u65E0\u5BF9\u8BDD\u5185\u5BB9\uFF09";
/** Item text when the stored log is missing, unreadable or corrupt — the
 * degradation must never break the list or the switch-back flow. */
export declare const PREVIEW_UNREADABLE = "\uFF08\u5185\u5BB9\u4E0D\u53EF\u8BFB\uFF09";
/** Whether a logged user-message source names a real queued user prompt (the
 * message a turn claimed) rather than a synthetic agent.inject() context or a
 * goal continuation round. Direct prompts carry kind 'user'; QQ chats
 * attribute their own inbound messages to this plugin (platform-source
 * logging), so the plugin-owned kind 'plugin:qq-companion' is the chat's real
 * user input too. Sessions written before the rename (and rows the host's
 * v3→v4 converter migrated) carry the old kind 'plugin:dsh-onebot'. */
export declare function isRealUserMessageSource(source: {
    kind?: string;
} | undefined): boolean;
/** Code-point-safe truncation (never splits a surrogate pair — the §3.1
 * emoji lesson): at most `maxLength` code points, the last one '…' when cut. */
export declare function truncatePreview(text: string, maxLength: number): string;
/** QQ inbound user messages reach the session wrapped in the
 * <user_message> boundary (chat.ts wrapUserMessage), and inbound.ts may
 * prepend trusted framework metadata OUTSIDE that boundary: the restricted
 * member tag and the group prefix line ([HH:MM 昵称(QQ)][@我] —
 * buildGroupMessagePrefix). Strip that metadata, then return the
 * human-typed body between the opening tag's `>` and the LAST
 * `</user_message>`. Anything that is not a complete wrapped message
 * (different head, missing closer, empty body) comes back unchanged so the
 * caller's existing preview path applies — an unwrap failure never empties
 * the preview. */
export declare function unwrapUserMessageText(text: string): string;
/** One-line preview text of one logged user message: every text block
 * concatenated, whitespace runs (newlines included) collapsed so the result
 * always stays single-line. Non-text blocks are ignored. A wrapped QQ
 * inbound message contributes its unwrapped body (unwrapUserMessageText). */
export declare function userMessagePreviewText(data: unknown): string;
/** The one-line preview of a session's event log (events in log order):
 * the first REAL user input (queued user prompt — kind 'user', or this
 * plugin's attributed QQ message) with non-empty text; when the log has
 * none, the first user/message of ANY source with text (synthetic
 * agent.inject context / goal continuation fallback); '' when the log
 * carries no user input at all. */
export declare function sessionPreviewFromEvents(events: readonly SessionPreviewEvent[], maxLength?: number): string;
/** Shorten a session id for the one-line list while keeping BOTH ends: every
 * onebot id shares the `onebot-…` head, so head-only truncation (e.g. the
 * first 12 characters) would render every entry of a chat identically — the
 * unique tail must survive for the id to stay recognizable. */
export declare function shortSessionId(id: string): string;
/** Cold-read one retired session's preview through the persistence port:
 * open a 'read' handle (never takes write ownership, works beside a live
 * writer), take the header's createdAt plus a small event prefix, then close
 * the handle — always, even when the read failed (AsyncDisposable: a leaked
 * handle pins backend resources). Returns undefined when the log is missing,
 * unreadable or corrupt; the caller renders 「（内容不可读）」 and neither
 * the rest of the list nor the switch-back flow is affected. */
export declare function sessionPreviewFor(ctx: CommandContext, sessionId: string): Promise<{
    createdAt: number | undefined;
    text: string;
} | undefined>;
/** /session: list this chat's switchable retired sessions (the ones /new,
 * /workspace and /preset retired with intact history), or switch the chat back
 * to one by serial number. Each list item carries a one-line content preview
 * (the session's first real user input), the creation time and a truncated
 * id, so the admin can recognize a session without switching back. The
 * numbered list is snapshotted so a following
 * `/session <序号>` picks without re-listing. */
export declare function handleSessionCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
/** Render an epoch-ms timestamp as YYYY-MM-DD HH:mm (local time) — the
 * /session list's retire and creation times share the format. */
export declare function formatTimestamp(ts: number): string;
/** /goal: per-chat objective — recorded and reminded on each turn. */
export declare function handleGoalCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
