/**
 * Startup configuration self-check: plain-language warnings for settings
 * that would make the plugin silently do nothing (or something surprising).
 * Pure: takes the resolved config, returns the problems; index.ts logs them
 * once at mount. Never throws, never blocks startup.
 * @module dsh-qq-companion/selfcheck
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SelfCheckInput {
  mode: 'reverse' | 'forward'
  host: string
  accessToken: string
  botQQ: string
  adminUsers: readonly string[]
  dmPolicy: string
  groupPolicy: string
  allowFrom: readonly string[]
  groupAllowFrom: readonly string[]
  allowAllUsers: boolean
  workspacePath: string
  adminWorkspacePath: string
  groupMemoryDir: string
  publicMemoryFile: string
  scheduledPrompts: ReadonlyArray<{ id: string; time: string; chatId: string; prompt: string }>
  proactiveEnabled: boolean
  proactiveChatId: string
  proactiveWindowStart: string
  proactiveWindowEnd: string
  proactiveMinPerDay: number
  proactiveMaxPerDay: number
  splitLines: boolean
  splitMaxMessages: number
  humanTypingPace?: boolean
  typingDelayMinMs?: number
  typingDelayMaxMs?: number
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const CHAT_ID = /^(private|group):\d{5,12}$/
const QQ = /^\d{5,12}$/

/** All problems found (empty = all good). */
export function selfCheck(c: SelfCheckInput): string[] {
  const problems: string[] = []
  if (c.mode === 'reverse' && c.accessToken === '') problems.push('accessToken 为空：reverse 模式会拒绝启动，QQ 连不上（设置 accessToken，并在 NapCat 的 WebSocket 客户端里填同一个 token）')
  if (c.mode === 'reverse' && (c.host === '0.0.0.0' || c.host === '::')) problems.push('host 是 ' + c.host + '：反向 WS 对所有网卡开放，确认防火墙已挡住该端口，或改成 127.0.0.1')
  if (c.adminUsers.length === 0 && !c.allowAllUsers) problems.push('adminUsers 为空：没人能私聊、也没人能用斜杠命令')
  for (const id of c.adminUsers) if (!QQ.test(id)) problems.push('adminUsers 里的「' + id + '」不像 QQ 号')
  if (c.botQQ !== '' && !QQ.test(c.botQQ)) problems.push('botQQ「' + c.botQQ + '」不像 QQ 号（留空会自动学习）')
  if (c.dmPolicy === 'allowlist' && c.allowFrom.length === 0) problems.push('dmPolicy 是 allowlist 但 allowFrom 为空：所有私聊都会被拒绝')
  if (c.groupPolicy === 'allowlist' && c.groupAllowFrom.length === 0) problems.push('groupPolicy 是 allowlist 但 groupAllowFrom 为空：在用 /group allow 添加之前，所有群都不会回复')
  if (c.allowAllUsers) problems.push('allowAllUsers 已开启：任何人都能私聊她（只适合调试）')
  const dirs: Array<[string, string]> = [['workspacePath', c.workspacePath], ['adminWorkspacePath', c.adminWorkspacePath], ['groupMemoryDir', c.groupMemoryDir]]
  for (const [key, dir] of dirs) if (dir !== '' && !existsSync(dir) && key !== 'groupMemoryDir') problems.push(key + ' 目录不存在：' + dir)
  if (c.groupMemoryDir !== '' && !existsSync(dirname(c.groupMemoryDir))) problems.push('groupMemoryDir 的上级目录不存在：' + dirname(c.groupMemoryDir))
  if (c.publicMemoryFile !== '' && !existsSync(dirname(c.publicMemoryFile))) problems.push('publicMemoryFile 所在目录不存在：' + dirname(c.publicMemoryFile))
  const ids = new Set<string>()
  for (const p of c.scheduledPrompts) {
    if (ids.has(p.id)) problems.push('scheduledPrompts 里 id「' + p.id + '」重复')
    ids.add(p.id)
    if (!HHMM.test(p.time)) problems.push('scheduledPrompts「' + p.id + '」的 time「' + p.time + '」不是 HH:MM，不会触发')
    if (!CHAT_ID.test(p.chatId)) problems.push('scheduledPrompts「' + p.id + '」的 chatId「' + p.chatId + '」格式不对（应为 private:QQ号 或 group:群号）')
    if (p.prompt.trim() === '') problems.push('scheduledPrompts「' + p.id + '」的 prompt 为空，不会触发')
  }
  if (c.proactiveEnabled) {
    if (!CHAT_ID.test(c.proactiveChatId)) problems.push('主动聊天已开启，但 proactiveChatId「' + c.proactiveChatId + '」格式不对，不会叫醒')
    else if (c.proactiveChatId.startsWith('private:') && !c.adminUsers.includes(c.proactiveChatId.slice(8))) problems.push('proactiveChatId 不是管理员的私聊：她会主动去找一个非管理员')
    if (!HHMM.test(c.proactiveWindowStart) || !HHMM.test(c.proactiveWindowEnd)) problems.push('主动聊天时段不是 HH:MM')
    else if (c.proactiveWindowStart >= c.proactiveWindowEnd) problems.push('主动聊天时段开始不早于结束（不支持跨午夜），不会叫醒')
    if (c.proactiveMinPerDay > c.proactiveMaxPerDay) problems.push('proactiveMinPerDay 大于 proactiveMaxPerDay')
  }
  if (c.humanTypingPace === true && (c.typingDelayMinMs ?? 0) > (c.typingDelayMaxMs ?? 0)) problems.push('按真人打字速度已开启，但 typingDelayMinMs 大于 typingDelayMaxMs：每条消息都会按最长时间等')
  if (c.splitLines && c.splitMaxMessages <= 1) problems.push('splitLines 已开启但 splitMaxMessages ≤ 1：实际不会拆分')
  return problems
}
