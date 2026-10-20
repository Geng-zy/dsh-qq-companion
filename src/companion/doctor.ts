/**
 * The companion block of /doctor: is the QQ account really online, what is
 * planned for today, and how full the memory files are.
 * @module dsh-qq-companion/companion/doctor
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { LivenessSnapshot } from '../liveness.js'
import { hhmm, minutesOfDay } from './time.js'

export interface CompanionStatusDeps {
  liveness?: () => LivenessSnapshot
  scheduler?: () => Array<{ id: string; time: string; firedToday: boolean }>
  proactive?: () => { remaining: string[]; firedToday: number }
  /** Memory files to size; `max` (bytes) renders a percentage. */
  memoryFiles?: Array<{ label: string; path: string; max?: number }>
  /** Root of per-group memory dirs (<root>/<group>/AGENTS.md). */
  groupMemoryDir?: string
  groupMemoryMaxBytes?: number
  now?: () => number
}

const kb = (n: number) => (n / 1024).toFixed(1) + 'KB'

async function size(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}

function sized(label: string, bytes: number | undefined, max?: number): string {
  if (bytes === undefined) return label + ' 无'
  if (max === undefined || max <= 0) return label + ' ' + kb(bytes)
  const pct = Math.round(bytes / max * 100)
  return label + ' ' + kb(bytes) + '/' + kb(max) + '（' + pct + '%' + (pct >= 100 ? '，已满' : pct >= 80 ? '，该整理了' : '') + '）'
}

/** Render the companion lines (never throws: a failing part renders 未知). */
export async function companionStatusLines(deps: CompanionStatusDeps): Promise<string[]> {
  const now = deps.now ?? (() => Date.now())
  const lines: string[] = ['▍陪伴状态']
  const live = deps.liveness?.()
  if (live !== undefined) {
    const beat = live.lastHeartbeatAt === undefined
      ? '还没收到心跳'
      : '上次心跳 ' + Math.max(0, Math.round((now() - live.lastHeartbeatAt) / 1000)) + ' 秒前'
    const online = live.online === undefined ? '未知' : live.online ? '在线' : '⚠️ 离线'
    lines.push('QQ 账号：' + online + '（' + beat + (live.intervalMs !== undefined ? '，间隔 ' + Math.round(live.intervalMs / 1000) + ' 秒' : '') + '）')
  }
  const tasks = deps.scheduler?.() ?? []
  if (tasks.length > 0) {
    const nowMin = minutesOfDay(now())
    lines.push('定时任务：' + tasks.map(t => t.id + ' ' + t.time + (t.firedToday ? ' 今天已执行' : ' 今天待执行')).join(' · ') + '（现在 ' + hhmm(nowMin) + '）')
  }
  const p = deps.proactive?.()
  if (p !== undefined) {
    lines.push('主动聊天：今天已叫醒 ' + p.firedToday + ' 次，还剩 ' + (p.remaining.length > 0 ? p.remaining.join('、') : '无'))
  }
  const files: string[] = []
  for (const f of deps.memoryFiles ?? []) {
    if (f.path !== '') files.push(sized(f.label, await size(f.path), f.max))
  }
  if (deps.groupMemoryDir !== undefined && deps.groupMemoryDir !== '') {
    try {
      const groups = (await readdir(deps.groupMemoryDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort()
      for (const g of groups) files.push(sized('群' + g, await size(join(deps.groupMemoryDir, g, 'AGENTS.md')), deps.groupMemoryMaxBytes))
    } catch {
      files.push('群记忆目录读不到')
    }
  }
  if (files.length > 0) lines.push('记忆文件：' + files.join(' · '))
  return lines
}
