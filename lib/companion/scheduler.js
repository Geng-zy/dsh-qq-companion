/**
 * Daily scheduled prompts: each fires once per local day at or after HH:MM.
 * @module dsh-qq-companion/companion/scheduler
 */
import { describeError } from '../errors.js';
import { JsonState } from './state.js';
import { dayKey } from './time.js';
/** A prompt that was due while dsh was down fires late if it is at most
 * this many minutes overdue (a restart around 01:30 must not skip the diary). */
export const CATCH_UP_MINUTES = 180;
/**
 * Fires each prompt once per local day, at or after its HH:MM. With a state
 * file, "fired today" survives restarts and a prompt missed while dsh was
 * down fires late (within CATCH_UP_MINUTES); without one (or on the very
 * first boot) a time already past today is skipped.
 */
export class DailyScheduler {
    prompts;
    fire;
    log;
    now;
    fired = new Map();
    timer;
    state;
    constructor(options) {
        this.prompts = options.prompts.filter(p => /^\d{2}:\d{2}$/.test(p.time) && p.chatId !== '' && p.prompt !== '');
        this.fire = options.fire;
        this.log = options.log;
        this.now = options.now ?? (() => Date.now());
        this.state = new JsonState(options.stateFile, { label: '定时任务状态', log: options.log });
        this.markPassed(() => true);
    }
    /** Restore "fired today" from the state file; a prompt that was due while
     * dsh was down (and not too long ago) becomes due again. */
    async load() {
        const stored = await this.state.load();
        if (!this.state.existed)
            return;
        const today = dayKey(this.now());
        this.fired.clear();
        for (const [id, day] of Object.entries(stored?.fired ?? {}))
            if (typeof day === 'string')
                this.fired.set(id, day);
        // Overdue beyond the catch-up window: skip for today.
        this.markPassed(p => this.minutesNow() - this.minutesOf(p.time) > CATCH_UP_MINUTES);
        for (const p of this.prompts) {
            if (this.fired.get(p.id) !== today && this.minutesNow() >= this.minutesOf(p.time)) {
                this.log('info', '定时任务 ' + p.id + ' 在 dsh 停机期间到点（' + p.time + '），补执行');
            }
        }
    }
    /** Mark prompts already past today as fired when `skip` says so. */
    markPassed(skip) {
        const today = dayKey(this.now());
        for (const p of this.prompts) {
            if (this.fired.get(p.id) === today)
                continue;
            if (this.minutesNow() >= this.minutesOf(p.time) && skip(p))
                this.fired.set(p.id, today);
        }
    }
    /** Today's state of every prompt (for /doctor). */
    snapshot() {
        const today = dayKey(this.now());
        return this.prompts.map(p => ({ id: p.id, time: p.time, firedToday: this.fired.get(p.id) === today }));
    }
    start(intervalMs = 30_000) {
        if (this.timer !== undefined || this.prompts.length === 0)
            return;
        this.timer = setInterval(() => { void this.tick(); }, intervalMs);
        this.timer.unref?.();
    }
    stop() {
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
    }
    /** One check (exported for tests). */
    async tick() {
        const today = dayKey(this.now());
        for (const p of this.prompts) {
            if (this.fired.get(p.id) === today)
                continue;
            if (this.minutesNow() < this.minutesOf(p.time))
                continue;
            this.fired.set(p.id, today);
            await this.state.save(() => ({ fired: Object.fromEntries(this.fired) }));
            try {
                await this.fire(p);
                this.log('info', '定时任务已触发: ' + p.id);
            }
            catch (error) {
                this.log('warn', '定时任务 ' + p.id + ' 失败: ' + describeError(error));
            }
        }
    }
    minutesNow() {
        const d = new Date(this.now());
        return d.getHours() * 60 + d.getMinutes();
    }
    minutesOf(time) {
        const [h, m] = time.split(':').map(Number);
        return h * 60 + m;
    }
}
