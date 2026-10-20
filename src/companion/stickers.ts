/**
 * Her sticker library: pictures she kept from chats (QQ stickers, photos,
 * screenshots) with tags, so she can later find one by mood and send it.
 * Images live as files in one directory; index.json lists them. Caps: total
 * count, bytes per image, new images per day. The same picture (by content
 * hash) is kept once; saving it again only adds tags.
 * @module dsh-qq-companion/companion/stickers
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { describeError } from '../errors.js'
import { SerialFileWriter } from '../persist.js'
import { dayKey, type Log } from './time.js'

export const STICKER_INDEX_FILE = 'index.json'
export const DEFAULT_STICKER_MAX_COUNT = 300
export const DEFAULT_STICKER_MAX_BYTES = 1024 * 1024
export const DEFAULT_STICKER_DAILY_MAX = 20
/** Most results one search returns. */
export const STICKER_SEARCH_MAX = 5
const MAX_TAGS = 8
const MAX_TAG_CHARS = 12
const MAX_DESCRIPTION_CHARS = 60

export interface Sticker {
  id: string
  file: string
  tags: string[]
  description: string
  sha256: string
  /** Chat it was saved from (private:<qq> / group:<id>). */
  from: string
  addedAt: number
  uses: number
  lastUsedAt?: number
}

export type StickerSaveResult =
  | { ok: true; sticker: Sticker; merged: boolean }
  | { ok: false; reason: string }

export interface StickerLibraryOptions {
  dir: string
  maxCount?: number
  maxBytes?: number
  dailyMax?: number
  log?: Log
  now?: () => number
}

