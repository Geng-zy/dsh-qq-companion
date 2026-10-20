import type { BridgeConfig } from './bridge.js';
import type { ChatId } from './chat.js';
import type { TraceStage } from './trace.js';
/** One OneBot message segment for outbound sends. */
export interface OutboundSegment {
    type: string;
    data: Record<string, unknown>;
}
/** Options for an explicit outbound send (from tools). */
export interface SendOptions {
    replyTo?: string;
    /** Queue the send for resend on reconnect instead of failing while the
     * connection is down. Only for model final replies; interim sends carry
     * recall timers + bookkeeping and must never be replayed. */
    queuable?: boolean;
    /** this is a model final reply, so it may be split "one
     * line, one message" with typing pauses (config.splitLines). Command
     * output, notices and interim sends never set it. */
    humanize?: boolean;
}
/** Narrow view of a live chat the outbound pipeline may touch — the
 * structural subset of the bridge's ChatAgent the pipeline reads: the
 * nickname used as the t2i card title. Re-evaluated for the per-chat
 * send chain now lives in the pipeline itself (sendChains), so the chat view
 * no longer carries the queue field. */
export interface OutboundChat {
    lastNickname: string;
}
/** The bridge capabilities the outbound pipeline touches. Deliberately
 * narrower than BridgeDeps: the connection call gate, the live chat lookup
 * for the per-chat send chain, the stop flag guarding the drain, and the
 * config subset the pipeline reads — never the agent registry, media store,
 * or policy. */
export interface OutboundContext {
    /** Live chat lookup (card-title nickname). */
    getChat(chatId: ChatId): OutboundChat | undefined;
    /** Whether the OneBot connection currently accepts sends. */
    connected(): boolean;
    /** The connection's own QQ id (forward-node uin). */
    selfId(): string;
    /** Raw OneBot action invocation (send_msg / send_*_forward_msg). */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    /** Bridge stop flag: the drain must never run while stopping. */
    isStopping(): boolean;
    /** Called after each message went out (send counting for /doctor). */
    onSent?: (chatId: ChatId) => void;
    /** The account-wide typing pacer (absent = one built from the config). */
    typingPacer?: {
        wait(text: string): Promise<void>;
    };
    /** Bridge log line callback. */
    log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void;
    /** emit one outbound/queue decision event for a chat. The bridge owns
     * the traceId resolution (chat-level association table; unmapped proactive
     * writes mint a fresh id) — absent = tracing off, zero cost. */
    trace?: (chatId: ChatId, event: {
        stage: TraceStage;
        ok?: boolean;
        reason?: string;
        data?: Record<string, unknown>;
    }) => void;
    /** The only config fields the outbound pipeline reads. */
    config: Pick<BridgeConfig, 'botQQ' | 'sensitivePatterns' | 'textImageThreshold' | 'maxImageBytes' | 'cardFooter' | 'fontFiles' | 'fontFamilies'> & Partial<{
        /** Audit file directory (mediaDir/qq-actions.log); absent → no audit. */
        mediaDir: string;
        /** tool-send audit switch (default on). */
        actionAuditEnabled: boolean;
        /** split final replies "one line, one message". */
        splitLines: boolean;
        /** false = never split in group chats (one message per reply). */
        groupSplitLines: boolean;
        /** most messages one split reply may become. */
        splitMaxMessages: number;
        /** true = every message waits its typing time; false = only the
         * follow-up lines of a split reply do. */
        humanTypingPace: boolean;
        /** typing time per character / floor / ceiling (ms). */
        typingDelayPerCharMs: number;
        typingDelayMinMs: number;
        typingDelayMaxMs: number;
    }>;
}
/** Offline queue file, under mediaDir. */
export declare const PENDING_SENDS_FILE = "pending-sends.json";
/** tool-send audit file name, appended under mediaDir (jsonl). */
export declare const ACTION_AUDIT_FILE = "qq-actions.log";
/**
 * The outbound pipeline. Owns the pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export declare class OutboundPipeline {
    private readonly ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    private readonly now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect. */
    private readonly pendingSends;
    /** typing-pause sleep (tests inject a recorder). */
    private readonly sleep;
    /** Typing pace for outgoing messages (see TypingPacer). */
    private readonly pacer;
    /** humanTypingPace: pace every message, not just split follow-up lines. */
    private readonly paceEveryMessage;
    /** Durable copy of pendingSends (mediaDir/pending-sends.json), so replies
     * queued while QQ was disconnected survive a dsh restart. Absent = memory
     * only (tests, no mediaDir). */
    private readonly pendingWriter;
    constructor(ctx: OutboundContext, options?: {
        now?: () => number;
        sleep?: (ms: number) => Promise<void>;
    });
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId: ChatId, text: string, options?: SendOptions): Promise<string[]>;
    /** Park one queuable send for a chat while disconnected:
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    private queuePendingSend;
    /** Persist the offline queue (no-op without a mediaDir). */
    private savePending;
    /** Restore replies queued before a restart (expired ones are dropped at
     * drain time by the usual TTL). Missing or corrupt file = nothing queued. */
    loadPending(): Promise<void>;
    /** Serialized audit-append chain (order discipline, see auditWrite). */
    private auditChain;
    /** append one tool-send (or send failure) audit
     * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
     * Fire-and-forget: a write failure only warns and never affects the send
     * path. Writes are chained so lines land in call order even when the fs
     * thread pool completes them out of schedule. No-op when auditing is
     * disabled or no mediaDir is configured. */
    private auditWrite;
    /** Resend parked final replies oldest-first after a reconnect.
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends(): void;
    /**
     * Send raw OneBot segments (used by the media tools); audited.
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId: ChatId, segments: OutboundSegment[]): Promise<string | undefined>;
    /** per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    private readonly sendChains;
    /** Serialize work on one chat's send chain. */
    private enqueue;
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId: ChatId): Promise<unknown>;
    /** Send one message to a chat and return its message id. */
    sendMsg(chatId: ChatId, segments: OutboundSegment[], options: SendOptions): Promise<string | undefined>;
    /** Send [[qq_forward]] nodes as a merged-forward message (the
     * qq_send_forward tool); audited. [[qq_forward]] blocks inside a reply go
     * through sendForwardNodes directly. */
    sendForward(chatId: ChatId, nodes: Array<{
        name: string;
        content: string;
    }>): Promise<void>;
    /** Merged-forward send (shared by the tool path and the [[qq_forward]]
     * blocks inside sendToChat). */
    private sendForwardNodes;
}
