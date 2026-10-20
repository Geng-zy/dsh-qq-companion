/**
 * Outbound delivery pipeline: the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / plain
 * text), raw OneBot segment sends, merged forwards, and the offline
 * resend queue (per-chat FIFO, cap 20, TTL 5 min, drained on reconnect).
 * Sends the model starts through the qq_* tools are written to the audit
 * log (mediaDir/qq-actions.log).
 * @module dsh-qq-companion/outbound
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { splitChatId } from './chat.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { DEFAULT_SPLIT_MAX_MESSAGES, extractForwardBlocks, scanSensitive, splitHumanMessages, stripMarkdown } from './split.js';
import { DEFAULT_TYPING_DELAY_MAX_MS, DEFAULT_TYPING_DELAY_MIN_MS, DEFAULT_TYPING_DELAY_PER_CHAR_MS, TypingPacer } from './companion/typing-pace.js';
import { renderTextImage } from './t2i/index.js';
import { describeError } from './errors.js';
import { SerialFileWriter } from './persist.js';
import { TRACE_REASONS } from './trace.js';
/** Queued final replies older than this are dropped at drain time. */
const PENDING_SEND_TTL_MS = 5 * 60_000;
/** Offline queue file, under mediaDir. */
export const PENDING_SENDS_FILE = 'pending-sends.json';
/** Max queued final replies per chat; the oldest is dropped beyond this. */
const PENDING_SEND_MAX = 20;
/** tool-send audit file name, appended under mediaDir (jsonl). */
export const ACTION_AUDIT_FILE = 'qq-actions.log';
/**
 * The outbound pipeline. Owns the pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
    ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect. */
    pendingSends = new Map();
    /** typing-pause sleep (tests inject a recorder). */
    sleep;
    /** Typing pace for outgoing messages (see TypingPacer). */
    pacer;
    /** humanTypingPace: pace every message, not just split follow-up lines. */
    paceEveryMessage;
    /** Durable copy of pendingSends (mediaDir/pending-sends.json), so replies
     * queued while QQ was disconnected survive a dsh restart. Absent = memory
     * only (tests, no mediaDir). */
    pendingWriter;
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        const dir = ctx.config.mediaDir;
        this.pendingWriter = dir !== undefined && dir !== ''
            ? new SerialFileWriter(join(dir, PENDING_SENDS_FILE), { label: '离线待发回复', log: (level, message) => ctx.log(level, message) })
            : undefined;
        // Lazy default: read Date.now through a wrapper so an injected clock is
        // optional and callers without one keep the dynamic global lookup (fake
        // timers in tests must keep influencing the wall-clock path).
        this.now = options.now ?? (() => Date.now());
        this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const c = ctx.config;
        this.pacer = ctx.typingPacer ?? new TypingPacer({
            config: {
                perCharMs: c.typingDelayPerCharMs ?? DEFAULT_TYPING_DELAY_PER_CHAR_MS,
                minMs: c.typingDelayMinMs ?? DEFAULT_TYPING_DELAY_MIN_MS,
                maxMs: c.typingDelayMaxMs ?? DEFAULT_TYPING_DELAY_MAX_MS,
            },
            now: this.now,
            sleep: this.sleep,
        });
        this.paceEveryMessage = c.humanTypingPace === true;
    }
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId, text, options = {}) {
        return this.enqueue(chatId, async () => {
            if (!this.ctx.connected()) {
                if (options.queuable === true) {
                    // the park used to be silent.
                    this.ctx.log('debug', '连接断开，回复已排队等待重连补发: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued });
                    this.queuePendingSend(chatId, text, options.humanize === true);
                    return [];
                }
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundNotConnected });
                throw new OneBotNotConnectedError();
            }
            const hits = scanSensitive(text, this.ctx.config.sensitivePatterns);
            if (hits.length > 0) {
                this.ctx.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSensitive, data: { hits: hits.slice(0, 5) } });
            }
            const ids = [];
            const { body, nodes } = extractForwardBlocks(text, '助手');
            if (nodes.length > 0) {
                await this.sendForwardNodes(chatId, nodes);
                ids.push('forward');
            }
            let sentCard = false;
            const threshold = this.ctx.config.textImageThreshold;
            if (threshold > 0 && body.length > threshold) {
                try {
                    const chat = this.ctx.getChat(chatId);
                    const title = chat !== undefined && chat.lastNickname !== ''
                        ? 'To ' + chat.lastNickname
                        : undefined;
                    const png = renderTextImage(body, {
                        title,
                        footerBrand: this.ctx.config.cardFooter,
                        fontFiles: this.ctx.config.fontFiles,
                        fontFamilies: this.ctx.config.fontFamilies,
                    });
                    const b64 = 'base64://' + png.toString('base64');
                    if (b64.length <= this.ctx.config.maxImageBytes) {
                        const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options);
                        if (id !== undefined)
                            ids.push(id);
                        sentCard = true;
                    }
                    else {
                        this.ctx.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text');
                        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundCardTooLarge });
                    }
                }
                catch (error) {
                    this.ctx.log('warn', 't2i render failed, falling back to text: ' + describeError(error));
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '文字图卡片渲染失败，已降级为文本: ' + describeError(error) });
                }
            }
            if (!sentCard) {
                const plain = stripMarkdown(body);
                const splitHere = this.ctx.config.splitLines === true && !(chatId.startsWith('group:') && this.ctx.config.groupSplitLines === false);
                const parts = options.humanize === true && splitHere
                    ? splitHumanMessages(plain, this.ctx.config.splitMaxMessages ?? DEFAULT_SPLIT_MAX_MESSAGES)
                    : null;
                if (parts !== null) {
                    // one line, one message, with a typing pause before
                    // each follow-up line; only the first line carries the reply quote.
                    for (let i = 0; i < parts.length; i++) {
                        if (i > 0 && !this.paceEveryMessage)
                            await this.pacer.wait(parts[i]);
                        const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: parts[i] } }], i === 0 ? options : {});
                        if (id !== undefined)
                            ids.push(id);
                    }
                }
                else if (plain !== '') {
                    const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: plain } }], options);
                    if (id !== undefined)
                        ids.push(id);
                }
                else {
                    // the empty-body skip used to be silent.
                    this.ctx.log('debug', '正文为空，未发送: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText });
                }
            }
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '回复已发送', data: { segments: ids.length } });
            return ids;
        });
    }
    /** Park one queuable send for a chat while disconnected:
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    queuePendingSend(chatId, text, humanize) {
        const queue = this.pendingSends.get(chatId) ?? [];
        if (queue.length >= PENDING_SEND_MAX) {
            queue.shift();
            this.ctx.log('warn', 'pending send queue full for ' + chatId + ', dropped oldest');
            this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull });
        }
        queue.push({ text, sentAt: this.now(), humanize });
        this.pendingSends.set(chatId, queue);
        this.savePending();
    }
    /** Persist the offline queue (no-op without a mediaDir). */
    savePending() {
        void this.pendingWriter?.write(() => JSON.stringify(Object.fromEntries(this.pendingSends)));
    }
    /** Restore replies queued before a restart (expired ones are dropped at
     * drain time by the usual TTL). Missing or corrupt file = nothing queued. */
    async loadPending() {
        const dir = this.ctx.config.mediaDir;
        if (dir === undefined || dir === '')
            return;
        try {
            const raw = JSON.parse(await readFile(join(dir, PENDING_SENDS_FILE), 'utf8'));
            let restored = 0;
            for (const [chatId, items] of Object.entries(raw)) {
                if (!Array.isArray(items))
                    continue;
                const queue = items
                    .filter(i => typeof i?.text === 'string' && typeof i?.sentAt === 'number')
                    .map(i => ({ text: i.text, sentAt: i.sentAt, humanize: i.humanize === true }))
                    .slice(-PENDING_SEND_MAX);
                if (queue.length === 0)
                    continue;
                this.pendingSends.set(chatId, [...(this.pendingSends.get(chatId) ?? []), ...queue]);
                restored += queue.length;
            }
            if (restored > 0)
                this.ctx.log('info', '恢复了 ' + restored + ' 条重启前没发出去的回复，连上后补发');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                this.ctx.log('warn', '离线待发回复读取失败，忽略: ' + describeError(error));
        }
    }
    /** Serialized audit-append chain (order discipline, see auditWrite). */
    auditChain = Promise.resolve();
    /** append one tool-send (or send failure) audit
     * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
     * Fire-and-forget: a write failure only warns and never affects the send
     * path. Writes are chained so lines land in call order even when the fs
     * thread pool completes them out of schedule. No-op when auditing is
     * disabled or no mediaDir is configured. */
    auditWrite(chatId, action, ok, reason) {
        if (this.ctx.config.actionAuditEnabled === false)
            return;
        const dir = this.ctx.config.mediaDir;
        if (dir === undefined || dir === '')
            return;
        const line = JSON.stringify({ ts: this.now(), chatId, action, ok, reason }) + '\n';
        this.auditChain = this.auditChain.then(async () => {
            await mkdir(dir, { recursive: true });
            await appendFile(join(dir, ACTION_AUDIT_FILE), line, 'utf8');
        }).catch(error => {
            this.ctx.log('warn', '写操作审计写入失败: ' + describeError(error));
        });
    }
    /** Resend parked final replies oldest-first after a reconnect.
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends() {
        if (this.ctx.isStopping())
            return;
        const now = this.now();
        const batch = [];
        const hadPending = this.pendingSends.size > 0;
        for (const [chatId, queue] of this.pendingSends) {
            this.pendingSends.delete(chatId);
            for (const item of queue) {
                if (now - item.sentAt < PENDING_SEND_TTL_MS) {
                    batch.push({ chatId, text: item.text, humanize: item.humanize });
                }
                else {
                    // the TTL drop used to be silent.
                    this.ctx.log('debug', '排队回复超过 5 分钟未送达，已丢弃: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired });
                }
            }
        }
        if (hadPending)
            this.savePending();
        for (const { chatId, text, humanize } of batch) {
            void this.sendToChat(chatId, text, { queuable: true, humanize }).catch((error) => {
                this.ctx.log('warn', 'queued resend failed: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + describeError(error) });
            });
        }
    }
    /**
     * Send raw OneBot segments (used by the media tools); audited.
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        return this.enqueue(chatId, async () => {
            try {
                const id = await this.sendMsg(chatId, segments, {});
                this.auditWrite(chatId, 'send_msg', true, '发送成功');
                return id;
            }
            catch (error) {
                this.auditWrite(chatId, 'send_msg', false, '发送失败: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '工具发送失败: ' + describeError(error) });
                throw error;
            }
        });
    }
    /** per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    sendChains = new Map();
    /** Serialize work on one chat's send chain. */
    enqueue(chatId, work) {
        const chain = this.sendChains.get(chatId) ?? Promise.resolve();
        const run = chain.then(work, work);
        const tail = run.catch(() => undefined);
        this.sendChains.set(chatId, tail);
        void tail.then(() => {
            if (this.sendChains.get(chatId) === tail)
                this.sendChains.delete(chatId);
        });
        return run;
    }
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId) {
        return this.sendChains.get(chatId) ?? Promise.resolve();
    }
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        const ref = splitChatId(chatId);
        const params = {};
        const target = Number(ref.target);
        if (!Number.isFinite(target))
            throw new OneBotActionError('invalid chat target: ' + chatId);
        if (ref.kind === 'group')
            params.group_id = target;
        else
            params.user_id = target;
        params.message = segments;
        if (options.replyTo !== undefined) {
            params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments];
        }
        if (this.paceEveryMessage) {
            await this.pacer.wait(segments.map(s => (s.type === 'text' ? String(s.data.text ?? '') : '')).join(''));
        }
        const data = await this.ctx.call('send_msg', params);
        this.ctx.onSent?.(chatId);
        return data.message_id !== undefined ? String(data.message_id) : undefined;
    }
    /** Send [[qq_forward]] nodes as a merged-forward message (the
     * qq_send_forward tool); audited. [[qq_forward]] blocks inside a reply go
     * through sendForwardNodes directly. */
    async sendForward(chatId, nodes) {
        try {
            await this.sendForwardNodes(chatId, nodes);
            this.auditWrite(chatId, 'send_forward_msg', true, '发送成功');
        }
        catch (error) {
            this.auditWrite(chatId, 'send_forward_msg', false, '发送失败: ' + describeError(error));
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '工具发送失败: ' + describeError(error) });
            throw error;
        }
    }
    /** Merged-forward send (shared by the tool path and the [[qq_forward]]
     * blocks inside sendToChat). */
    async sendForwardNodes(chatId, nodes) {
        const ref = splitChatId(chatId);
        const target = Number(ref.target);
        if (!Number.isFinite(target))
            throw new OneBotActionError('invalid chat target: ' + chatId);
        if (this.paceEveryMessage)
            await this.pacer.wait(nodes.map(n => n.content).join(''));
        const messages = nodes.map(node => ({
            type: 'node',
            data: {
                uin: this.ctx.selfId() || this.ctx.config.botQQ,
                name: node.name.slice(0, 24),
                content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
            },
        }));
        if (ref.kind === 'group') {
            await this.ctx.call('send_forward_msg', { group_id: target, messages });
        }
        else {
            await this.ctx.call('send_private_forward_msg', { user_id: target, messages });
        }
        this.ctx.onSent?.(chatId);
    }
}
