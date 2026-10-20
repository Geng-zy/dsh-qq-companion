/**
 * Durable state-file writes shared by every persisted JSON/JSONL file of the
 * plugin (session mapping, retired / switchable sessions, deferred registry,
 * group allowlist, chat activity …).
 *
 * Writes to one file are queued on one chain; each write renders its content
 * only when it actually runs, so the last write always carries the latest
 * state, and no older snapshot can land after a newer one. The file is
 * replaced atomically: unique temp file → fsync → rename, so readers (and a
 * crash or power loss mid-write) only ever see the old or the new complete
 * file.
 * @module dsh-qq-companion/persist
 */
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describeError } from './errors.js';
let tmpCounter = 0;
/** Atomically replace `path` with `content` (temp + fsync + rename). */
export async function writeFileAtomic(path, content) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + '.tmp-' + process.pid + '-' + (tmpCounter++);
    const handle = await open(tmp, 'w', 0o600);
    try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await rename(tmp, path);
    }
    catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}
/** One file's serialized writer. */
export class SerialFileWriter {
    path;
    label;
    log;
    chain = Promise.resolve();
    constructor(path, options = {}) {
        this.path = path;
        this.label = options.label ?? path;
        this.log = options.log;
    }
    /**
     * Queue one write. `render` runs when the write starts and returns the
     * whole file content (or undefined to skip this write). Failures are logged
     * and never reject — persistence must not break the caller's flow.
     */
    write(render) {
        const run = this.chain.then(async () => {
            const content = render();
            if (content === undefined)
                return;
            await writeFileAtomic(this.path, content);
        }).catch(error => {
            this.log?.('warn', this.label + ' 保存失败: ' + describeError(error));
        });
        this.chain = run;
        return run;
    }
    /** Resolves once every queued write has settled. */
    idle() {
        return this.chain;
    }
}
