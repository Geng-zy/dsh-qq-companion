/**
 * OneBot 11 WebSocket transport: a reverse server NapCat (ws-reverse) dials
 * into, token check, frame handling, echo correlation for action calls,
 * heartbeat, and the busy-port bind retry. NapCat does the reconnecting.
 * @module dsh-qq-companion/connection
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { describeError, errorStack } from './errors.js';
/** Ping interval; two missed pongs drop the socket. */
const HEARTBEAT_MS = 30_000;
/**
 * Per-frame byte cap for both directions. ws defaults to 100MiB, letting a
 * token holder pin memory with a single giant frame. 64MiB keeps ample
 * headroom over the 20MiB maxInboundFileBytes default: a get_file response
 * carrying a max-size file is ~27MiB as base64 plus JSON framing.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/**
 * Reverse churn guard: at most CHURN_MAX_REPLACES replacements of a healthy
 * dial-in within CHURN_WINDOW_MS; further dial-ins are rejected so rapid
 * re-dials cannot endlessly squeeze out the legitimate NapCat.
 */
const CHURN_WINDOW_MS = 60_000;
const CHURN_MAX_REPLACES = 5;
/**
 * reverse EADDRINUSE retry: fixed 15s backoff until the port is released
 * (measured ≤15s takeover) and no attempt cap — stop() is
 * the only exit. The retry is scheduled, never awaited, so a busy port cannot
 * block or crash the host's startup.
 */
const REVERSE_RETRY_MS = 15_000;
/** Steady-state log dedup: the first failure plus one error line every 10 minutes. */
const REVERSE_LOG_EVERY = Math.max(1, Math.round(600_000 / REVERSE_RETRY_MS));
/** Error thrown for action calls that fail or time out. */
export class OneBotActionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OneBotActionError';
    }
}
/** Error thrown when the transport is not connected. */
export class OneBotNotConnectedError extends Error {
    constructor(message = 'OneBot WebSocket not connected') {
        super(message);
        this.name = 'OneBotNotConnectedError';
    }
}
/**
 * OneBot 11 transport. One instance handles exactly one peer: either a
 * reverse server accepting NapCat's dial-in.
 * All frames share the same correlation table.
 */
