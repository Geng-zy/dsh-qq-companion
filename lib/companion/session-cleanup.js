/**
 * Old-session cleanup: deletes the on-disk logs of QQ chat sessions nobody
 * has written to for a while (private and group chats have their own age
 * limits). Only this plugin's sessions (ids onebot-private-… / onebot-group-…)
 * are touched — never web sessions, and never a session some chat still uses.
 * dsh's session index reconciles with the disk, so a removed directory simply
 * drops out of the session list.
 * @module dsh-qq-companion/companion/session-cleanup
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from '../errors.js';
const DAY_MS = 86_400_000;
/** First run this long after startup (the chat mapping is loaded by then). */
export const CLEANUP_FIRST_DELAY_MS = 10 * 60_000;
/** Then every this often. */
export const CLEANUP_INTERVAL_MS = 6 * 3_600_000;
/** Newest mtime of a session directory and the files directly inside it. */
async function lastWrite(dir) {
    let newest = (await stat(dir)).mtimeMs;
    for (const name of await readdir(dir)) {
        try {
            newest = Math.max(newest, (await stat(join(dir, name))).mtimeMs);
        }
        catch {
            // vanished meanwhile
        }
    }
    return newest;
}
/** One cleanup pass. @returns how many sessions were deleted, by kind. */
export async function pruneOldSessions(options) {
    const removed = { private: 0, group: 0 };
    const now = (options.now ?? Date.now)();
    let workspaces;
    try {
        workspaces = await readdir(options.sessionsRoot);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            options.log('warn', '旧会话清理：读不了会话目录: ' + describeError(error));
        return removed;
    }
    const inUse = options.inUse();
    for (const workspace of workspaces) {
        let ids;
        try {
            ids = await readdir(join(options.sessionsRoot, workspace));
        }
        catch {
            continue;
        }
        for (const id of ids) {
            const kind = id.startsWith('onebot-private-') ? 'private' : id.startsWith('onebot-group-') ? 'group' : undefined;
            if (kind === undefined || inUse.has(id))
                continue;
            const keepDays = kind === 'private' ? options.privateKeepDays : options.groupKeepDays;
            if (!(keepDays > 0))
                continue;
            const dir = join(options.sessionsRoot, workspace, id);
            try {
                if (now - await lastWrite(dir) <= keepDays * DAY_MS)
                    continue;
                await rm(dir, { recursive: true, force: true });
                await rm(join(options.projectionCacheDir, id + '.json'), { force: true });
                removed[kind] += 1;
                options.onRemoved?.(id);
            }
            catch (error) {
                options.log('warn', '旧会话清理：删除 ' + id + ' 失败: ' + describeError(error));
            }
        }
    }
    if (removed.private + removed.group > 0) {
        options.log('info', '旧会话清理：删了 ' + removed.private + ' 个私聊会话（超过 ' + options.privateKeepDays + ' 天没用）、' + removed.group + ' 个群聊会话（超过 ' + options.groupKeepDays + ' 天没用）');
    }
    return removed;
}
/** Runs pruneOldSessions shortly after start, then periodically. */
export class SessionCleaner {
    options;
    first;
    timer;
    running = Promise.resolve();
    constructor(options) {
        this.options = options;
    }
    /** Whether any limit is set (nothing to schedule otherwise). */
    get enabled() {
        return this.options.privateKeepDays > 0 || this.options.groupKeepDays > 0;
    }
    start(firstDelayMs = CLEANUP_FIRST_DELAY_MS, intervalMs = CLEANUP_INTERVAL_MS) {
        if (!this.enabled || this.timer !== undefined)
            return;
        const run = () => { this.running = this.running.then(() => pruneOldSessions(this.options)).catch(() => undefined); };
        this.first = setTimeout(run, firstDelayMs);
        this.first.unref?.();
        this.timer = setInterval(run, intervalMs);
        this.timer.unref?.();
    }
    async stop() {
        if (this.first !== undefined)
            clearTimeout(this.first);
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.first = undefined;
        this.timer = undefined;
        await this.running;
    }
}
