import { resolveNumericSelection } from './selection.js';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { RESTRICTED_PREFIX, wrapUserMessage } from '../chat.js';
import { describeError } from '../errors.js';
import { failureRefSuffix } from '../ref.js';
/** /stop: cancel the running generation and drop deferred loop state. */
export async function handleStopCommand(ctx, chatId) {
    const chat = ctx.getChat(chatId);
    if (chat !== undefined && chat.agent.status === 'running') {
        chat.agent.cancel({ kind: 'user' });
        // Drop the deferred loop state so the cancelled turn settles silently
        // instead of flushing its partial text as a final.
        chat.loopPending = null;
        chat.loopBuffer = [];
        await ctx.sendToChat(chatId, '⏹ 已停止生成。');
    }
    else {
        await ctx.sendToChat(chatId, '当前没有正在进行的生成。');
    }
    // 无论是否有运行中生成，都显式终止该聊天的超时补发跟踪——
    // /stop 的语义边界是「只终止当前聊天提交的回合」，补发跟踪随行终止；
    // 其他聊天的条目不受影响。
    ctx.stopDeferredTracking(chatId);
}
/** the /steer submit notice — one line per accepted instruction.
 * Shared with the bridge's auto-steer path ('steer' policy) so both surfaces
 * word the confirmation identically; exported for the deterministic text
 * wait in tests. */
export const STEER_ACCEPTED_NOTICE = '✅ 已作为补充指令提交给当前任务，模型将在下一步读取。';
/** the /steer usage hint — replied whenever the command cannot
 * steer (empty argument, no live chat, or no running task). Never crashes,
 * never silently no-ops. */
export const STEER_USAGE_HINT = '用法：/steer <补充内容> —— 在任务运行期间向当前任务追加一条补充指令，模型会在下一步读取；当前没有运行中的任务，直接发送消息即可开始新任务。';
/** /steer: steer one supplementary instruction into the RUNNING
 * turn (both newMessagePolicy modes — an explicit /steer is always allowed).
 * Without a running task (or with an empty argument, or no live chat) it
 * replies with the usage hint instead of steering — the idle-driver steer
 * would otherwise open a turn, which is what plain messages already do.
 * the argument enters the prompt wrapped in the same <user_message>
 * boundary as every inbound payload (same wrapUserMessage shape, qq +
 * nickname attributes) — /steer is admin-gated (trusted sender) but the
 * boundary posture must not fork between the two steerMessage callers. */
export async function handleSteerCommand(ctx, chatId, arg, sender) {
    const raw = arg.trim();
    const text = raw === '' ? '' : wrapUserMessage(raw, sender.userId, sender.nickname);
    const chat = ctx.getChat(chatId);
    if (text === '' || chat === undefined || chat.agent.status !== 'running' || !ctx.steerRunningTurn(chatId, text)) {
        ctx.log('debug', 'slash /steer rejected (no running task or empty argument) for ' + chatId);
        await ctx.sendToChat(chatId, STEER_USAGE_HINT);
        return;
    }
    ctx.log('info', 'slash /steer for ' + chatId);
    await ctx.sendToChat(chatId, STEER_ACCEPTED_NOTICE);
}
/** /retry: re-feed the last user message into the agent. */
export async function handleRetryCommand(ctx, chatId) {
    const chat = ctx.getChat(chatId);
    if (chat === undefined) {
        await ctx.sendToChat(chatId, '没有可重试的上一条消息。\n先发送一条消息，之后才能 /retry。');
        return;
    }
    if (chat.busy) {
        await ctx.sendToChat(chatId, '当前正在生成，请稍后再重试。');
        return;
    }
    const text = chat.lastFollowup;
    if (text === undefined || text === '') {
        await ctx.sendToChat(chatId, '没有可重试的上一条消息。\n先发送一条消息，之后才能 /retry。');
        return;
    }
    // Start a fresh reply cycle exactly like a new inbound turn.
    chat.loopBuffer = [];
    chat.loopPending = null;
    ctx.log('info', 'retry for ' + chatId);
    // /retry is admin-gated in tryHandleCommand, so the retried turn's role is
    // the admin who issued the command.
    try {
        await ctx.dispatchFollowup(chatId, text, 'admin', chat.lastNickname);
    }
    catch (error) {
        // a failed retry is a message fault — mint an MF- reference
        // (trace + structured log via the bridge) and surface it in the ⚠️ notice
        // instead of letting the throw escape the router silently.
        const ref = ctx.reportFailure?.(chatId, 'command', '/retry 重试失败: ' + describeError(error));
        await ctx.sendToChat(chatId, '⚠️ 重试失败：' + describeError(error) + failureRefSuffix(ref));
    }
}
// ------------------------------------------------------------ /session previews
/** /session list-item preview bound, in code points (emoji-safe — see
 * truncatePreview). */
