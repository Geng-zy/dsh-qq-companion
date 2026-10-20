/**
 * Model and environment commands: /model, /workspace and /preset.
 * @module dsh-qq-companion/commands/model
 */
import { CommandContext } from './types.js';
import { type ChatId } from '../chat.js';
/** /model: show the current model (+ discoverable providers), or switch.
 * A bare switch retargets ONLY this chat's selection ref (it no
 * longer rewrites the deployment default — that is the explicit --default
 * form's job). */
export declare function handleModelCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
/** level-2 model list for one provider: renders the numbered models and
 * snapshots them (phase 'models') so the next `/model <序号>` hits the
 * original per-chat switch path with '<provider> <model>'. */
export declare function sendModelPickList(ctx: CommandContext, chatId: ChatId, provider: string): Promise<void>;
/** /workspace: show current cwd, list workspaces, or switch directory. */
export declare function handleWorkspaceCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
/** /preset: show available agent presets and the current one, or switch. */
export declare function handlePresetCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void>;
