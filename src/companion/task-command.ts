/**
 * /task: list the daily scheduled prompts and today's proactive plan, or run
 * one now (`/task checkin` wakes her for a check-in right away).
 * @module dsh-qq-companion/companion/task-command
 */
import type { ScheduledPrompt } from './scheduler.js'

export interface TaskCommandContext {
  scheduledPrompts?: () => readonly ScheduledPrompt[]
  proactive?: { remaining(): string[]; fireNow(): Promise<void> }
  fireScheduled?: (prompt: ScheduledPrompt) => Promise<void>
}

export async function handleTaskCommand(ctx: TaskCommandContext, arg: string, reply: (text: string) => Promise<unknown>): Promise<void> {
  const prompts = ctx.scheduledPrompts?.() ?? []
  const id = arg.trim()
  if (id === '') {
    const lines = prompts.map(p => '· ' + p.id + '  每天 ' + p.time + ' → ' + p.chatId)
    if (ctx.proactive !== undefined) {
      const left = ctx.proactive.remaining()
      lines.push('· checkin  主动聊天，今天还剩：' + (left.length > 0 ? left.join('、') : '无'))
    }
    await reply(lines.length === 0
      ? '没有配置定时任务。'
      : '定时任务：\n' + lines.join('\n') + '\n用法：/task <id> 立刻执行一次')
    return
  }
  if (id === 'checkin' && ctx.proactive !== undefined) {
    await reply('▶ 立刻叫醒她一次（主动聊天）')
    await ctx.proactive.fireNow()
    return
  }
  const prompt = prompts.find(p => p.id === id)
  if (prompt === undefined || ctx.fireScheduled === undefined) {
    await reply('没有叫 ' + id + ' 的定时任务。发 /task 查看列表。')
    return
  }
  await reply('▶ 立刻执行定时任务 ' + id)
  await ctx.fireScheduled(prompt)
}
