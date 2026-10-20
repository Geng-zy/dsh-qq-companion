import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
/** TTL of a pending serial-number selection — judged lazily at the next
 * same-kind numeric reply (no timers): a snapshot older than 5 minutes is
 * expired and treated as stateless. */
export const PENDING_SELECTION_TTL_MS = 5 * 60 * 1000;
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
export async function resolveNumericSelection(ctx, chatId, kind, arg, command) {
    if (!/^\d+$/.test(arg.trim()))
        return undefined;
    const pending = ctx.pendingSelection(chatId);
    if (pending === undefined || pending.kind !== kind)
        return undefined;
    if (Date.now() - pending.createdAt > PENDING_SELECTION_TTL_MS) {
        ctx.setPendingSelection(chatId, undefined);
        await ctx.sendToChat(chatId, `❌ 序号选择已过期，请重新执行 ${command} 查看。`);
        return null;
    }
    const item = pending.items[Number(arg.trim()) - 1];
    if (item === undefined) {
        await ctx.sendToChat(chatId, `❌ 序号越界，请回复 ${command} 重新查看列表。`);
        return null;
    }
    ctx.setPendingSelection(chatId, undefined);
    return { payload: item.payload, phase: pending.phase, provider: pending.provider };
}
/** Current default model selection, best-effort (absent services return undefined). */
export function safeDefaultModel(ctx) {
    try {
        return ctx.agentDefaultModel?.currentSelection();
    }
    catch (error) {
        ctx.log('debug', 'currentSelection failed: ' + String(error));
        return undefined;
    }
}
/** Enumerate the on-disk agent presets (<dsh-home>/.agent-presets/*). */
export async function listPresets(ctx) {
    const home = ctx.dshHome;
    if (home === undefined || home === '')
        return [];
    const root = join(home, '.agent-presets');
    try {
        const entries = await readdir(root, { withFileTypes: true });
        const out = [];
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            let label = entry.name;
            try {
                const text = await readFile(join(root, entry.name, 'preset.yml'), 'utf8');
                const m = /^name\s*:\s*(.+?)\s*$/m.exec(text);
                if (m !== null && m[1].trim() !== '')
                    label = m[1].trim();
            }
            catch {
                // no preset.yml — fall back to the directory id
            }
            out.push(entry.name + (label !== entry.name ? '（' + label + '）' : ''));
        }
        return out.sort();
    }
    catch (error) {
        ctx.log('debug', 'preset enumeration failed: ' + String(error));
        return [];
    }
}
