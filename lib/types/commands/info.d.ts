/**
 * Inspection commands: /id, /ver, /status, /doctor, /mode and /ocr.
 * @module dsh-qq-companion/commands/info
 */
import { CommandContext } from './types.js';
import { type ChatId } from '../chat.js';
/** /id: show the chat/session identity (admin debug aid). */
export declare function handleIdCommand(ctx: CommandContext, chatId: ChatId): Promise<void>;
/** /ver: plugin version + git commit (each read once and cached). */
export declare function handleVerCommand(ctx: CommandContext, chatId: ChatId): Promise<void>;
/** /status: one-shot snapshot of the chat session state. */
export declare function handleStatusCommand(ctx: CommandContext, chatId: ChatId): Promise<void>;
/** /doctor: render the health summary, or pack the redacted
 * diagnostics archive with the `export` argument. Failures are reported to
 * the chat as a ⚠️ line, never thrown past the router. */
export declare function handleHealthcheckCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
/** /mode: per-chat outbound-mode override (interim vs instant). */
export declare function handleModeCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
/** /ocr: OCR the most recent inbound image via NapCat's ocr_image. */
export declare function handleOcrCommand(ctx: CommandContext, chatId: ChatId): Promise<void>;
/** Plugin version from package.json, read once (per process). Exported for the /ver ESM regression test. */
export declare let cachedPluginVersion: string | undefined;
/** The plugin's package root: the nearest ancestor directory holding this
 * plugin's package.json (works from src/ under tests and from lib/ deployed). */
export declare function pluginRoot(): string | undefined;
export declare function packageVersion(): string | undefined;
/** Git short commit of the plugin repo, read once (best-effort, per process). */
export declare let cachedGitCommit: string | undefined;
export declare function gitCommit(): string | undefined;
