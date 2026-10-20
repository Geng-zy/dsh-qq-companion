/**
 * Numbered-list selection shared by /model, /preset, /session and /workspace, plus small lookups those commands share.
 * @module dsh-qq-companion/commands/selection
 */
import { CommandContext } from './types.js';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import { type ChatId } from '../chat.js';
import type { PendingSelection } from '../registry.js';
/** TTL of a pending serial-number selection — judged lazily at the next
 * same-kind numeric reply (no timers): a snapshot older than 5 minutes is
 * expired and treated as stateless. */
export declare const PENDING_SELECTION_TTL_MS: number;
/** What a numeric pick hands back to its handler: the item's resolved payload
 * plus the snapshot provenance (only /model branches on phase/provider). */
export interface PendingPick {
    payload: string;
    phase?: 'providers' | 'models';
    provider?: string;
}
/**
 * serial-number resolution. When `arg` is a pure number AND the chat holds
 * a pending selection snapshot of the same kind, the argument is read as a
 * 1-based index into that snapshot:
 *  - in-range hit     → clears the snapshot and returns the item (the handler
 *    re-runs its original switch path with `payload`);
 *  - expired snapshot → replies 「序号选择已过期…」, clears it, returns null (stop);
 *  - out of range     → replies 「序号越界…」, KEEPS the snapshot (the user can
 *    retry a correct index without re-listing), returns null (stop).
 * Anything else — a non-numeric argument, or no same-kind snapshot at all —
 * returns undefined so the handler's original semantics run unchanged.
 * Snapshots of other kinds are never touched here (single shared slot,
 * refreshed only by a bare /workspace|/model|/preset).
 */
export declare function resolveNumericSelection(ctx: CommandContext, chatId: ChatId, kind: PendingSelection['kind'], arg: string, command: string): Promise<PendingPick | null | undefined>;
/** Current default model selection, best-effort (absent services return undefined). */
export declare function safeDefaultModel(ctx: CommandContext): ModelSelection | undefined;
/** Enumerate the on-disk agent presets (<dsh-home>/.agent-presets/*). */
export declare function listPresets(ctx: CommandContext): Promise<string[]>;
