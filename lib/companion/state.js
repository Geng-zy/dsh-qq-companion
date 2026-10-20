/**
 * A small JSON state file for the companion schedulers and counters, so
 * "what already happened today" survives a dsh restart. Writes go through
 * the shared serialized atomic writer; a missing or corrupt file just means
 * "no prior state".
 * @module dsh-qq-companion/companion/state
 */
import { readFile } from 'node:fs/promises';
import { describeError } from '../errors.js';
import { SerialFileWriter } from '../persist.js';
export class JsonState {
    file;
    writer;
    log;
    /** Whether a prior state file existed at load time. */
    existed = false;
    constructor(file, options) {
        this.file = file;
        this.log = options.log;
        this.writer = file !== undefined && file !== ''
            ? new SerialFileWriter(file, { label: options.label, log: (level, message) => options.log?.(level, message) })
            : undefined;
    }
    /** Read the stored state (undefined when absent or unreadable). */
    async load() {
        if (this.file === undefined || this.file === '')
            return undefined;
        try {
            const raw = JSON.parse(await readFile(this.file, 'utf8'));
            this.existed = true;
            return typeof raw === 'object' && raw !== null ? raw : undefined;
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.existed = true;
                this.log?.('warn', '状态文件读取失败，按空状态处理: ' + describeError(error));
            }
            return undefined;
        }
    }
    /** Persist a snapshot (no-op without a file). */
    save(render) {
        return this.writer?.write(() => JSON.stringify(render())) ?? Promise.resolve();
    }
}