export const SESSION_PREVIEW_MAX_CHARS = 40;
/** How many leading events of a stored log the preview cold-reads. The first
 * real user input of a session sits within the first handful of events
 * (turn/start, the claimed user/message, the surface system message), so a
 * bounded prefix read keeps a 20-item list cheap where a full inspect would
 * decode the entire log per item. A log whose prefix holds no user/message
 * at all degrades to 「（无对话内容）」 like an empty one. */
export const SESSION_PREVIEW_EVENT_PREFIX = 24;
/** Item text when the log carries no readable user input. */
export const PREVIEW_NO_CONTENT = '（无对话内容）';
/** Item text when the stored log is missing, unreadable or corrupt — the
 * degradation must never break the list or the switch-back flow. */
export const PREVIEW_UNREADABLE = '（内容不可读）';
/** Whether a logged user-message source names a real queued user prompt (the
 * message a turn claimed) rather than a synthetic agent.inject() context or a
 * goal continuation round. Direct prompts carry kind 'user'; QQ chats
 * attribute their own inbound messages to this plugin (platform-source
 * logging), so the plugin-owned kind 'plugin:qq-companion' is the chat's real
 * user input too. Sessions written before the rename (and rows the host's
 * v3→v4 converter migrated) carry the old kind 'plugin:dsh-onebot'. */
export function isRealUserMessageSource(source) {
    if (source === undefined || typeof source !== 'object')
        return false;
    if (source.kind === 'user')
        return true;
    return source.kind === 'plugin:qq-companion' || source.kind === 'plugin:dsh-onebot';
}
/** Code-point-safe truncation (never splits a surrogate pair — the §3.1
 * emoji lesson): at most `maxLength` code points, the last one '…' when cut. */
export function truncatePreview(text, maxLength) {
    if (maxLength <= 0)
        return '';
    const chars = Array.from(text);
    if (chars.length <= maxLength)
        return text;
    return chars.slice(0, maxLength - 1).join('') + '…';
}
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
export function unwrapUserMessageText(text) {
    let rest = text;
    if (rest.startsWith(RESTRICTED_PREFIX))
        rest = rest.slice(RESTRICTED_PREFIX.length);
    const groupPrefix = /^\[\d{2}:\d{2} .*?\(\d+\)\](?:\[@我\])? /.exec(rest);
    if (groupPrefix !== null)
        rest = rest.slice(groupPrefix[0].length);
    if (!rest.startsWith('<user_message '))
        return text;
    const openEnd = rest.indexOf('>');
    const closeStart = rest.lastIndexOf('</user_message>');
    if (openEnd < 0 || closeStart < openEnd)
        return text;
    const body = rest.slice(openEnd + 1, closeStart);
    return body.trim() === '' ? text : body;
}
/** One-line preview text of one logged user message: every text block
 * concatenated, whitespace runs (newlines included) collapsed so the result
 * always stays single-line. Non-text blocks are ignored. A wrapped QQ
 * inbound message contributes its unwrapped body (unwrapUserMessageText). */
