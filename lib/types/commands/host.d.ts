/**
 * Commands forwarded to the dsh host: /plan and /permission.
 * @module dsh-qq-companion/commands/host
 */
import { CommandContext } from './types.js';
import { type ChatId } from '../chat.js';
/** Unwrap the host command execution outcome: dsh ≥0.1.5-rc.1 settles as
 * the `{ commandId, result: { kind, text } }` wrapper while older hosts
 * returned the flat `{ kind, text }` (and safely ignore the extra
 * attachments argument). undefined stays undefined — an admission miss
 * (unknown command name) under both host versions. */
export declare function unwrapCommandResult(executed: {
    kind?: string;
    text?: string;
    result?: {
        kind?: string;
        text?: string;
    };
} | undefined): {
    kind?: string;
    text?: string;
} | undefined;
/** /plan: forward to the HOST plan command so QQ enters/leaves host plan
 * mode (the host `/plan off` path exits directly, no Web review card). The
 * plugin no longer runs its own prefix plan mode — that duplicated the host
 * semantic and shadowed the host `/plan off` exit. */
export declare function handlePlanCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
/** QQ-side short aliases for /permission, resolved BEFORE forwarding: the
 * two default host presets get terse names. Full preset names pass through
 * untouched — the host owns the presets table (a deployment may override it
 * via cordis.patch.yml), and its unknown-name error reply lists the
 * available presets, which the plugin relays verbatim. */
export declare const PERMISSION_PRESET_ALIASES: Record<string, string>;
/** QQ shortcut hint: the bare-form parse-failure fallback and the ❌-relay
 * tail (the host lists its own presets; these are the QQ-side shortcuts). */
export declare const PERMISSION_USAGE_HINT = "\uFF08QQ \u5FEB\u6377\u7528\u6CD5\uFF1A/permission w \u5207\u5DE5\u4F5C\u533A\u53EF\u5199+\u9700\u5BA1\u6279\u3001/permission f \u5207\u5168\u76D8+\u514D\u5BA1\u6279\uFF1B\u4E5F\u652F\u6301\u5B8C\u6574\u9884\u8BBE\u540D\u6216\u5E8F\u53F7\uFF09";
/** /permission: show the current host permission preset (the bare form
 * renders the parsed Chinese menu: current + numbered available list + usage
 * line; on host-reply format drift it falls back to the verbatim relay + QQ
 * hint) or switch it (sandbox mode + approval policy, effective immediately
 * in the session). Same host-forwarding pattern as /plan. A pure number
 * indexes the available list the bare form parses, resolved live per
 * invocation — deliberately NO pending-selection snapshot: with two presets
 * a stored snapshot could only ever disagree with the host reply, so the
 * bare pre-flight is the single source of truth. */
export declare function handlePermissionCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
/** Parse the 「(available: A, B)」 list out of a host permission reply (both
 * the bare listing and the unknown-preset error carry it). Returns [] when
 * the reply does not match the host's reply shape. */
export declare function parseAvailablePresets(text: string): string[];
export declare const PERMISSION_PRESET_LABELS: Record<string, string>;
/** The usage line that closes the bare-form menu. */
export declare const PERMISSION_USAGE = "\u7528\u6CD5\uFF1A/permission <\u5E8F\u53F7|w|f|\u5B8C\u6574\u540D> \u5207\u6362\uFF0C\u7ACB\u5373\u751F\u6548";
/** Parse the 「current preset X」 marker out of a host permission reply
 * (undefined when the reply does not match the host's reply shape). */
export declare function parseCurrentPreset(text: string): string | undefined;
/** /permission bare form: the host reply parsed into a Chinese menu —
 * current preset line, numbered available list (「← 当前」 marker, meaning
 * label per preset, 「部署自定义」 for names outside the default two, never a
 * guess) and the usage line. Any parse failure (host reply format drift)
 * falls back to the previous behavior — verbatim relay + QQ shortcut hint —
 * and never throws. */
export declare function renderPermissionMenu(hostText: string): string;
