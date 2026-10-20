/**
 * Slash commands: the routed command table, /help (generated from the
 * table) and the router. Handlers live in commands/ by area; the narrow
 * CommandContext they work through is in commands/types.ts.
 * @module dsh-qq-companion/commands
 */
import { CommandContext, CommandSender } from './commands/types.js'
import { handleGoalCommand, handleRetryCommand, handleSessionCommand, handleSteerCommand, handleStopCommand } from './commands/session.js'
import { handleModelCommand, handlePresetCommand, handleWorkspaceCommand } from './commands/model.js'
import { handleHealthcheckCommand, handleIdCommand, handleModeCommand, handleOcrCommand, handleStatusCommand, handleVerCommand } from './commands/info.js'
import { handlePermissionCommand, handlePlanCommand } from './commands/host.js'
import { handleTaskCommand } from './companion/task-command.js'
import { handleGroupCommand } from './groups.js'

import { type ChatId } from './chat.js'


// Handlers and shared types live in commands/; re-exported so the bridge and
// tests keep importing from here.
export * from './commands/types.js'
export * from './commands/selection.js'
export * from './commands/session.js'
export * from './commands/model.js'
export * from './commands/host.js'
export * from './commands/info.js'


/** One routed slash command: the table row IS the registration —
 * adding a command is exactly one row here and /help picks it up for free. */
export interface CommandDefinition {
  /** Command word after the leading slash (matched case-insensitively). */
  name: string
  /** Alternative first-words routed to the same handler; rendered nowhere
   * (/help lists only `name`, suggestions map an alias back to it). */
  aliases?: string[]
  /** Admin-only flag; every current command is gated at the router entry. */
  adminOnly: boolean
  /** /help line shown after "/name ": the usage-argument form (when the
   * command takes arguments) followed by the description, e.g.
   * "[路径|序号|list] 查看或切换工作区" or plain "本帮助". */
  help: string
  /** /help group header the row renders under (no ▍ prefix). Rows without
   * one fall into 「其他」; a group outside the fixed card order still renders
   * (appended), so a new row always shows up in the card. */
  group?: string
  handler(ctx: CommandContext, chatId: ChatId, arg: string, sender: CommandSender): Promise<void>
}

/** The routed command table. Row order = the /help line order inside each
 * group (the router matches by name, so ordering is routing-neutral). */
