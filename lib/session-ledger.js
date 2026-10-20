/**
 * The session ledger: which session ids may never be created again, and each
 * chat's /session switch-back history — both persisted across restarts.
 *
 *  - broken: ids whose logs are unusable (collision heals, failed resumes,
 *    create collisions) — this run only; creates must avoid them;
 *  - retired: every retired id, broken or soft-retired by /new (durable copy
 *    in retired-sessions.json). Soft-retired ids stay switch-back targets;
 *  - switchable: per chat, the soft-retired sessions /session can switch
 *    back to, newest first, capped (switchable-sessions.json).
 *
 * File discipline for both files: only a missing file means "fresh start";
 * a read failure or corrupt JSON keeps the in-memory state so a later save
 * never overwrites history with nothing.
 * @module dsh-qq-companion/session-ledger
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionId as makeSessionId } from '@deepseek-ai/dsh-session';
import { sessionIdForChat } from './chat.js';
import { describeError } from './errors.js';
import { SerialFileWriter } from './persist.js';
export const RETIRED_FILE = 'retired-sessions.json';
export const SWITCHABLE_FILE = 'switchable-sessions.json';
/** Most switch-back entries kept per chat. */
export const SWITCHABLE_CAP = 20;
export class SessionLedger {
    log;
    retiredPath;
    switchablePath;
    retiredWriter;
    switchableWriter;
    /** Ids whose persisted logs are unusable (this run). */
    broken = new Set();
    /** Every retired id (durable). */
    retired = new Set();
    switchableByChat = new Map();
    constructor(options) {
        this.log = options.log;
        this.retiredPath = join(options.mediaDir, RETIRED_FILE);
        this.switchablePath = join(options.mediaDir, SWITCHABLE_FILE);
        const writerLog = (level, message) => this.log(level, message);
        this.retiredWriter = new SerialFileWriter(this.retiredPath, { label: 'retired-sessions', log: writerLog });
        this.switchableWriter = new SerialFileWriter(this.switchablePath, { label: 'switchable-sessions', log: writerLog });
    }
    /** Whether a session id must never be created again (this run or on disk). */
    isBlocked(id) {
        return this.broken.has(id) || this.retired.has(id);
    }
    /** A suffixed session id for a chat that avoids every blocked id. */
    freshSessionId(chatId) {
        let id;
        do {
            id = makeSessionId(sessionIdForChat(chatId) + '-' + Date.now().toString(36));
        } while (this.isBlocked(id));
        return id;
    }
    /** Permanently retire a broken id (in memory and on disk). */
    retireBroken(id) {
        this.broken.add(id);
        this.retired.add(id);
        void this.saveRetired();
    }
    /** Soft-retire an id (/new, retired groups): blocked from creates, still a
     * switch-back target. */
    softRetire(id) {
        this.retired.add(id);
        void this.saveRetired();
    }
    /** A switched-back session is live again: lift its retired mark so the
     * normal resume paths keep finding it. */
    unRetire(id) {
        this.broken.delete(id);
        this.retired.delete(id);
        void this.saveRetired();
    }
    async loadRetired() {
        let content;
        try {
            content = await readFile(this.retiredPath, 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                this.log('warn', 'retired-sessions read failed; keeping the current set: ' + describeError(error));
            }
            return;
        }
        try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
                // Not backfilled into `broken`: the file cannot tell a broken id from
                // a soft-retired one, and isBlocked already covers both for creates.
                this.retired = new Set(parsed.filter((id) => typeof id === 'string'));
                this.log('debug', 'retired-sessions file has ' + this.retired.size + ' id(s)');
            }
            else {
                this.log('warn', 'retired-sessions file is not a JSON array; ignoring');
            }
        }
        catch (error) {
            this.log('warn', 'retired-sessions file is unparsable; keeping the current set: ' + describeError(error));
        }
    }
    saveRetired() {
        return this.retiredWriter.write(() => JSON.stringify(Array.from(this.retired), null, 2));
    }
    async loadSwitchable() {
        let content;
        try {
            content = await readFile(this.switchablePath, 'utf8');
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                this.log('warn', 'switchable-sessions read failed; keeping the current lists: ' + describeError(error));
            }
            return;
        }
        try {
            const parsed = JSON.parse(content);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const loaded = new Map();
                for (const [chatId, list] of Object.entries(parsed)) {
                    if (!Array.isArray(list))
                        continue;
                    const entries = list.filter((entry) => entry !== null && typeof entry === 'object' &&
                        typeof entry.id === 'string' && typeof entry.retiredAt === 'number');
                    if (entries.length > 0)
                        loaded.set(chatId, entries.slice(0, SWITCHABLE_CAP));
                }
                this.switchableByChat = loaded;
                this.log('debug', 'switchable-sessions file has ' + loaded.size + ' chat(s)');
            }
            else {
                this.log('warn', 'switchable-sessions file is not a JSON object; ignoring');
            }
        }
        catch (error) {
            this.log('warn', 'switchable-sessions file is unparsable; keeping the current lists: ' + describeError(error));
        }
    }
    saveSwitchable() {
        return this.switchableWriter.write(() => {
            const payload = {};
            for (const [chatId, list] of this.switchableByChat)
                payload[chatId] = list;
            return JSON.stringify(payload, null, 2);
        });
    }
    /** The chat's switch-back candidates (a copy; newest first). */
    switchable(chatId) {
        return [...(this.switchableByChat.get(chatId) ?? [])];
    }
    isSwitchable(chatId, sessionId) {
        return (this.switchableByChat.get(chatId) ?? []).some(entry => entry.id === sessionId);
    }
    /** Record a just-soft-retired session for its chat: deduped by id (a
     * re-retire refreshes it to the front), newest first, capped. */
    recordSwitchable(chatId, sessionId) {
        const rest = (this.switchableByChat.get(chatId) ?? []).filter(entry => entry.id !== sessionId);
        this.switchableByChat.set(chatId, [{ id: sessionId, retiredAt: Date.now() }, ...rest].slice(0, SWITCHABLE_CAP));
        void this.saveSwitchable();
    }
    /** A session's logs were deleted: drop it from every chat's switch-back
     * list (it stays retired, so its id is never created again). */
    forgetSession(sessionId) {
        for (const chatId of [...this.switchableByChat.keys()]) {
            if (this.isSwitchable(chatId, sessionId))
                this.removeSwitchable(chatId, sessionId);
        }
    }
    removeSwitchable(chatId, sessionId) {
        const list = this.switchableByChat.get(chatId);
        if (list === undefined)
            return;
        const next = list.filter(entry => entry.id !== sessionId);
        if (next.length === 0)
            this.switchableByChat.delete(chatId);
        else
            this.switchableByChat.set(chatId, next);
        void this.saveSwitchable();
    }
}