/** The image type a file's first bytes say it is, or undefined. */
export function sniffImage(head: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | undefined {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg'
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return 'gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return undefined
}

/** Tags as stored: trimmed, short, deduplicated, at most MAX_TAGS. */
export function normalizeTags(tags: readonly unknown[]): string[] {
  const out: string[] = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const clean = Array.from(tag.replace(/[\s#,，、]+/g, '')).slice(0, MAX_TAG_CHARS).join('')
    if (clean !== '' && !out.includes(clean)) out.push(clean)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

const clip = (text: string, max: number): string => Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, max).join('')

export class StickerLibrary {
  readonly dir: string
  private readonly maxCount: number
  private readonly maxBytes: number
  private readonly dailyMax: number
  private readonly log: Log
  private readonly now: () => number
  private readonly writer: SerialFileWriter
  private stickers: Sticker[] = []
  private nextNumber = 1
  /** Mutations run one at a time (dedupe and numbering stay correct). */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: StickerLibraryOptions) {
    this.dir = options.dir
    this.maxCount = options.maxCount ?? DEFAULT_STICKER_MAX_COUNT
    this.maxBytes = options.maxBytes ?? DEFAULT_STICKER_MAX_BYTES
    this.dailyMax = options.dailyMax ?? DEFAULT_STICKER_DAILY_MAX
    this.log = options.log ?? (() => undefined)
    this.now = options.now ?? (() => Date.now())
    this.writer = new SerialFileWriter(join(this.dir, STICKER_INDEX_FILE), { label: '表情包索引', log: (level, message) => this.log(level, message) })
  }

  /** Read index.json (missing = empty library; a corrupt file is logged and ignored). */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, STICKER_INDEX_FILE), 'utf8')) as { stickers?: unknown }
      const list = Array.isArray(raw.stickers) ? raw.stickers : []
      this.stickers = list.filter((s): s is Sticker => typeof (s as Sticker)?.id === 'string' && typeof (s as Sticker)?.file === 'string')
        .map(s => ({ ...s, tags: normalizeTags(Array.isArray(s.tags) ? s.tags : []), uses: Number(s.uses) || 0 }))
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') this.log('warn', '表情包索引读取失败，按空库处理: ' + describeError(error))
      this.stickers = []
    }
    this.nextNumber = 1 + Math.max(0, ...this.stickers.map(s => Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0)))
  }

  get count(): number {
    return this.stickers.length
  }

  /** How many were added today (local calendar day). */
  addedToday(): number {
    const today = dayKey(this.now())
    return this.stickers.filter(s => dayKey(s.addedAt) === today).length
  }

  get(id: string): Sticker | undefined {
    return this.stickers.find(s => s.id === id)
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Keep a picture: copy it in, or add tags to the copy already kept. */
  save(sourcePath: string, tags: readonly unknown[], description: string, from: string): Promise<StickerSaveResult> {
    return this.serial(() => this.saveNow(sourcePath, tags, description, from))
  }

  private async saveNow(sourcePath: string, tags: readonly unknown[], description: string, from: string): Promise<StickerSaveResult> {
    const cleanTags = normalizeTags(tags)
    if (cleanTags.length === 0) return { ok: false, reason: '至少要给一个标签（比如：摸头、无语、开心）' }
    let size: number
    try {
      size = (await stat(sourcePath)).size
    } catch {
      return { ok: false, reason: '找不到这张图片的文件' }
    }
    if (size > this.maxBytes) return { ok: false, reason: '图片太大（' + Math.round(size / 1024) + 'KB，上限 ' + Math.round(this.maxBytes / 1024) + 'KB）' }
    const bytes = await readFile(sourcePath)
    const kind = sniffImage(bytes.subarray(0, 16))
    if (kind === undefined) return { ok: false, reason: '这不是 png / jpg / gif / webp 图片' }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const existing = this.stickers.find(s => s.sha256 === sha256)
    if (existing !== undefined) {
      existing.tags = normalizeTags([...existing.tags, ...cleanTags])
      if (existing.description === '' && description.trim() !== '') existing.description = clip(description, MAX_DESCRIPTION_CHARS)
      await this.persist()
      return { ok: true, sticker: existing, merged: true }
    }
    if (this.stickers.length >= this.maxCount) return { ok: false, reason: '表情包库满了（' + this.maxCount + ' 张），先删掉几张不常用的' }
    if (this.addedToday() >= this.dailyMax) return { ok: false, reason: '今天已经存了 ' + this.dailyMax + ' 张，明天再存' }
    const id = 's' + String(this.nextNumber++).padStart(4, '0')
    const file = id + '.' + kind
    await mkdir(this.dir, { recursive: true })
    await copyFile(sourcePath, join(this.dir, file))
    const sticker: Sticker = { id, file, tags: cleanTags, description: clip(description, MAX_DESCRIPTION_CHARS), sha256, from, addedAt: this.now(), uses: 0 }
    this.stickers.push(sticker)
    await this.persist()
    this.log('info', '存了表情包 ' + id + '（' + cleanTags.join('、') + '）')
    return { ok: true, sticker, merged: false }
  }

  /**
   * Find stickers for a mood or topic. Each query word scores on the tags
   * (whole tag 3, part of a tag 2) and the description (1); ties go to the
   * one sent less often, so the same picture does not come up every time.
   * `today` lists today's additions instead (for the nightly tidy-up).
   */
  search(query: string, options: { limit?: number; today?: boolean } = {}): Sticker[] {
    const limit = Math.min(Math.max(options.limit ?? STICKER_SEARCH_MAX, 1), options.today === true ? 50 : STICKER_SEARCH_MAX)
    if (options.today === true) {
      const today = dayKey(this.now())
      return this.stickers.filter(s => dayKey(s.addedAt) === today).slice(0, limit)
    }
    const words = query.split(/[\s,，、/]+/).map(w => w.trim()).filter(w => w !== '')
    if (words.length === 0) return []
    const scored = this.stickers.map(s => {
      let score = 0
      for (const w of words) {
        if (s.tags.includes(w)) score += 3
        else if (s.tags.some(t => t.includes(w) || w.includes(t))) score += 2
        if (s.description.includes(w)) score += 1
      }
      return { s, score }
    }).filter(x => x.score > 0)
    scored.sort((a, b) => b.score - a.score || a.s.uses - b.s.uses || (a.s.lastUsedAt ?? 0) - (b.s.lastUsedAt ?? 0))
    return scored.slice(0, limit).map(x => x.s)
  }

  /** The image file of one sticker (absolute path). */
  pathOf(sticker: Sticker): string {
    return join(this.dir, sticker.file)
  }

  markUsed(id: string): Promise<void> {
    return this.serial(() => this.markUsedNow(id))
  }

  private async markUsedNow(id: string): Promise<void> {
    const sticker = this.get(id)
    if (sticker === undefined) return
    sticker.uses += 1
    sticker.lastUsedAt = this.now()
    await this.persist()
  }

  edit(id: string, change: { tags?: readonly unknown[]; description?: string }): Promise<Sticker | undefined> {
    return this.serial(() => this.editNow(id, change))
  }

  private async editNow(id: string, change: { tags?: readonly unknown[]; description?: string }): Promise<Sticker | undefined> {
    const sticker = this.get(id)
    if (sticker === undefined) return undefined
    if (change.tags !== undefined) {
      const tags = normalizeTags(change.tags)
      if (tags.length > 0) sticker.tags = tags
    }
    if (change.description !== undefined) sticker.description = clip(change.description, MAX_DESCRIPTION_CHARS)
    await this.persist()
    return sticker
  }

  delete(id: string): Promise<boolean> {
    return this.serial(() => this.deleteNow(id))
  }

  private async deleteNow(id: string): Promise<boolean> {
    const sticker = this.get(id)
    if (sticker === undefined) return false
    this.stickers = this.stickers.filter(s => s.id !== id)
    await this.persist()
    await rm(join(this.dir, sticker.file), { force: true })
    this.log('info', '删了表情包 ' + id)
    return true
  }

  /** For /doctor: total, today's additions, the caps. */
  snapshot(): { count: number; maxCount: number; today: number; dailyMax: number } {
    return { count: this.stickers.length, maxCount: this.maxCount, today: this.addedToday(), dailyMax: this.dailyMax }
  }

  private async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.writer.write(() => JSON.stringify({ stickers: this.stickers }, null, 2) + '\n')
  }
}
