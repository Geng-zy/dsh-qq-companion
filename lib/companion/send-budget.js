const HOUR = 3_600_000;
export class SendBudget {
    config;
    isExempt;
    log;
    now;
    sleep;
    /** Send times within the last hour (minute/hour windows). */
    recent = [];
    day = '';
    todayCount = 0;
    droppedCount = 0;
    lastSendAt = 0;
    chain = Promise.resolve();
    warnedFor = '';
    constructor(options) {
        this.config = options.config;
        this.isExempt = options.isExempt;
        this.log = options.log;
        this.now = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    }
    /** Whether any limit is on. */
    get enabled() {
        const c = this.config;
        return c.minIntervalMs > 0 || c.perMinute > 0 || c.perHour > 0 || c.perDay > 0;
    }
    /**
     * Take one send unit for `chatId`, waiting for the gap / minute window.
     * @returns false when the hour/day budget is spent (the caller drops the send).
     */
    acquire(chatId) {
        const run = this.chain.then(() => this.take(chatId));
        this.chain = run.catch(() => undefined);
        return run;
    }
    async take(chatId) {
        const c = this.config;
        this.rollDay();
        const exempt = this.isExempt(chatId);
        this.prune();
        if (!exempt) {
            const overDay = c.perDay > 0 && this.todayCount >= c.perDay;
            const overHour = c.perHour > 0 && this.recent.length >= c.perHour;
            if (overDay || overHour) {
                this.droppedCount += 1;
                const key = (overDay ? 'day:' + this.day : 'hour:' + Math.floor(this.now() / HOUR)) + '|' + chatId;
                if (this.warnedFor !== key) {
                    this.warnedFor = key;
                    this.log('warn', '发送额度用完（' + (overDay ? '今天已发 ' + this.todayCount + '/' + c.perDay : '近一小时已发 ' + this.recent.length + '/' + c.perHour) + '），暂停给 ' + chatId + ' 发消息，防止触发 QQ 风控');
                }
                return false;
            }
        }
        if (c.perMinute > 0) {
            const inMinute = this.recent.filter(t => this.now() - t < 60_000);
            if (inMinute.length >= c.perMinute) {
                const wait = inMinute[inMinute.length - c.perMinute] + 60_000 - this.now();
                if (wait > 0)
                    await this.sleep(wait);
            }
        }
        if (c.minIntervalMs > 0) {
            const wait = this.lastSendAt + c.minIntervalMs - this.now();
            if (wait > 0)
                await this.sleep(wait);
        }
        const at = this.now();
        this.rollDay();
        this.lastSendAt = at;
        this.recent.push(at);
        this.todayCount += 1;
        return true;
    }
    snapshot() {
        this.rollDay();
        this.prune();
        const now = this.now();
        return {
            lastMinute: this.recent.filter(t => now - t < 60_000).length,
            lastHour: this.recent.length,
            today: this.todayCount,
            dropped: this.droppedCount,
            limits: { ...this.config },
        };
    }
    prune() {
        const now = this.now();
        this.recent = this.recent.filter(t => now - t < HOUR);
    }
    rollDay() {
        const d = new Date(this.now());
        const key = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
        if (key !== this.day) {
            this.day = key;
            this.todayCount = 0;
            this.droppedCount = 0;
        }
    }
}
/**
 * Per-group reply cooldown: at most `maxTurns` member-started turns per
 * group within `windowMinutes`; the admin is never limited. 0 disables.
 */
export class GroupCooldown {
    maxTurns;
    windowMs;
    log;
    now;
    turns = new Map();
    noted = new Map();
    constructor(options) {
        this.maxTurns = options.maxTurns;
        this.windowMs = Math.max(1, options.windowMinutes) * 60_000;
        this.log = options.log;
        this.now = options.now ?? (() => Date.now());
    }
    /** Whether this member turn may run now (and count it if so). */
    allow(chatId, byAdmin) {
        if (byAdmin || this.maxTurns <= 0 || !chatId.startsWith('group:'))
            return true;
        const now = this.now();
        const list = (this.turns.get(chatId) ?? []).filter(t => now - t < this.windowMs);
        if (list.length >= this.maxTurns) {
            this.turns.set(chatId, list);
            const resumeAt = list[0] + this.windowMs;
            if (this.noted.get(chatId) !== resumeAt) {
                this.noted.set(chatId, resumeAt);
                this.log('info', chatId + ' 冷却中：' + Math.round(this.windowMs / 60_000) + ' 分钟内已回 ' + list.length + ' 轮，' + Math.ceil((resumeAt - now) / 1000) + ' 秒后再回群友');
            }
            return false;
        }
        list.push(now);
        this.turns.set(chatId, list);
        return true;
    }
}
