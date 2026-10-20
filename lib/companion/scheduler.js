/**
 * Daily scheduled prompts: each fires once per local day at or after HH:MM.
 * @module dsh-qq-companion/companion/scheduler
 */
import { describeError } from '../errors.js';
import { dayKey } from './time.js';
/** Fires each prompt once per local day, at or after its HH:MM. */
export class DailyScheduler {
    prompts;
    fire;
    log;
    now;
    fired = new Map();
    timer;
    constructor(options) {
        this.prompts = options.prompts.filter(p => /^\d{2}:\d{2}$/.test(p.time) && p.chatId !== '' && p.prompt !== '');
        this.fire = options.fire;
        this.log = options.log;
        this.now = options.now ?? (() => Date.now());
        // A prompt whose time already passed today does not fire on boot.
        const today = dayKey(this.now());
        for (const p of this.prompts) {
            if (this.minutesNow() >= this.minutesOf(p.time))
                this.fired.set(p.id, today);
        }
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
