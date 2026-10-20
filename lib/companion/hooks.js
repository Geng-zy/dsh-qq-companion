import { formatTranscript } from './activity.js';
import { appendMemoryNote, ensureGroupMemory, groupMemoryPaths } from './memory.js';
import { PROACTIVE_PASS, isProactivePass } from './proactive.js';
export class CompanionHooks {
    config;
    activity;
    log;
    resetChat;
    now;
    constructor(options) {
        this.config = options.config;
        this.activity = options.activity;
        this.log = options.log;
        this.resetChat = options.resetChat;
        this.now = options.now ?? (() => Date.now());
    }
    get owner() {
        return this.config.ownerTitle ?? '管理员';
    }
    /**
     * Before a user turn: renew the session when idle too long or past its
     * day budget (prefixing the handoff recap), then record the user line.
     * Scheduled turns (diary, check-ins) never renew and are not recorded.
     * @returns the turn text (possibly prefixed).
     */
    async beforeUserTurn(chatId, text, plain, nickname, scheduled) {
        const activity = this.activity;
        if (activity === undefined || scheduled)
            return text;
        const hours = this.config.idleResetHours ?? 0;
        const days = chatId.startsWith('group:') ? (this.config.groupResetDays ?? 0) : (this.config.privateResetDays ?? 0);
        const idle = hours > 0 && activity.isIdle(chatId, hours);
        const aged = !idle && days > 0 && activity.sessionDaysCrossed(chatId) >= days;
        let out = text;
        if (idle || aged) {
            const recap = activity.handoff(chatId);
            await this.resetChat(chatId);
            activity.markSessionStart(chatId);
            this.log('info', (idle ? 'idle reset' : 'periodic reset') + ' for ' + chatId);
            if (recap !== '') {
                const why = idle
                    ? '距离上次聊天已经过了 ' + hours + ' 个多小时'
                    : '每隔 ' + days + ' 天会换一次新会话，之前的事在记忆和日记里';
                out = '（这是一个新会话：' + why + '。上次最后几句是：\n' + recap + '\n）\n' + out;
            }
        }
        activity.record(chatId, 'user', plain, nickname);
        return out;
    }
    /**
     * Before a final (humanized) reply is sent.
     * @returns false when nothing should be sent (the pass marker).
     */
    beforeFinalReply(chatId, text) {
        if (isProactivePass(text)) {
            this.log('info', '她这次选择不主动发消息: ' + chatId);
            return false;
        }
        this.activity?.record(chatId, 'bot', text);
        return true;
    }
    /** The wake-up text of one proactive check-in. */
    checkinText(context) {
        const owner = this.owner;
        const since = context.lastUserAt === undefined
            ? owner + '还没跟你说过话'
            : owner + '上一次跟你说话是 ' + Math.round((this.now() - context.lastUserAt) / 60_000) + ' 分钟前';
        return [
            '[主动聊天的机会 ' + context.time + '｜这条不是' + owner + '发的，是系统叫醒你]',
            since + (context.unanswered > 0 ? '；你主动发的 ' + context.unanswered + ' 条消息' + owner + '还没回' : '') + '。',
            '按你的人设决定要不要主动找' + owner + '：想找就直接写你要发的话（像平时一样一句一条）；',
            '这次不想打扰，或者没什么具体想说的，就只回复 ' + PROACTIVE_PASS + '，什么都不会发出去。',
        ].join('\n');
    }
    /** The text of one scheduled prompt, with today's transcript when asked
     * (taking it clears it). */
    scheduledText(prompt) {
        const owner = this.owner;
        let text = '[定时任务 ' + prompt.time + '｜这条不是' + owner + '发的，是系统按时叫你]\n' + prompt.prompt;
        if (prompt.includeTodayLog === true && this.activity !== undefined) {
            const lines = this.activity.takeToday(prompt.chatId, true);
            text += lines.length > 0
                ? '\n\n今天和' + owner + '的聊天（节选，最多 200 句，每句最多 200 字）：\n' + formatTranscript(lines)
                : '\n\n（今天和' + owner + '没有聊天）';
        }
        return text;
    }
    /** The qq_memory_note writer, or undefined when no memory file is set. */
    memoryNoteWriter() {
        const memoryFile = this.config.publicMemoryFile ?? '';
        const groupRoot = this.config.groupMemoryDir ?? '';
        if (memoryFile === '' && groupRoot === '')
            return undefined;
        return async (chatId, text) => {
            if (!chatId.startsWith('group:')) {
                return { ok: false, reason: '私聊里请直接改记忆文件，这个工具只给群聊用' };
            }
            // A group's notes go to that group's own file.
            if (groupRoot !== '') {
                const groupId = chatId.slice('group:'.length);
                await ensureGroupMemory(groupRoot, groupId);
                return appendMemoryNote(groupMemoryPaths(groupRoot, groupId).file, chatId, text, undefined, this.config.groupMemoryMaxBytes);
            }
            return appendMemoryNote(memoryFile, chatId, text, undefined, this.config.publicMemoryMaxBytes);
        };
    }
}
