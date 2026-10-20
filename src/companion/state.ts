/**
 * A small JSON state file for the companion schedulers and counters, so
 * "what already happened today" survives a dsh restart. Writes go through
 * the shared serialized atomic writer; a missing or corrupt file just means
 * "no prior state".
 * @module dsh-qq-companion/companion/state
 */
import { readFile } from 'node:fs/promises'

import { describeError } from '../errors.js'
import { SerialFileWriter } from '../persist.js'
import type { Log } from './time.js'

export class JsonState<T extends object> {
  private readonly file: string | undefined
  private readonly writer: SerialFileWriter | undefined
  private readonly log: Log | undefined
  /** Whether a prior state file existed at load time. */
  existed = false

  constructor(file: string | undefined, options: { label: string; log?: Log }) {
    this.file = file
    this.log = options.log
    this.writer = file !== undefined && file !== ''
      ? new SerialFileWriter(file, { label: options.label, log: (level, message) => options.log?.(level, message) })
      : undefined
  }

  /** Read the stored state (undefined when absent or unreadable). */
  async load(): Promise<Partial<T> | undefined> {
    if (this.file === undefined || this.file === '') return undefined
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      this.existed = true
      return typeof raw === 'object' && raw !== null ? raw as Partial<T> : undefined
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.existed = true
        this.log?.('warn', '状态文件读取失败，按空状态处理: ' + describeError(error))
      }
      return undefined
    }
  }

  /** Persist a snapshot (no-op without a file). */
  save(render: () => T): Promise<void> {
    return this.writer?.write(() => JSON.stringify(render())) ?? Promise.resolve()
  }
}
