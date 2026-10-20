/**
 * Inspection commands: /id, /ver, /status and /doctor.
 * @module dsh-qq-companion/commands/info
 */
import { CommandContext } from './types.js'
import { safeDefaultModel } from './selection.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ChatId } from '../chat.js'
import { describeError } from '../errors.js'
import { isFailureRef } from '../ref.js'

/** /id: show the chat/session identity (admin debug aid). */
export async function handleIdCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const sessionId = ctx.getChat(chatId)?.sessionId ?? await ctx.sessionIdFromMapping(chatId)
  await ctx.sendToChat(chatId,
    'chat    : ' + chatId + '\n' +
    'session : ' + (sessionId ?? '（未建立会话，下一条消息创建）') + '\n' +
    'cwd     : ' + ctx.effectiveCwd(chatId))
}

/** /ver: plugin version + git commit (each read once and cached). */
export async function handleVerCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const commit = gitCommit()
  await ctx.sendToChat(chatId, 'dsh-qq-companion v' + (packageVersion() ?? '?') + (commit !== undefined ? ' (' + commit + ')' : ''))
}

/** /status: one-shot snapshot of the chat session state. */
export async function handleStatusCommand(ctx: CommandContext, chatId: ChatId): Promise<void> {
  const chat = ctx.getChat(chatId)
  const sessionId = chat?.sessionId ?? await ctx.sessionIdFromMapping(chatId)
  const override = ctx.presetOverride(chatId)
  let preset: string
  if (override !== undefined) {
    preset = override + '（/preset 覆盖）'
  } else {
    const resolved = await ctx.resolvePresetId(chatId)
    preset = (resolved ?? undefined) !== undefined ? (resolved ?? '') + '（默认/配置）' : '（未记录）'
  }
  const current = chat?.selectionRef?.current ?? safeDefaultModel(ctx)
  const model = current !== undefined ? current.provider + '/' + current.model : '（未设置）'
  const cwd = ctx.effectiveCwd(chatId)
  let wsSuffix = ''
  try {
    const ws = await ctx.workspaceRegistry?.resolveByPath(cwd)
    wsSuffix = ws !== undefined ? `（工作区 ${ws.id}，${ws.sessionIds.length} 个会话）` : '（无 workspace 记录）'
  } catch (error) {
    ctx.log('debug', 'resolveByPath failed: ' + String(error))
  }
  const agentState = chat !== undefined
    ? 'busy=' + chat.busy + ' loopBuffer=' + chat.loopBuffer.length
    : '（未建立会话）'
  const switchableCount = ctx.switchableSessions(chatId).length
  await ctx.sendToChat(chatId,
    'chat    : ' + chatId + '\n' +
    'session : ' + (sessionId ?? '（未建立会话）') + '\n' +
    'preset  : ' + preset + '\n' +
    'model   : ' + model + '\n' +
    'cwd     : ' + cwd + ' ' + wsSuffix + '\n' +
    '中间消息 : ' + (ctx.config.interimMessages ? '开' : '关') + '\n' +
    'agent   : ' + agentState + '\n' +
    '可切回   : ' + switchableCount + ' 条历史会话（/session 查看列表）')
}

/** /doctor: render the health summary, or pack the redacted
 * diagnostics archive with the `export` argument. Failures are reported to
 * the chat as a ⚠️ line, never thrown past the router. */
export async function handleDoctorCommand(ctx: CommandContext, chatId: ChatId, arg: string): Promise<void> {
  const trimmed = arg.trim()
  // `export [参考号]` — an explicit reference is validated against
  // the reference format before it reaches the archive file name (fail-closed:
  // junk input gets the usage line, never a sanitized-weird file name).
  const exportMatch = /^export(\s+(\S+))?$/.exec(trimmed)
  if (exportMatch !== null) {
    const triggerRef = exportMatch[2]
    if (triggerRef !== undefined && !isFailureRef(triggerRef)) {
      await ctx.sendToChat(chatId, '⚠️ 参考号格式不正确：' + triggerRef + '\n用法：/doctor（体检摘要）或 /doctor export [参考号]（导出脱敏诊断包；参考号形如 MF-xxx / QQ-CONN-xxx，省略时自动使用最近一次故障的参考号）。')
      return
    }
    if (ctx.exportDiagnostics === undefined) {
      await ctx.sendToChat(chatId, '⚠️ 诊断包导出未启用（health 模块未接线）。')
      return
    }
    try {
      const archive = await ctx.exportDiagnostics(triggerRef)
      await ctx.sendToChat(chatId, '📦 诊断包已导出（token/accessToken 已强制脱敏）：\n' + archive)
    } catch (error) {
      await ctx.sendToChat(chatId, '⚠️ 诊断包导出失败：' + describeError(error))
    }
    return
  }
  if (trimmed !== '') {
    await ctx.sendToChat(chatId, '用法：/doctor（体检摘要）或 /doctor export [参考号]（导出脱敏诊断包）。')
    return
  }
  if (ctx.healthReport === undefined) {
    await ctx.sendToChat(chatId, '⚠️ 体检未启用（health 模块未接线）。')
    return
  }
  try {
    await ctx.sendToChat(chatId, await ctx.healthReport())
  } catch (error) {
    await ctx.sendToChat(chatId, '⚠️ 体检失败：' + describeError(error))
  }
}

/** Plugin version from package.json, read once (per process). Exported for the /ver ESM regression test. */
export let cachedPluginVersion: string | undefined
/** The plugin's package root: the nearest ancestor directory holding this
 * plugin's package.json (works from src/ under tests and from lib/ deployed). */
export function pluginRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
      if (pkg.name === 'dsh-qq-companion') return dir
    } catch {
      // no package.json here: keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function packageVersion(): string | undefined {
  if (cachedPluginVersion === undefined) {
    try {
      const root = pluginRoot()
      if (root === undefined) throw new Error('package root not found')
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }
      cachedPluginVersion = typeof pkg.version === 'string' ? pkg.version : undefined
    } catch {
      cachedPluginVersion = undefined
    }
  }
  return cachedPluginVersion
}

/** Git short commit of the plugin repo, read once (best-effort, per process). */
export let cachedGitCommit: string | undefined
export function gitCommit(): string | undefined {
  if (cachedGitCommit === undefined) {
    try {
      const root = pluginRoot()
      if (root === undefined) throw new Error('package root not found')
      const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
      cachedGitCommit = commit !== '' ? commit : undefined
    } catch {
      cachedGitCommit = undefined
    }
  }
  return cachedGitCommit
}
