/**
 * Slash commands: the routed command table, /help (generated from the
 * table) and the router. Handlers live in commands/ by area; the narrow
 * CommandContext they work through is in commands/types.ts.
 * @module dsh-qq-companion/commands
 */
import { CommandContext, CommandSender } from './commands/types.js';
import { type ChatId } from './chat.js';
export * from './commands/types.js';
export * from './commands/selection.js';
export * from './commands/session.js';
export * from './commands/model.js';
export * from './commands/host.js';
export * from './commands/info.js';
/** One routed slash command: the table row IS the registration —
 * adding a command is exactly one row here and /help picks it up for free. */
export interface CommandDefinition {
    /** Command word after the leading slash (matched case-insensitively). */
    name: string;
    /** Alternative first-words routed to the same handler; rendered nowhere
     * (/help lists only `name`, suggestions map an alias back to it). */
    aliases?: string[];
    /** Admin-only flag; every current command is gated at the router entry. */
    adminOnly: boolean;
    /** /help line shown after "/name ": the usage-argument form (when the
     * command takes arguments) followed by the description, e.g.
     * "[路径|序号|list] 查看或切换工作区" or plain "本帮助". */
    help: string;
    /** /help group header the row renders under (no ▍ prefix). Rows without
     * one fall into 「其他」; a group outside the fixed card order still renders
     * (appended), so a new row always shows up in the card. */
    group?: string;
    handler(ctx: CommandContext, chatId: ChatId, arg: string, sender: CommandSender): Promise<void>;
}
/** The routed command table. Row order = the /help line order inside each
 * group (the router matches by name, so ordering is routing-neutral). */
export declare const COMMANDS: CommandDefinition[];
/** /help body: grouped multi-line card generated from the table — adding a
 * command stays a one-row change and its group header comes from the row
 * (unlisted groups append). The tail line documents the unknown-command
 * behavior. Exported for the full-text snapshot gate in tests/commands.spec.ts. */
export declare function helpText(): string;
/**
 * Slash-command router. Commands are admin-only (the Hermes member
 * slash-command block) and are matched on the first word; a leading
 * @mention glued to the command (QQ group at + text) is stripped first.
 * A path like /tmp/x is never a command (command words are
 * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands get closest-match
 * suggestions (prefix first, edit distance ≤2 for length ≥4 inputs only)
 * and are consumed; with no suggestion, config.unknownCommand decides —
 * 'intercept' (default) consumes with a hint, 'passthrough' returns false
 * so the message reaches the model (the old Hermes fall-through).
 * @param ctx - bridge capabilities (built by ChatBridge).
 * @param chatId - the chat the command arrived in.
 * @param text - parsed inbound text.
 * @param userId - sender QQ number.
 * @param nickname - sender display name (pre-sanitized by inbound.ts); used
 *   by /steer for the <user_message> boundary attribute.
 * @returns true when the message was consumed by a command.
 */
export declare function tryHandleCommand(ctx: CommandContext, chatId: ChatId, text: string, userId: string, nickname?: string): Promise<boolean>;
