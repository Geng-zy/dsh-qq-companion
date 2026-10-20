/** Atomically replace `path` with `content` (temp + fsync + rename). */
export declare function writeFileAtomic(path: string, content: string): Promise<void>;
/** One file's serialized writer. */
export declare class SerialFileWriter {
    private readonly path;
    private readonly label;
    private readonly log;
    private chain;
    constructor(path: string, options?: {
        label?: string;
        log?: (level: 'warn', message: string) => void;
    });
    /**
     * Queue one write. `render` runs when the write starts and returns the
     * whole file content (or undefined to skip this write). Failures are logged
     * and never reject — persistence must not break the caller's flow.
     */
    write(render: () => string | undefined): Promise<void>;
    /** Resolves once every queued write has settled. */
    idle(): Promise<void>;
}
