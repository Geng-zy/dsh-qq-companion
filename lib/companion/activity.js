/**
 * Per-chat activity record: last user activity (idle clock), session start
 * (age-based renewal), the last few lines (the handoff recap fed into a
 * fresh session) and today's transcript excerpt (the nightly diary input).
 * Persisted in mediaDir/chat-activity.json so restarts keep the clocks.
 * @module dsh-qq-companion/companion/activity
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describeError } from '../errors.js';
import { SerialFileWriter } from '../persist.js';
import { boundaryDay } from './time.js';
/** Activity file name, under mediaDir. */
export const CHAT_ACTIVITY_FILE = 'chat-activity.json';
/** Lines kept for the idle-reset handoff recap. */
export const HANDOFF_LINES = 8;
/** Characters kept per handoff / today line. */
export const LINE_MAX_CHARS = 200;
/** Lines kept in today's excerpt per chat (the diary input). */
export const TODAY_MAX_LINES = 200;
const clip = (text) => {
    const chars = Array.from(text.replace(/\s+/g, ' ').trim());
    return chars.length > LINE_MAX_CHARS ? chars.slice(0, LINE_MAX_CHARS).join('') + '…' : chars.join('');
};
export class ChatActivity {
    file;
    log;
    now;
    chats = {};
    saveTimer;
    saveChain = Promise.resolve();
    writer;
    constructor(options) {
        this.file = join(options.mediaDir, CHAT_ACTIVITY_FILE);
        this.log = options.log;
        this.writer = new SerialFileWriter(this.file, { label: '聊天活动记录', log: (level, message) => this.log(level, message) });
        this.now = options.now ?? (() => Date.now());
    }
    async load() {
        try {
            const raw = JSON.parse(await readFile(this.file, 'utf8'));
            for (const [chatId, rec] of Object.entries(raw)) {
                if (typeof rec?.lastAt !== 'number')
                    continue;
                this.chats[chatId] = {
                    lastAt: rec.lastAt,
                    // Records from before age-based resets start counting now.
                    sessionStartedAt: typeof rec.sessionStartedAt === 'number' ? rec.sessionStartedAt : this.now(),
                    recent: Array.isArray(rec.recent) ? rec.recent.slice(-HANDOFF_LINES) : [],
                    today: Array.isArray(rec.today) ? rec.today.slice(-TODAY_MAX_LINES) : [],
                };
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                this.log('warn', '聊天活动记录读取失败，从空开始: ' + describeError(error));
        }
    }
    /** Last user activity time for a chat (undefined = never seen). */
    lastAt(chatId) {
        return this.chats[chatId]?.lastAt;
    }
    /** Whether the chat has been idle longer than `hours` (never-seen = no). */
    isIdle(chatId, hours) {
        const last = this.lastAt(chatId);
        return hours > 0 && last !== undefined && this.now() - last > hours * 3_600_000;
    }
    /** Record one line. User lines also move the idle clock. */
    record(chatId, who, text, name = '') {
        const body = clip(text);
        if (body === '')
            return;
        const rec = this.chats[chatId] ?? (this.chats[chatId] = { lastAt: this.now(), sessionStartedAt: this.now(), recent: [], today: [] });
        const line = { t: this.now(), who, text: body, ...(name !== '' ? { name } : {}) };
        rec.recent.push(line);
        if (rec.recent.length > HANDOFF_LINES)
            rec.recent.splice(0, rec.recent.length - HANDOFF_LINES);
        rec.today.push(line);
        if (rec.today.length > TODAY_MAX_LINES)
            rec.today.splice(0, rec.today.length - TODAY_MAX_LINES);
        if (who === 'user')
            rec.lastAt = this.now();
        this.scheduleSave();
    }
    /** Mark that the chat's session starts now (/new, idle or age reset). */
    markSessionStart(chatId) {
        const rec = this.chats[chatId];
        if (rec === undefined)
            return;
        rec.sessionStartedAt = this.now();
        this.scheduleSave();
    }
    /** How many 04:00 day boundaries the current session has crossed
     * (0 = started today; never-seen chats = 0). */
    sessionDaysCrossed(chatId) {
        const started = this.chats[chatId]?.sessionStartedAt;
        if (started === undefined)
            return 0;
        return boundaryDay(this.now()) - boundaryDay(started);
    }
    /** How many of her replies came after the chat's last user line (an
     * unanswered proactive message makes this ≥ 2). */
    botLinesSinceUser(chatId) {
        const lines = this.chats[chatId]?.today ?? [];
        let count = 0;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].who === 'user')
                break;
            count += 1;
        }
        return count;
    }
    /** The handoff recap text for a fresh session ('' = nothing to hand off). */
    handoff(chatId) {
        const lines = this.chats[chatId]?.recent ?? [];
        if (lines.length === 0)
            return '';
        return lines.map(l => (l.who === 'bot' ? '你' : (l.name ?? '对方')) + '：' + l.text).join('\n');
    }
    /** Today's excerpt for a chat (diary input), then optionally cleared. */
    takeToday(chatId, clear) {
        const rec = this.chats[chatId];
        if (rec === undefined)
            return [];
        const lines = [...rec.today];
        if (clear) {
            rec.today = [];
            this.scheduleSave();
        }
        return lines;
    }
    /** Flush pending writes (stop / tests). */
    async flush() {
        if (this.saveTimer !== undefined) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
            this.writeNow();
        }
        await this.saveChain;
    }
    scheduleSave() {
        if (this.saveTimer !== undefined)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.writeNow();
        }, 2_000);
        this.saveTimer.unref?.();
    }
    writeNow() {
        this.saveChain = this.writer.write(() => JSON.stringify(this.chats));
    }
}
/** Format today's excerpt for the diary prompt. */
export function formatTranscript(lines) {
    return lines.map(l => {
        const d = new Date(l.t);
        const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        return '[' + hm + '] ' + (l.who === 'bot' ? '你' : (l.name ?? '对方')) + '：' + l.text;
    }).join('\n');
}
