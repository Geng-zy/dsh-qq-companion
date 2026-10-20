/**
 * QQ account liveness, beyond the WebSocket being open.
 *
 * NapCat keeps answering WebSocket pings even when the QQ account behind it
 * has been kicked offline or its login expired, so the bridge would look
 * healthy while no message ever arrives. OneBot 11 heartbeat meta events
 * (NapCat: every heartInterval, 30s by default) carry `status.online`; this
 * watcher logs every online/offline transition loudly, reacts to NapCat's
 * `bot_offline` notice, and drops the socket when an open connection stops
 * delivering heartbeats altogether (a "zombie" link), so the peer reconnects.
 * @module dsh-qq-companion/liveness
 */
import type { OneBotEvent } from './connection.js';
type Log = (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
export interface LivenessSnapshot {
    /** Last OneBot heartbeat (epoch ms), undefined before the first one. */
    lastHeartbeatAt: number | undefined;
    /** Last reported QQ online state, undefined before the first report. */
    online: boolean | undefined;
    /** Heartbeat interval NapCat announced (ms), undefined when unknown. */
    intervalMs: number | undefined;
}
export declare class QqLiveness {
    private readonly log;
    private readonly now;
    private readonly connected;
    private readonly drop;
    private lastHeartbeatAt;
    private online;
    private intervalMs;
    private timer;
    constructor(options: {
        log: Log;
        connected: () => boolean;
        drop: (reason: string) => void;
        now?: () => number;
    });
    snapshot(): LivenessSnapshot;
    /** Feed one meta event (heartbeat / lifecycle). */
    onMeta(event: OneBotEvent): void;
    /** Feed one notice event; reacts to NapCat's bot_offline. */
    onNotice(event: OneBotEvent): void;
    /** One watchdog check (exported for tests). */
    check(): void;
    start(intervalMs?: number): void;
    stop(): void;
    private setOnline;
}
export {};
