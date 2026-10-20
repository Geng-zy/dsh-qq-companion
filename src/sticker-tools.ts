/**
 * Model-facing sticker tools: keep a picture from the chat, find one by
 * mood, send it, and (owner / nightly only) fix tags or delete. At most one
 * sticker goes out per reply — enforced here, not left to the prompt.
 * @module dsh-qq-companion/sticker-tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { Sticker, StickerLibrary } from './companion/stickers.js'
import { fileToBase64, resolveContainedPath } from './media.js'

/** What the sticker tools need from the bridge. */
export interface StickerToolHost {
  chatForSession(sessionId: string): string | undefined
  /** Whether the running turn was started by the owner (or is a scheduled task). */
  canEditFiles(sessionId: string): boolean
  /** Roots a picture to keep may come from (the inbound media dir …). */
  mediaSendRoots(sessionId: string | undefined): Promise<{ roots: string[] }>
  /** Claim this reply's one sticker; false when one already went out this turn. */
  takeStickerSlot(chatId: string): boolean
  sendSegments(chatId: string, segments: Array<{ type: string; data: Record<string, unknown> }>): Promise<string | undefined>
}

const brief = (s: Sticker): { id: string; tags: string[]; description: string; uses: number } =>
  ({ id: s.id, tags: s.tags, description: s.description, uses: s.uses })

const json = (render: (value: unknown) => string) => ({
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: render(value) }],
})

function callerChat(host: StickerToolHost, exec: ToolRunContext): { sessionId: string; chatId: string } {
  const sessionId = exec.agent?.session.id
  const chatId = sessionId !== undefined ? host.chatForSession(String(sessionId)) : undefined
  if (sessionId === undefined || chatId === undefined) throw new Error('表情包工具只能在 QQ 会话里用')
  return { sessionId: String(sessionId), chatId }
}

