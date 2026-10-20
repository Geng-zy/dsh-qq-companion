export interface SendCounterSnapshot {
    lastMinute: number;
    lastHour: number;
    today: number;
}
export declare class SendCounter {
    private readonly now;
    private recent;
    private day;
    private todayCount;
    constructor(options?: {
        now?: () => number;
    });
    /** One message went out. */
    record(): void;
    snapshot(): SendCounterSnapshot;
    private rollDay;
}