export function userMessagePreviewText(data) {
    const content = data?.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (block !== null && typeof block === 'object'
            && block.type === 'text'
            && typeof block.text === 'string') {
            parts.push(block.text);
        }
    }
    return unwrapUserMessageText(parts.join('')).replace(/\s+/g, ' ').trim();
}
/** The one-line preview of a session's event log (events in log order):
 * the first REAL user input (queued user prompt — kind 'user', or this
 * plugin's attributed QQ message) with non-empty text; when the log has
 * none, the first user/message of ANY source with text (synthetic
 * agent.inject context / goal continuation fallback); '' when the log
 * carries no user input at all. */
export function sessionPreviewFromEvents(events, maxLength = SESSION_PREVIEW_MAX_CHARS) {
    let fallback = '';
    for (const event of events) {
        if (event === null || typeof event !== 'object' || event.type !== 'user/message')
            continue;
        const text = userMessagePreviewText(event.data);
        if (text === '')
            continue;
        const source = event.data?.source;
        if (isRealUserMessageSource(source))
            return truncatePreview(text, maxLength);
        if (fallback === '')
            fallback = text;
    }
    return fallback === '' ? '' : truncatePreview(fallback, maxLength);
}
/** Shorten a session id for the one-line list while keeping BOTH ends: every
 * onebot id shares the `onebot-…` head, so head-only truncation (e.g. the
 * first 12 characters) would render every entry of a chat identically — the
 * unique tail must survive for the id to stay recognizable. */
export function shortSessionId(id) {
    if (id.length <= 20)
        return id;
    return id.slice(0, 8) + '…' + id.slice(-8);
}
/** Cold-read one retired session's preview through the persistence port:
 * open a 'read' handle (never takes write ownership, works beside a live
 * writer), take the header's createdAt plus a small event prefix, then close
 * the handle — always, even when the read failed (AsyncDisposable: a leaked
 * handle pins backend resources). Returns undefined when the log is missing,
 * unreadable or corrupt; the caller renders 「（内容不可读）」 and neither
 * the rest of the list nor the switch-back flow is affected. */
export async function sessionPreviewFor(ctx, sessionId) {
    const persistence = ctx.sessionPersistence;
    if (persistence === undefined)
        return { createdAt: undefined, text: '' };
    let handle;
    try {
        handle = await persistence.open(makeSessionId(sessionId), 'read');
        const prefix = await handle.read(0, SESSION_PREVIEW_EVENT_PREFIX);
        const createdAt = typeof handle.header?.createdAt === 'number' && Number.isFinite(handle.header.createdAt) && handle.header.createdAt > 0
            ? handle.header.createdAt
            : undefined;
        return { createdAt, text: sessionPreviewFromEvents(prefix.events) };
    }
    catch (error) {
        ctx.log('warn', 'session preview read failed for ' + sessionId + ' (the list still renders): ' + describeError(error));
        return undefined;
    }
    finally {
        if (handle !== undefined) {
            try {
                await handle.close();
            }
            catch (closeError) {
                ctx.log('debug', 'session preview handle close failed for ' + sessionId + ': ' + describeError(closeError));
            }
        }
    }
}
/** /session: list this chat's switchable retired sessions (the ones /new,
 * /workspace and /preset retired with intact history), or switch the chat back
 * to one by serial number. Each list item carries a one-line content preview
 * (the session's first real user input), the creation time and a truncated
 * id, so the admin can recognize a session without switching back. The
 * numbered list is snapshotted so a following
 * `/session <序号>` picks without re-listing. */
