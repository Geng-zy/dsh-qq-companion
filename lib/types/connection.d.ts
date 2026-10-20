/**
 * OneBot 11 WebSocket transport: a reverse server NapCat (ws-reverse) dials
 * into, token check, frame handling, echo correlation for action calls,
 * heartbeat, and the busy-port bind retry. NapCat does the reconnecting.
 * @module dsh-qq-companion/connection
 */
/** OneBot 11 event payload (loose: implementations vary). */
export interface OneBotEvent {
    post_type?: string;
    message_type?: string;
    notice_type?: string;
    request_type?: string;
    user_id?: number | string;
    group_id?: number | string;
    self_id?: number | string;
    message_id?: number | string;
    message?: unknown;
    raw_message?: string;
    sender?: {
        user_id?: number | string;
        nickname?: string;
        card?: string;
        role?: string;
    };
    [key: string]: unknown;
}
/** Action-call result from the OneBot endpoint. */
export interface ActionResult {
    status: string;
    retcode: number;
    data: unknown;
    wording?: string;
}
/** Transport configuration. */
export interface ConnectionConfig {
    host: string;
    port: number;
    accessToken: string;
    /** Per-action call timeout in ms. */
    callTimeoutMs: number;
    /**
     * injected log sink (level, message). Absent → a console fallback
     * keeps the transport independently usable; index.ts wires the same
     * deps.log the bridge uses.
     */
    log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
}
/** Error thrown for action calls that fail or time out. */
export declare class OneBotActionError extends Error {
    constructor(message: string);
}
/** Error thrown when the transport is not connected. */
export declare class OneBotNotConnectedError extends Error {
    constructor(message?: string);
}
/**
 * OneBot 11 transport. One instance handles exactly one peer: either a
 * reverse server accepting NapCat's dial-in.
 * All frames share the same correlation table.
 */
export declare class OneBotConnection {
    readonly config: ConnectionConfig;
    /** Inbound message event handler; the bridge/plugin wires this. */
    onMessage: (event: OneBotEvent) => void;
    /** Meta event handler (self_id learning). */
    onMeta: (event: OneBotEvent) => void;
    /** Connection-state callback. */
    onStatus: (connected: boolean) => void;
    /** notice/request events (group invites, friend requests,
     * join/leave notices). Unwired = ignored, the upstream v1 behavior. */
    onNoticeOrRequest: (event: OneBotEvent) => void;
    /**
     * fault-reference hook, called at the significant connection
     * failure points (bind failure, reverse
     * server error) — the bridge implements it by minting/recording/tracing a
     * `QQ-CONN-…` reference; the returned reference is appended to the log
     * line so host logs and the trace file share the same number. Absent =
     * the fault log lines carry no reference.
     */
    onFailure: ((stage: string, detail: string) => string | undefined) | undefined;
    private server;
    private socket;
    private lastPongAt;
    private heartbeatTimer;
    private pending;
    private stopping;
    private connectedFlag;
    /** Reverse churn guard: timestamps (ms) of recent healthy-socket replacements. */
    private reverseReplaces;
    /** pending EADDRINUSE bind retry timer (reverse mode). */
    private reverseRetryTimer;
    /** bind failures since the last successful listen (log dedup + takeover count). */
    private reverseRetryAttempts;
    /** The bot's own QQ id, learned from meta events (or config botQQ). */
    selfId: string;
    constructor(config: ConnectionConfig);
    /** Whether the transport currently has a live socket. */
    get connected(): boolean;
    /** The configured listen address (for /healthcheck). */
    get listenHost(): string;
    get listenPort(): number;
    /** Port-in-use bind retries since the last successful listen (for /healthcheck). */
    get portRetryAttempts(): number;
    /** Drop the current socket so the peer reconnects (liveness watchdog: the
     * WebSocket answers pings but the OneBot side has gone silent);
     * NapCat dials back in. No-op without a socket. */
    dropSocket(reason: string): void;
    /** The reverse server's bound address (for tests / diagnostics), if any. */
    address(): {
        host: string;
        port: number;
    } | undefined;
    /**
     * the transport's single log exit. The injected config.log is the
     * production sink (index.ts wires the same deps.log the bridge uses); the
     * console fallback keeps the class independently usable. Messages carry no
     * '[qq-companion] ' prefix — the sink owns prefixing.
     */
    private log;
    /** Start listening without blocking. */
    start(): void;
    /** Stop the transport: close sockets, cancel the bind retry, fail pending calls. */
    stop(): Promise<void>;
    /**
     * Call a OneBot action and await its data payload.
     * @param action - OneBot 11 action name.
     * @param params - action parameters (plain object).
     * @returns the action data payload (object or array).
     * @throws OneBotNotConnectedError / OneBotActionError on failure or timeout.
     */
    call(action: string, params: Record<string, unknown>): Promise<unknown>;
    private startReverseServer;
    /**
     * EADDRINUSE is no longer a dead end. ws does not emit 'close' after
     * a failed bind, so the failed instance would hang on this.server forever —
     * and the start() reentrancy guard would then block even a manual restart.
     * This handler (1) closes and detaches the dead instance, (2) logs with
     * steady-state dedup (first failure + one line per 10 minutes), and
     * (3) schedules a fixed 15s re-bind until the port is released or stop()
     * is called. No attempt cap; the timer is unref'd and the retry is never
     * awaited, so host startup stays unblocked and the loop cannot keep the
     * process alive on its own.
     */
    private scheduleReverseRetry;
    private attachSocket;
    private startHeartbeat;
    private stopHeartbeat;
    private setConnected;
    private failAllPending;
    /** One JSON frame: an action response (has echo) or an inbound event. */
    private onFrame;
}
