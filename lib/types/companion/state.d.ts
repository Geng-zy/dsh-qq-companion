import type { Log } from './time.js';
export declare class JsonState<T extends object> {
    private readonly file;
    private readonly writer;
    private readonly log;
    /** Whether a prior state file existed at load time. */
    existed: boolean;
    constructor(file: string | undefined, options: {
        label: string;
        log?: Log;
    });
    /** Read the stored state (undefined when absent or unreadable). */
    load(): Promise<Partial<T> | undefined>;
    /** Persist a snapshot (no-op without a file). */
    save(render: () => T): Promise<void>;
}