export const COMMANDS: CommandDefinition[] = [
  { name: 'new', adminOnly: true, group: '会话', help: '开启新会话（清空上下文）', handler: async (ctx, chatId) => {
    ctx.log('info', 'slash /new for ' + chatId)
    await ctx.resetChat(chatId)
  } },
  { name: 'stop', adminOnly: true, group: '操作', help: '停止当前生成', handler: (ctx, chatId) => handleStopCommand(ctx, chatId) },
  { name: 'steer', adminOnly: true, group: '操作', help: '<补充内容> 向运行中的任务补充指令', handler: (ctx, chatId, arg, sender) => handleSteerCommand(ctx, chatId, arg, sender) },
  { name: 'model', adminOnly: true, group: '其他', help: '[--default] <provider> <model> 切换模型（--default 改部署默认；无参两级序号列表）', handler: (ctx, chatId, arg) => handleModelCommand(ctx, chatId, arg) },
  { name: 'workspace', adminOnly: true, group: '会话', help: '[路径|序号|list] 查看或切换工作区', handler: (ctx, chatId, arg) => handleWorkspaceCommand(ctx, chatId, arg) },
  { name: 'preset', adminOnly: true, group: '会话', help: '[id|序号] 查看/切换 agent 预设', handler: (ctx, chatId, arg) => handlePresetCommand(ctx, chatId, arg) },
  { name: 'session', adminOnly: true, group: '会话', help: '[序号] 查看/切回历史会话', handler: (ctx, chatId, arg) => handleSessionCommand(ctx, chatId, arg) },
  { name: 'status', adminOnly: true, group: '查询', help: '会话全景', handler: (ctx, chatId) => handleStatusCommand(ctx, chatId) },
  { name: 'doctor', aliases: ['healthcheck'], adminOnly: true, group: '查询', help: '[export [参考号]] 运行体检（export [参考号] 导出脱敏诊断包，文件名含参考号）', handler: (ctx, chatId, arg) => handleHealthcheckCommand(ctx, chatId, arg) },
  { name: 'retry', adminOnly: true, group: '操作', help: '重跑上一条', handler: (ctx, chatId) => handleRetryCommand(ctx, chatId) },
  { name: 'id', adminOnly: true, group: '查询', help: '会话标识（session/chat）', handler: (ctx, chatId) => handleIdCommand(ctx, chatId) },
  { name: 'ver', adminOnly: true, group: '查询', help: '插件版本', handler: (ctx, chatId) => handleVerCommand(ctx, chatId) },
  { name: 'ocr', adminOnly: true, group: '操作', help: '识别最近一张图片', handler: (ctx, chatId) => handleOcrCommand(ctx, chatId) },
  { name: 'mode', adminOnly: true, group: '输出', help: '[interim|instant] 出站模式（合并卡片/逐条即时）', handler: (ctx, chatId, arg) => handleModeCommand(ctx, chatId, arg) },
  { name: 'plan', adminOnly: true, group: '输出', help: '[off|内容] 宿主计划模式', handler: (ctx, chatId, arg) => handlePlanCommand(ctx, chatId, arg) },
  { name: 'permission', adminOnly: true, group: '会话', help: '[w|f|预设名|序号] 切换权限预设（w=工作区可写+需审批，f=全盘+免审批）', handler: (ctx, chatId, arg) => handlePermissionCommand(ctx, chatId, arg) },
  { name: 'group', aliases: ['qun'], adminOnly: true, group: '其他', help: '[list|allow <群号>|remove <群号>] 群白名单', handler: (ctx, chatId, arg) => handleGroupCommand(ctx.groupAccess, arg, text => ctx.sendToChat(chatId, text)) },
  { name: 'task', adminOnly: true, group: '其他', help: '[id] 定时任务：无参列出，带 id 立刻执行一次', handler: (ctx, chatId, arg) => handleTaskCommand(ctx, arg, text => ctx.sendToChat(chatId, text)) },
  { name: 'goal', adminOnly: true, group: '其他', help: '[目标|clear] 目标记录', handler: (ctx, chatId, arg) => handleGoalCommand(ctx, chatId, arg) },
  { name: 'help', adminOnly: true, group: '其他', help: '本帮助', handler: async (ctx, chatId) => {
    await ctx.sendToChat(chatId, helpText())
  } },
]

/** /help group headers in card order; a row whose group is not listed here
 * renders under an appended header (first-seen table order), so a new
 * command row always shows up in the card. */
const HELP_GROUP_ORDER = ['会话', '输出', '查询', '操作', '其他']

/** /help body: grouped multi-line card generated from the table — adding a
 * command stays a one-row change and its group header comes from the row
 * (unlisted groups append). The tail line documents the unknown-command
 * behavior. Exported for the full-text snapshot gate in tests/commands.spec.ts. */
export function helpText(): string {
  const groups = new Map<string, CommandDefinition[]>()
  for (const c of COMMANDS) {
    const key = c.group ?? '其他'
    const rows = groups.get(key)
    if (rows === undefined) groups.set(key, [c])
    else rows.push(c)
  }
  const order = [...groups.keys()].sort((a, b) => {
    const ia = HELP_GROUP_ORDER.indexOf(a)
    const ib = HELP_GROUP_ORDER.indexOf(b)
    return (ia === -1 ? HELP_GROUP_ORDER.length : ia) - (ib === -1 ? HELP_GROUP_ORDER.length : ib)
  })
  const lines = ['可用命令（仅管理员）：']
  for (const g of order) {
    lines.push('▍' + g)
    for (const c of groups.get(g)!) lines.push('/' + c.name + ' ' + c.help)
  }
  return lines.join('\n') + '\n\n未知命令默认拦截并提示相近命令；unknownCommand: passthrough 可改为透传给模型。'
}