export class OneBotConnection {
    config;
    /** Inbound message event handler; the bridge/plugin wires this. */
    onMessage = () => undefined;
    /** Meta event handler (self_id learning). */
    onMeta = () => undefined;
    /** Connection-state callback. */
    onStatus = () => undefined;
    /** notice/request events (group invites, friend requests,
     * join/leave notices). Unwired = ignored, the upstream v1 behavior. */
    onNoticeOrRequest = () => undefined;
    /**
     * fault-reference hook, called at the significant connection
     * failure points (bind failure, reverse
     * server error) — the bridge implements it by minting/recording/tracing a
     * `QQ-CONN-…` reference; the returned reference is appended to the log
     * line so host logs and the trace file share the same number. Absent =
     * the fault log lines carry no reference.
     */
    onFailure = undefined;
    server;
    socket;
    lastPongAt = 0;
    heartbeatTimer;
    pending = new Map();
    stopping = false;
    connectedFlag = false;
    /** Reverse churn guard: timestamps (ms) of recent healthy-socket replacements. */
    reverseReplaces = [];
    /** pending EADDRINUSE bind retry timer (reverse mode). */
    reverseRetryTimer;
    /** bind failures since the last successful listen (log dedup + takeover count). */
    reverseRetryAttempts = 0;
    /** The bot's own QQ id, learned from meta events (or config botQQ). */
    selfId = '';
    constructor(config) {
        this.config = config;
    }
    /** Whether the transport currently has a live socket. */
    get connected() {
        return this.connectedFlag;
    }
    /** The configured listen address (for /doctor). */
    get listenHost() {
        return this.config.host;
    }
    get listenPort() {
        return this.config.port;
    }
    /** Port-in-use bind retries since the last successful listen (for /doctor). */
    get portRetryAttempts() {
        return this.reverseRetryAttempts;
    }
    /** Drop the current socket so the peer reconnects (liveness watchdog: the
     * WebSocket answers pings but the OneBot side has gone silent);
     * NapCat dials back in. No-op without a socket. */
    dropSocket(reason) {
        const socket = this.socket;
        if (socket === undefined)
            return;
        this.log('warn', 'dropping OneBot socket: ' + reason);
        try {
            socket.terminate();
        }
        catch {
            // already closing
        }
    }
    /** The reverse server's bound address (for tests / diagnostics), if any. */
    address() {
        const address = this.server?.address();
        if (typeof address === 'object' && address !== null) {
            return { host: address.address, port: address.port };
        }
        return undefined;
    }
    /**
     * the transport's single log exit. The injected config.log is the
     * production sink (index.ts wires the same deps.log the bridge uses); the
     * console fallback keeps the class independently usable. Messages carry no
     * '[qq-companion] ' prefix — the sink owns prefixing.
     */
    log(level, message) {
        if (this.config.log !== undefined) {
            this.config.log(level, message);
            return;
        }
        const line = '[qq-companion] ' + message;
        if (level === 'error')
            console.error(line);
        else if (level === 'warn')
            console.warn(line);
        else
            console.log(line);
    }
    /** Start listening without blocking. */
    start() {
        // Reentrancy guard: a live socket/server or a pending bind retry means the
        // transport is already up (or about to bind); starting again would leave a
        // stale timer binding into the new session.
        if (this.socket !== undefined || this.server !== undefined || this.reverseRetryTimer !== undefined)
            return;
        this.stopping = false;
        this.startReverseServer();
    }
    /** Stop the transport: close sockets, cancel the bind retry, fail pending calls. */
    async stop() {
        this.stopping = true;
        // cancel a pending EADDRINUSE bind retry (stop() is the only exit
        // of that loop, so it must be able to kill it).
        if (this.reverseRetryTimer !== undefined) {
            clearTimeout(this.reverseRetryTimer);
            this.reverseRetryTimer = undefined;
        }
        this.reverseRetryAttempts = 0;
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        const socket = this.socket;
        this.socket = undefined;
        if (socket !== undefined) {
            socket.removeAllListeners();
            try {
                socket.close();
            }
            catch {
                // already closing
            }
        }
        await new Promise(resolve => {
            if (this.server === undefined) {
                resolve();
                return;
            }
            const server = this.server;
            this.server = undefined;
            server.close(() => resolve());
            // Force-resolve if close hangs (open client sockets keep it open).
            setTimeout(resolve, 2_000).unref();
            for (const client of server.clients) {
                try {
                    client.terminate();
                }
                catch {
                    // ignore
                }
            }
        });
        this.failAllPending(new OneBotNotConnectedError('OneBot transport stopped'));
    }
    /**
     * Call a OneBot action and await its data payload.
     * @param action - OneBot 11 action name.
     * @param params - action parameters (plain object).
     * @returns the action data payload (object or array).
     * @throws OneBotNotConnectedError / OneBotActionError on failure or timeout.
     */
    call(action, params) {
        const socket = this.socket;
        if (socket === undefined || socket.readyState !== WebSocket.OPEN || this.stopping) {
            return Promise.reject(new OneBotNotConnectedError());
        }
        const echo = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new OneBotActionError('OneBot action ' + action + ' timed out after ' + this.config.callTimeoutMs + 'ms'));
            }, this.config.callTimeoutMs);
            this.pending.set(echo, { resolve, reject, timer });
            try {
                socket.send(JSON.stringify({ action, params, echo }));
            }
            catch (error) {
                this.pending.delete(echo);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new OneBotActionError(String(error)));
            }
        });
    }
    // ------------------------------------------------------------------ reverse
    startReverseServer() {
        if (this.config.accessToken === '') {
            throw new Error('reverse mode requires a non-empty accessToken');
        }
        const server = new WebSocketServer({ host: this.config.host, port: this.config.port, maxPayload: MAX_FRAME_BYTES });
        this.server = server;
        server.on('error', error => {
            const code = error.code;
            if (code === 'EADDRINUSE') {
                this.scheduleReverseRetry(server, error);
                return;
            }
            // a non-EADDRINUSE server error is a significant bridge fault —
            // mint a QQ-CONN reference (bridge hook) and share it with the log line.
            const ref = this.onFailure?.('reverse-server-error', '反向 WS 服务器错误: ' + describeError(error));
            this.log('error', 'reverse WS server error: ' + describeError(error) + (ref !== undefined ? '（参考号 ' + ref + '）' : '') + errorStack(error));
        });
        server.on('connection', (socket, request) => {
            const expected = Buffer.from('Bearer ' + this.config.accessToken, 'utf8');
            const provided = Buffer.from(request.headers.authorization ?? '', 'utf8');
            if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
                this.log('warn', 'rejecting reverse WS client: bad access token');
                socket.close(4401, 'unauthorized');
                return;
            }
            // Last-wins: NapCat expects a single dial-in; close any older socket.
            const previous = this.socket;
            if (previous !== undefined && previous.readyState < WebSocket.CLOSING) {
                // Churn guard: endlessly replacing the healthy dial-in squeezes out
                // the legitimate NapCat, so cap replacements per rolling window.
                const now = Date.now();
                this.reverseReplaces = this.reverseReplaces.filter(at => now - at < CHURN_WINDOW_MS);
                if (this.reverseReplaces.length >= CHURN_MAX_REPLACES) {
                    this.log('warn', 'rejecting reverse WS client: too many connection replacements within ' + CHURN_WINDOW_MS / 1000 + 's');
                    socket.close(4000, 'too many connections');
                    return;
                }
                this.reverseReplaces.push(now);
                try {
                    previous.close(4000, 'replaced');
                }
                catch {
                    // ignore
                }
            }
            this.attachSocket(socket);
            this.startHeartbeat();
        });
        server.on('listening', () => {
            const address = server.address();
            const shown = typeof address === 'object' && address !== null ? address.address + ':' + address.port : String(address);
            if (this.reverseRetryAttempts > 0) {
                // the port was released while a retry loop was pending — the
                // takeover is the user-visible payoff, so it gets its own info line.
                this.log('info', 'reverse WS server took over ' + this.config.host + ':' + this.config.port + ' after ' + this.reverseRetryAttempts + ' retry attempt(s): the port was released');
            }
            this.reverseRetryAttempts = 0;
            this.log('info', 'reverse WS server listening on ws://' + shown + ' (path /ws or /)');
        });
        server.on('close', () => {
            this.server = undefined;
            this.reverseRetryAttempts = 0;
        });
    }
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
    scheduleReverseRetry(server, error) {
        if (this.stopping)
            return;
        if (this.server !== server)
            return; // stale corpse: a newer bind attempt owns the state
        // 1) Dead-instance cleanup (best-effort): never listened → close may
        //    throw ERR_SERVER_NOT_RUNNING; swallow, the instance is a corpse.
        this.server = undefined;
        try {
            server.removeAllListeners();
            const handle = server._server;
            handle?.unref?.();
        }
        catch {
            // corpse cleanup is best-effort
        }
        try {
            server.close();
        }
        catch {
            // already handled above
        }
        // 2) Log with dedup: attempts 2..REVERSE_LOG_EVERY-1 stay at debug level.
        //    the reference is minted only when a line is actually logged
        //    (steady-state dedup — bind retries must not spam references).
        this.reverseRetryAttempts += 1;
        if (this.reverseRetryAttempts === 1 || this.reverseRetryAttempts % REVERSE_LOG_EVERY === 0) {
            const ref = this.onFailure?.('reverse-bind-failed', '反向 WS 服务器无法监听 ' + this.config.host + ':' + this.config.port + '：端口被占用（EADDRINUSE）');
            this.log('error', 'reverse WS server cannot listen on ' + this.config.host + ':' + this.config.port + ': port already in use (EADDRINUSE); stop the process occupying this port, or change config.port; retrying every ' + REVERSE_RETRY_MS / 1000 + 's until the port is released (attempt ' + this.reverseRetryAttempts + ')' + (ref !== undefined ? '（参考号 ' + ref + '）' : '') + errorStack(error));
        }
        else {
            this.log('debug', 'reverse WS server bind retry ' + this.reverseRetryAttempts + ': port ' + this.config.port + ' still in use');
        }
        // 3) Fixed 15s backoff, unref'd, no cap (stop() terminates the loop).
        this.reverseRetryTimer = setTimeout(() => {
            this.reverseRetryTimer = undefined;
            if (this.stopping)
                return;
            this.startReverseServer();
        }, REVERSE_RETRY_MS).unref();
    }
    // ------------------------------------------------------------------ shared
    attachSocket(socket) {
        const previous = this.socket;
        this.socket = socket;
        this.lastPongAt = Date.now();
        socket.on('message', data => this.onFrame(data));
        socket.on('pong', () => {
            if (this.socket !== socket)
                return; // stale socket: a newer dial-in owns the timestamps
            this.lastPongAt = Date.now();
        });
        socket.on('close', (code, reason) => {
            if (this.socket !== socket)
                return; // stale socket: a newer dial-in replaced it
            this.socket = undefined;
            this.stopHeartbeat();
            this.setConnected(false);
            this.failAllPending(new OneBotNotConnectedError('OneBot WS closed (code ' + code + ')'));
            if (!this.stopping) {
                this.log('warn', 'reverse WS client disconnected: ' + code + ' ' + reason.toString());
            }
        });
        socket.on('error', error => {
            this.log('warn', 'reverse WS client error: ' + describeError(error));
        });
        this.setConnected(true);
        if (previous !== undefined && previous !== socket && previous.readyState < WebSocket.CLOSING) {
            try {
                previous.close(4000, 'replaced');
            }
            catch {
                // ignore
            }
        }
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            const socket = this.socket;
            if (socket === undefined)
                return;
            if (socket.readyState !== WebSocket.OPEN)
                return;
            const now = Date.now();
            if (now - this.lastPongAt >= 2 * HEARTBEAT_MS) {
                this.log('warn', 'heartbeat timeout: no pong for ' + (now - this.lastPongAt) + 'ms; terminating socket');
                socket.terminate();
                return;
            }
            try {
                socket.ping();
            }
            catch {
                // socket may be closing
            }
        }, HEARTBEAT_MS).unref();
    }
    stopHeartbeat() {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }
    setConnected(connected) {
        if (this.connectedFlag === connected)
            return;
        this.connectedFlag = connected;
        try {
            this.onStatus(connected);
        }
        catch (error) {
            this.log('error', 'onStatus handler failed: ' + describeError(error) + errorStack(error));
        }
    }
    failAllPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    /** One JSON frame: an action response (has echo) or an inbound event. */
    onFrame(data) {
        let payload;
        try {
            payload = JSON.parse(data.toString());
        }
        catch {
            this.log('warn', 'dropping non-JSON WS frame');
            return;
        }
        if (typeof payload !== 'object' || payload === null)
            return;
        const frame = payload;
        if (typeof frame.echo === 'string' && this.pending.has(frame.echo)) {
            const pending = this.pending.get(frame.echo);
            this.pending.delete(frame.echo);
            if (pending === undefined)
                return;
            clearTimeout(pending.timer);
            if (frame.status === 'ok') {
                pending.resolve(frame.data ?? {});
            }
            else {
                const wording = typeof frame.wording === 'string' ? frame.wording : '';
                const retcode = frame.retcode ?? 'unknown';
                pending.reject(new OneBotActionError('OneBot action failed (retcode ' + retcode + ')' + (wording !== '' ? ': ' + wording : '')));
            }
            return;
        }
        if (typeof frame.post_type === 'string') {
            const event = frame;
            if (typeof event.self_id === 'number' || typeof event.self_id === 'string') {
                this.selfId = String(event.self_id);
            }
            if (event.post_type === 'message') {
                try {
                    this.onMessage(event);
                }
                catch (error) {
                    this.log('error', 'onMessage handler failed: ' + describeError(error) + errorStack(error));
                }
                return;
            }
            if (event.post_type === 'meta_event') {
                try {
                    this.onMeta(event);
                }
                catch (error) {
                    this.log('error', 'onMeta handler failed: ' + describeError(error) + errorStack(error));
                }
                return;
            }
            if (event.post_type === 'notice' || event.post_type === 'request') {
                try {
                    this.onNoticeOrRequest(event);
                }
                catch (error) {
                    this.log('error', 'onNoticeOrRequest handler failed: ' + describeError(error) + errorStack(error));
                }
            }
        }
    }
}