export async function handleSessionCommand(ctx, chatId, arg) {
    if (arg.trim() === '') {
        const list = ctx.switchableSessions(chatId);
        const current = ctx.getChat(chatId)?.sessionId ?? await ctx.sessionIdFromMapping(chatId);
        if (list.length === 0) {
            await ctx.sendToChat(chatId, '当前 session：' + (current ?? '（未建立会话）') + '\n（该会话没有可切回的历史会话）\n用法：/session <序号> 切回；/new、/workspace、/preset 切换下来的旧会话会进入列表。');
            return;
        }
        // Each item carries a one-line content preview + creation time so the
        // admin can recognize the session without switching back. Previews are
        // fetched per item and any failure degrades that item only — the rest of
        // the list and the switch-back snapshot (full ids as payloads) are untouched.
        const lines = await Promise.all(list.map(async (entry, index) => {
            const preview = await sessionPreviewFor(ctx, entry.id);
            const text = preview === undefined ? PREVIEW_UNREADABLE : (preview.text !== '' ? preview.text : PREVIEW_NO_CONTENT);
            const created = preview?.createdAt !== undefined ? formatTimestamp(preview.createdAt) + ' 建立 · ' : '';
            return `${index + 1}. ${text}（${created}${formatTimestamp(entry.retiredAt)} 退休 · ${shortSessionId(entry.id)}）`;
        }));
        let out = '当前 session：' + (current ?? '（未建立会话）') + '\n可切回历史会话：\n' + lines.join('\n');
        out += '\n回复 /session <序号> 切回（当前会话会进入列表，可来回切换）。';
        ctx.setPendingSelection(chatId, {
            kind: 'session',
            items: list.map(e => ({ label: e.id, payload: e.id })),
            createdAt: Date.now(),
        });
        await ctx.sendToChat(chatId, out);
        return;
    }
    // A busy chat must not be switched mid-generation (the outbound pipeline and
    // the interim state belong to the live agent; the switch disposes it).
    const chat = ctx.getChat(chatId);
    if (/^\d+$/.test(arg.trim()) && chat !== undefined && chat.busy) {
        await ctx.sendToChat(chatId, '当前正在生成回复，请先 /stop 再切换会话。');
        return;
    }
    const picked = await resolveNumericSelection(ctx, chatId, 'session', arg, '/session');
    if (picked === null)
        return;
    if (picked === undefined) {
        await ctx.sendToChat(chatId, '用法：/session 查看可切回会话；/session <序号> 切回。');
        return;
    }
    const outcome = await ctx.switchSession(chatId, picked.payload);
    if (outcome.ok) {
        await ctx.sendToChat(chatId, `✅ 已切回历史会话：${outcome.sessionId}\n（原会话已进入可切回列表，发 /session 查看；下一条消息继续该会话的历史上下文。）`);
        return;
    }
    if (outcome.reason === 'busy') {
        await ctx.sendToChat(chatId, '当前正在生成回复，请先 /stop 再切换会话。');
        return;
    }
    if (outcome.reason === 'not-switchable') {
        await ctx.sendToChat(chatId, '❌ 该序号对应的会话不在当前会话的可切回列表中。发 /session 重新查看。');
        return;
    }
    if (outcome.reason === 'broken') {
        await ctx.sendToChat(chatId, '❌ 该历史会话已损坏，无法切回。\n发 /session 查看其他可切回会话。');
        return;
    }
    await ctx.sendToChat(chatId, '❌ 切回历史会话失败：' + outcome.message + '\n已回退：下一条消息将开启全新会话，原会话仍保留在 /session 列表中。');
}
/** Render an epoch-ms timestamp as YYYY-MM-DD HH:mm (local time) — the
 * /session list's retire and creation times share the format. */
export function formatTimestamp(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
/** /goal: per-chat objective — recorded and reminded on each turn. */
export async function handleGoalCommand(ctx, chatId, arg) {
    const v = arg.trim();
    if (v === '') {
        const goal = ctx.goal(chatId);
        await ctx.sendToChat(chatId, '当前目标：' + (goal !== undefined && goal !== '' ? '\n' + goal : '（未设置）') + '\n用法：/goal <目标> 设置/更新；/goal clear 清除');
        return;
    }
    if (v.toLowerCase() === 'clear' || v === '删除' || v === '移除') {
        ctx.deleteGoal(chatId);
        await ctx.sendToChat(chatId, '✅ 目标已清除。');
        return;
    }
    ctx.setGoal(chatId, v);
    await ctx.sendToChat(chatId, '✅ 目标已记录（每轮自动附带提醒）：\n' + v);
}
