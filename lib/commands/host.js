import { describeError } from '../errors.js';
/** Unwrap the host command execution outcome: dsh ≥0.1.5-rc.1 settles as
 * the `{ commandId, result: { kind, text } }` wrapper while older hosts
 * returned the flat `{ kind, text }` (and safely ignore the extra
 * attachments argument). undefined stays undefined — an admission miss
 * (unknown command name) under both host versions. */
export function unwrapCommandResult(executed) {
    if (executed === undefined)
        return undefined;
    return 'result' in executed ? executed.result : executed;
}
/** /plan: forward to the HOST plan command so QQ enters/leaves host plan
 * mode (the host `/plan off` path exits directly, no Web review card). The
 * plugin no longer runs its own prefix plan mode — that duplicated the host
 * semantic and shadowed the host `/plan off` exit. */
export async function handlePlanCommand(ctx, chatId, arg) {
    const chat = ctx.getChat(chatId);
    if (chat === undefined) {
        await ctx.sendToChat(chatId, '请先发一条消息建立会话，再 /plan。');
        return;
    }
    const commands = ctx.commands;
    if (commands === undefined) {
        await ctx.sendToChat(chatId, '❌ 宿主未提供 commands 服务，无法切换计划模式。');
        return;
    }
    const line = arg.trim() === '' ? '/plan' : '/plan ' + arg.trim();
    try {
        // The host command runtime requires the attachments array (it reads
        // `.length` unconditionally) and a signal (it reads `signal.aborted`
        // unconditionally) — pass an empty array and a fresh never-aborted one;
        // QQ user-initiated /plan must not be interruptible by our own
        // cancellation.
        const result = unwrapCommandResult(await commands.execute(chat.agent, line, [], new AbortController().signal));
        const text = result?.text !== undefined && result.text !== '' ? result.text : (arg.trim().toLowerCase() === 'off' ? '已退出计划模式。' : '已进入计划模式。');
        const hint = arg.trim().toLowerCase() === 'off' ? '' : '\n（QQ 退出计划模式：发 /plan off）';
        await ctx.sendToChat(chatId, text + hint);
        ctx.log('info', 'host plan command for ' + chatId + ': ' + line);
    }
    catch (error) {
        ctx.log('warn', 'host plan command failed: ' + String(error));
        await ctx.sendToChat(chatId, '❌ 计划模式切换失败：' + describeError(error) + '\n可稍后重试；发 /plan 查看当前计划模式状态。');
    }
}
/** QQ-side short aliases for /permission, resolved BEFORE forwarding: the
 * two default host presets get terse names. Full preset names pass through
 * untouched — the host owns the presets table (a deployment may override it
 * via cordis.patch.yml), and its unknown-name error reply lists the
 * available presets, which the plugin relays verbatim. */
export const PERMISSION_PRESET_ALIASES = {
    w: 'workspace-write',
    ws: 'workspace-write',
    write: 'workspace-write',
    工作区: 'workspace-write',
    f: 'danger-full-access',
    full: 'danger-full-access',
    danger: 'danger-full-access',
    全权: 'danger-full-access',
};
/** QQ shortcut hint: the bare-form parse-failure fallback and the ❌-relay
 * tail (the host lists its own presets; these are the QQ-side shortcuts). */
export const PERMISSION_USAGE_HINT = '（QQ 快捷用法：/permission w 切工作区可写+需审批、/permission f 切全盘+免审批；也支持完整预设名或序号）';
/** /permission: show the current host permission preset (the bare form
 * renders the parsed Chinese menu: current + numbered available list + usage
 * line; on host-reply format drift it falls back to the verbatim relay + QQ
 * hint) or switch it (sandbox mode + approval policy, effective immediately
 * in the session). Same host-forwarding pattern as /plan. A pure number
 * indexes the available list the bare form parses, resolved live per
 * invocation — deliberately NO pending-selection snapshot: with two presets
 * a stored snapshot could only ever disagree with the host reply, so the
 * bare pre-flight is the single source of truth. */