export function registerStickerTools(ctx: Context, host: StickerToolHost, library: StickerLibrary): () => void {
  const disposers = [
    ctx.tools.register(defineTool({
      name: 'qq_sticker_save',
      description: '把聊天里收到的一张表情包或图片存进你的表情包库，以后可以用 qq_sticker_send 发。path 用消息里 [表情包:路径] 或 [图片:路径] 的路径；必须给 1～8 个标签（情绪、动作、场合，例如：摸头、安慰、可爱），再用一句话描述画面。同一张图存过会只合并标签。',
      parameters: {
        path: { type: 'string', required: true, description: '图片的本地路径（取自消息里的 [表情包:…] / [图片:…]）' },
        tags: { type: 'array', items: { type: 'string' }, required: true, description: '标签，1～8 个，每个最多 12 字' },
        description: { type: 'string', description: '一句话描述画面，最多 60 字' },
      },
      output: json(value => {
        const v = value as { ok?: boolean; id?: string; merged?: boolean; reason?: string }
        return v.ok === true ? (v.merged === true ? '这张存过了，已合并标签（' + v.id + '）' : '已存（' + v.id + '）') : '没存：' + String(v.reason ?? '')
      }),
      execute: async (args, exec) => {
        const a = args as { path?: unknown; tags?: unknown; description?: unknown }
        const { sessionId, chatId } = callerChat(host, exec)
        if (typeof a.path !== 'string' || a.path === '') throw new Error('qq_sticker_save: path 必填')
        const { roots } = await host.mediaSendRoots(sessionId)
        const source = await resolveContainedPath(roots, a.path)
        if (source === null) return { ok: false, reason: '只能存聊天里收到的图片（路径不在媒体目录里，或文件已经过期清理了）' }
        const result = await library.save(source, Array.isArray(a.tags) ? a.tags : [], typeof a.description === 'string' ? a.description : '', chatId)
        return (result.ok ? { ok: true, id: result.sticker.id, merged: result.merged, tags: result.sticker.tags } : result) as unknown as JsonValue
      },
    })),

    ctx.tools.register(defineTool({
      name: 'qq_sticker_search',
      description: '在你的表情包库里按情绪、动作或场合找表情包（多个关键词用空格隔开），最多返回 5 张，被发过次数少的排前面。today=true 时改为列出今天新存的（夜里整理用）。',
      parameters: {
        query: { type: 'string', description: '关键词，例如「摸头 安慰」' },
        today: { type: 'boolean', description: 'true = 列出今天新存的表情包' },
      },
      output: json(value => {
        const list = Array.isArray(value) ? value as Array<{ id: string; tags: string[] }> : []
        return list.length === 0 ? '没找到' : list.map(s => s.id + '（' + s.tags.join('、') + '）').join('；')
      }),
      isConcurrencySafe: () => true,
      execute: async args => {
        const a = args as { query?: unknown; today?: unknown }
        const found = library.search(typeof a.query === 'string' ? a.query : '', { today: a.today === true })
        return found.map(brief) as unknown as JsonValue
      },
    })),

    ctx.tools.register(defineTool({
      name: 'qq_sticker_send',
      description: '发一张表情包库里的表情包到当前会话（id 来自 qq_sticker_search）。每次回复最多发 1 张。',
      parameters: {
        id: { type: 'string', required: true, description: '表情包编号，例如 s0012' },
      },
      output: json(value => {
        const v = value as { sent?: boolean; reason?: string }
        return v.sent === true ? '已发送' : '没发：' + String(v.reason ?? '')
      }),
      execute: async (args, exec) => {
        const a = args as { id?: unknown }
        const { chatId } = callerChat(host, exec)
        const sticker = typeof a.id === 'string' ? library.get(a.id.trim()) : undefined
        if (sticker === undefined) return { sent: false, reason: '没有这个编号的表情包' } as JsonValue
        if (!host.takeStickerSlot(chatId)) return { sent: false, reason: '这次回复已经发过一张表情包了' } as JsonValue
        const file = await fileToBase64(library.pathOf(sticker), Number.MAX_SAFE_INTEGER, [library.dir])
        const messageId = await host.sendSegments(chatId, [{ type: 'image', data: { file, sub_type: 1, summary: '[动画表情]' } }])
        await library.markUsed(sticker.id)
        return { sent: true, messageId: messageId ?? null } as JsonValue
      },
    })),

    ctx.tools.register(defineTool({
      name: 'qq_sticker_edit',
      description: '修改一张表情包的标签或描述。只有主人本人发起的这一轮（或夜里的定时整理）能用。',
      parameters: {
        id: { type: 'string', required: true, description: '表情包编号' },
        tags: { type: 'array', items: { type: 'string' }, description: '新的标签（整组替换）' },
        description: { type: 'string', description: '新的描述' },
      },
      output: json(value => {
        const v = value as { ok?: boolean; reason?: string }
        return v.ok === true ? '已修改' : '没改：' + String(v.reason ?? '')
      }),
      execute: async (args, exec) => {
        const a = args as { id?: unknown; tags?: unknown; description?: unknown }
        const { sessionId } = callerChat(host, exec)
        if (!host.canEditFiles(sessionId)) return { ok: false, reason: '只有主人本人能让你改表情包库' }
        const sticker = typeof a.id === 'string'
          ? await library.edit(a.id.trim(), {
            ...(Array.isArray(a.tags) ? { tags: a.tags } : {}),
            ...(typeof a.description === 'string' ? { description: a.description } : {}),
          })
          : undefined
        return (sticker === undefined ? { ok: false, reason: '没有这个编号的表情包' } : { ok: true, ...brief(sticker) }) as unknown as JsonValue
      },
    })),

    ctx.tools.register(defineTool({
      name: 'qq_sticker_delete',
      description: '从表情包库里删掉一张表情包（重复的、不合适的、很久不用的）。只有主人本人发起的这一轮（或夜里的定时整理）能用。',
      parameters: {
        id: { type: 'string', required: true, description: '表情包编号' },
      },
      output: json(value => {
        const v = value as { ok?: boolean; reason?: string }
        return v.ok === true ? '已删除' : '没删：' + String(v.reason ?? '')
      }),
      execute: async (args, exec) => {
        const a = args as { id?: unknown }
        const { sessionId } = callerChat(host, exec)
        if (!host.canEditFiles(sessionId)) return { ok: false, reason: '只有主人本人能让你删表情包' } as JsonValue
        const ok = typeof a.id === 'string' && await library.delete(a.id.trim())
        return (ok ? { ok: true } : { ok: false, reason: '没有这个编号的表情包' }) as JsonValue
      },
    })),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