/** Close command-name suggestions for an unknown /word: prefix matches first
 * (table order), then an edit-distance ≤2 fallback that only runs for inputs
 * of length ≥4 (so short real commands like /id or /ver are never shadowed);
 * an alias candidate suggests its primary name. At most 3 candidates are
 * listed. */
function suggestCommands(input: string): string[] {
  const canonical = new Map<string, string>()
  for (const c of COMMANDS) {
    canonical.set(c.name, c.name)
    for (const a of c.aliases ?? []) canonical.set(a, c.name)
  }
  const names = [...canonical.keys()]
  const suggestions = names.filter(n => n.startsWith(input)).map(n => canonical.get(n)!)
  if (suggestions.length === 0 && input.length >= 4) {
    suggestions.push(...names.filter(n => Math.abs(n.length - input.length) <= 2 && editDistanceWithin2(input, n)).map(n => canonical.get(n)!))
  }
  return suggestions.slice(0, 3)
}

/** Whether the Levenshtein distance between a and b is ≤2 (single words only). */
function editDistanceWithin2(a: string, b: string): boolean {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length] <= 2
}

/**
 * Slash-command router. Commands are admin-only (the Hermes member
 * slash-command block) and are matched on the first word; a leading
 * @mention glued to the command (QQ group at + text) is stripped first.
 * A path like /tmp/x is never a command (command words are
 * /[A-Za-z][A-Za-z0-9_-]* only). Unknown commands get closest-match
 * suggestions (prefix first, edit distance ≤2 for length ≥4 inputs only)
 * and are consumed; with no suggestion, config.unknownCommand decides —
 * 'intercept' (default) consumes with a hint, 'passthrough' returns false
 * so the message reaches the model (the old Hermes fall-through).
 * @param ctx - bridge capabilities (built by ChatBridge).
 * @param chatId - the chat the command arrived in.
 * @param text - parsed inbound text.
 * @param userId - sender QQ number.
 * @param nickname - sender display name (pre-sanitized by inbound.ts); used
 *   by /steer for the <user_message> boundary attribute.
 * @returns true when the message was consumed by a command.
 */
export async function tryHandleCommand(ctx: CommandContext, chatId: ChatId, text: string, userId: string, nickname?: string): Promise<boolean> {
  const normalized = text.replace(/^@\d+\s*/, '')
  const first = (normalized.split(/\s+/, 1)[0] ?? '').trim()
  if (!/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(first)) return false

  if (!ctx.isAdmin(userId)) {
    await ctx.sendToChat(chatId, '该命令仅管理员可用。')
    return true
  }

  const name = first.slice(1).toLowerCase()
  ctx.log('debug', 'slash /' + name + ' for ' + chatId)
  const command = COMMANDS.find(c => c.name === name || c.aliases?.includes(name))
  if (command === undefined) {
    const suggestions = suggestCommands(name)
    if (suggestions.length > 0) {
      const names = suggestions.map(s => '/' + s)
      const label = names.length === 1 ? names[0] : names[0] + '（' + names.slice(1).join('、') + '）'
      await ctx.sendToChat(chatId, '未知命令 /' + name + '，你是想用 ' + label + '吗？')
      return true
    }
    if ((ctx.config.unknownCommand ?? 'intercept') !== 'passthrough') {
      await ctx.sendToChat(chatId, '未知命令 /' + name + '。发 /help 查看命令列表；要让模型处理请去掉开头的 / 重发。')
      return true
    }
    return false
  }
  await command.handler(ctx, chatId, normalized.slice(first.length).trim(), { userId, nickname: nickname ?? '' })
  return true
}