export async function handlePermissionCommand(ctx, chatId, arg) {
    const chat = ctx.getChat(chatId);
    if (chat === undefined) {
        await ctx.sendToChat(chatId, '请先发一条消息建立会话，再 /permission。');
        return;
    }
    const commands = ctx.commands;
    if (commands === undefined) {
        await ctx.sendToChat(chatId, '❌ 宿主未提供 commands 服务，无法切换权限预设。');
        return;
    }
    // One host /permission execution: returns the settled reply (null when a
    // failure was already reported to the chat). Same forwarding constraints
    // as /plan — the host runtime reads submittedAttachments.length and
    // signal.aborted unconditionally, so pass an empty array and a fresh
    // never-aborted signal; a QQ-initiated switch must not be interruptible
    // by our own cancellation.
    const executeHost = async (line) => {
        try {
            const live = ctx.getChat(chatId);
            if (live === undefined)
                return null;
            const result = unwrapCommandResult(await commands.execute(live.agent, line, [], new AbortController().signal));
            if (result === undefined) {
                // Host admission miss: /permission is only registered when the
                // permission-presets plugin is composed on the host side.
                await ctx.sendToChat(chatId, '❌ 宿主未注册 /permission 命令（未挂载权限预设插件）。');
                return null;
            }
            return { ok: result.kind !== 'error', text: result.text ?? '' };
        }
        catch (error) {
            ctx.log('warn', 'host permission command failed: ' + String(error));
            await ctx.sendToChat(chatId, '❌ 权限预设切换失败：' + describeError(error) + '\n可稍后重试；发 /permission 查看当前权限。');
            return null;
        }
    };
    const relayMarked = async (result, preset) => {
        // Success: the host's own reply is too terse ('preset X') — render the
        // switch confirmation with the Chinese meaning label (deployment-custom
        // preset names fall back to a fixed label). ❌ relays keep the host text
        // verbatim and append the QQ usage hint so the failure is actionable
        // without a second round-trip.
        if (result.ok) {
            await ctx.sendToChat(chatId, '✅ 已切换权限预设：' + preset + '（' + (PERMISSION_PRESET_LABELS[preset] ?? '部署自定义') + '）');
            return;
        }
        await ctx.sendToChat(chatId, '❌ ' + result.text + '\n' + PERMISSION_USAGE_HINT);
    };
    const trimmed = arg.trim();
    if (trimmed === '') {
        // Bare form: render the parsed host reply as a Chinese menu — current
        // preset line, numbered available list (「← 当前」 marker + meaning label
        // per preset) and the usage line. When the reply does not match the
        // expected host shape, renderPermissionMenu falls back to the previous
        // behavior (verbatim relay + QQ shortcut hint) instead of crashing.
        const bare = await executeHost('/permission');
        if (bare !== null)
            await ctx.sendToChat(chatId, renderPermissionMenu(bare.text));
        return;
    }
    if (/^\d+$/.test(trimmed)) {
        // Pure number: index into the bare form's available list (live pre-flight).
        const bare = await executeHost('/permission');
        if (bare === null)
            return;
        const available = parseAvailablePresets(bare.text);
        const preset = available[Number(trimmed) - 1];
        if (preset === undefined) {
            // Out-of-range index or unparsable list: fall back to the usage hint,
            // relaying whatever the host replied so the real list stays visible.
            const reply = '❌ 序号 ' + trimmed + ' 无法解释为可用预设。' + (bare.text !== '' ? '\n' + bare.text : '') + '\n' + PERMISSION_USAGE_HINT;
            await ctx.sendToChat(chatId, reply);
            return;
        }
        const switched = await executeHost('/permission ' + preset);
        if (switched !== null)
            await relayMarked(switched, preset);
        return;
    }
    // Alias first (QQ-side, case-insensitive); anything else is forwarded
    // verbatim as a full preset name — unknown names come back as the host's
    // error reply (with the available list), relayed with the ❌ mark.
    const preset = PERMISSION_PRESET_ALIASES[trimmed.toLowerCase()] ?? trimmed;
    const switched = await executeHost('/permission ' + preset);
    if (switched !== null)
        await relayMarked(switched, preset);
}
/** Parse the 「(available: A, B)」 list out of a host permission reply (both
 * the bare listing and the unknown-preset error carry it). Returns [] when
 * the reply does not match the host's reply shape. */
export function parseAvailablePresets(text) {
    const m = /\(available: ([^)]*)\)/.exec(text);
    if (m === null)
        return [];
    return m[1].split(',').map(s => s.trim()).filter(s => s !== '');
}
export const PERMISSION_PRESET_LABELS = {
    'workspace-write': '工作区可写+需审批',
    'danger-full-access': '全盘+免审批',
};
/** The usage line that closes the bare-form menu. */
export const PERMISSION_USAGE = '用法：/permission <序号|w|f|完整名> 切换，立即生效';
/** Parse the 「current preset X」 marker out of a host permission reply
 * (undefined when the reply does not match the host's reply shape). */
export function parseCurrentPreset(text) {
    return /current preset ([^\s(]+)/.exec(text)?.[1];
}
/** /permission bare form: the host reply parsed into a Chinese menu —
 * current preset line, numbered available list (「← 当前」 marker, meaning
 * label per preset, 「部署自定义」 for names outside the default two, never a
 * guess) and the usage line. Any parse failure (host reply format drift)
 * falls back to the previous behavior — verbatim relay + QQ shortcut hint —
 * and never throws. */
export function renderPermissionMenu(hostText) {
    const available = parseAvailablePresets(hostText);
    const current = parseCurrentPreset(hostText);
    if (available.length === 0 || current === undefined) {
        return hostText + '\n' + PERMISSION_USAGE_HINT;
    }
    const labelOf = (preset) => PERMISSION_PRESET_LABELS[preset] ?? '部署自定义';
    return [
        '当前权限：' + current + '（' + labelOf(current) + '）',
        '可用预设：',
        ...available.map((p, i) => (i + 1) + '. ' + p + '（' + labelOf(p) + '）' + (p === current ? ' ← 当前' : '')),
        PERMISSION_USAGE,
    ].join('\n');
}
