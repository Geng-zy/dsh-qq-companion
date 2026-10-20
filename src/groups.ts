/**
 * runtime group allowlist + owner-only auto-accept.
 *
 * - GroupAccess: the effective group allowlist is the configured
 *   groupAllowFrom plus groups added at runtime (/group allow, or an admin's
 *   invite) minus groups removed at runtime (/group remove). Runtime changes
 *   persist in mediaDir/group-allowlist.json and survive restarts; the
 *   policy object's groupAllowFrom is replaced in place, so every policy
 *   check (inbound gate) sees the change immediately.
 * - handleGroupEvent: OneBot request/notice events. Friend requests and
 *   group invites from an admin are approved (config.autoAcceptAdminRequests);
 *   a group an admin pulled the bot into is allowlisted
 *   (config.autoAllowInvitedGroups). Everything from anyone else is left
 *   pending and reported to the admins — never approved. Being kicked out
 *   of (or leaving) a group removes it from the allowlist; a later admin
 *   invite approves and re-allowlists it.
 * @module dsh-qq-companion/groups
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { SerialFileWriter } from './persist.js'

import type { AccessPolicyConfig } from './chat.js'
import type { OneBotEvent } from './connection.js'
import { describeError } from './errors.js'

/** Runtime allowlist file name, under mediaDir. */
export const GROUP_ALLOWLIST_FILE = 'group-allowlist.json'

interface PersistedGroups {
  added: string[]
  removed: string[]
}

/** A snapshot of the allowlist layers, for /group list. */
export interface GroupAccessSnapshot {
  configured: string[]
  added: string[]
  removed: string[]
  effective: string[]
  groupPolicy: AccessPolicyConfig['groupPolicy']
}

/** The /group command's view of GroupAccess. */
export interface GroupAccessLike {
  snapshot(): GroupAccessSnapshot
  allow(groupId: string): Promise<'added' | 'already'>
  remove(groupId: string): Promise<'removed' | 'absent'>
}

/** True for a plausible QQ group number. */
export function isGroupId(value: string): boolean {
  return /^\d{5,12}$/.test(value)
}

export class GroupAccess implements GroupAccessLike {
  private readonly policy: { groupAllowFrom: readonly string[]; groupPolicy: AccessPolicyConfig['groupPolicy'] }
  private readonly configured: string[]
  private readonly file: string
  private readonly log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void
  private added: string[] = []
  private removed: string[] = []
  private readonly writer: SerialFileWriter
  /** Called after a group leaves the effective allowlist. */
  onRemoved: ((groupId: string) => Promise<void>) | undefined

  constructor(options: {
    policy: { groupAllowFrom: readonly string[]; groupPolicy: AccessPolicyConfig['groupPolicy'] }
    mediaDir: string
    log: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void
  }) {
    this.policy = options.policy
    this.configured = [...options.policy.groupAllowFrom].map(String)
    this.file = join(options.mediaDir, GROUP_ALLOWLIST_FILE)
    this.log = options.log
    this.writer = new SerialFileWriter(this.file, { label: '群白名单', log: (level, message) => this.log(level, message) })
  }

  /** Load the persisted runtime layer (missing file = none; corrupt file =
   * warn and keep the configured list only). */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<PersistedGroups>
      this.added = (Array.isArray(raw.added) ? raw.added : []).map(String).filter(isGroupId)
      this.removed = (Array.isArray(raw.removed) ? raw.removed : []).map(String).filter(isGroupId)
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.log('warn', '群白名单文件读取失败，只使用配置里的白名单: ' + describeError(error))
      }
    }
    this.apply()
  }

  snapshot(): GroupAccessSnapshot {
    return {
      configured: [...this.configured],
      added: [...this.added],
      removed: [...this.removed],
      effective: [...this.policy.groupAllowFrom],
      groupPolicy: this.policy.groupPolicy,
    }
  }

  async allow(groupId: string): Promise<'added' | 'already'> {
    const already = this.policy.groupAllowFrom.includes(groupId)
    this.removed = this.removed.filter(g => g !== groupId)
    if (!this.configured.includes(groupId) && !this.added.includes(groupId)) this.added.push(groupId)
    this.apply()
    await this.save()
    return already ? 'already' : 'added'
  }

  async remove(groupId: string): Promise<'removed' | 'absent'> {
    const present = this.policy.groupAllowFrom.includes(groupId)
    this.added = this.added.filter(g => g !== groupId)
    if (this.configured.includes(groupId) && !this.removed.includes(groupId)) this.removed.push(groupId)
    this.apply()
    await this.save()
    if (present && this.onRemoved !== undefined) {
      try {
        await this.onRemoved(groupId)
      } catch (error) {
        this.log('warn', '群 ' + groupId + ' 的旧会话退休失败: ' + describeError(error))
      }
    }
    return present ? 'removed' : 'absent'
  }

  /** Replace the policy's list in place: configured ∪ added − removed. */
  private apply(): void {
    const effective = [...new Set([...this.configured, ...this.added])].filter(g => !this.removed.includes(g))
    ;(this.policy as { groupAllowFrom: readonly string[] }).groupAllowFrom = effective
  }

  private save(): Promise<void> {
    return this.writer.write(() => JSON.stringify({ added: this.added, removed: this.removed } satisfies PersistedGroups, null, 2) + '\n')
  }

}

/** What handleGroupEvent touches. */
export interface GroupEventDeps {
  adminUsers(): readonly string[]
  selfId(): string
  access: GroupAccessLike
  /** Raw OneBot action call (set_friend_add_request / set_group_add_request). */
  call(action: string, params: Record<string, unknown>): Promise<unknown>
  /** Tell every admin something in private chat (best-effort). */
  notifyAdmins(text: string): Promise<void>
  config: { autoAcceptAdminRequests: boolean; autoAllowInvitedGroups: boolean; ownerTitle?: string }
  log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void
}

const str = (value: unknown): string => (value === undefined || value === null ? '' : String(value))

/**
 * Handle one OneBot request/notice event. Returns true when it was acted on
 * (approved, allowlisted or reported), false when it is not ours.
 */
export async function handleGroupEvent(event: OneBotEvent, deps: GroupEventDeps): Promise<boolean> {
  const e = event as OneBotEvent & Record<string, unknown>
  const isAdmin = (id: string): boolean => id !== '' && deps.adminUsers().includes(id)
  const owner = deps.config.ownerTitle ?? '管理员'

  if (e.post_type === 'request' && e.request_type === 'friend') {
    const userId = str(e.user_id)
    if (isAdmin(userId) && deps.config.autoAcceptAdminRequests) {
      await deps.call('set_friend_add_request', { flag: str(e.flag), approve: true })
      deps.log('info', '已自动同意管理员的好友申请: ' + userId)
      return true
    }
    await deps.notifyAdmins('有人加我好友：QQ ' + userId + (str(e.comment) !== '' ? '（验证消息：' + str(e.comment).slice(0, 60) + '）' : '') + '\n我没同意 要同意的话请在小号手机上操作')
    return true
  }

  if (e.post_type === 'request' && e.request_type === 'group' && e.sub_type === 'invite') {
    const inviter = str(e.user_id)
    const groupId = str(e.group_id)
    if (isAdmin(inviter) && deps.config.autoAcceptAdminRequests) {
      await deps.call('set_group_add_request', { flag: str(e.flag), sub_type: 'invite', approve: true })
      deps.log('info', '已自动同意管理员的进群邀请: group ' + groupId)
      if (deps.config.autoAllowInvitedGroups && isGroupId(groupId)) {
        await deps.access.allow(groupId)
        await deps.notifyAdmins('收到' + owner + '的邀请 已经进群 ' + groupId + ' 啦\n也加进白名单了 在群里 @我 就能聊')
      } else {
        await deps.notifyAdmins('收到' + owner + '的邀请 已经进群 ' + groupId + ' 啦\n这个群还不在白名单里 发 /group allow ' + groupId + ' 我才会说话')
      }
      return true
    }
    await deps.notifyAdmins('QQ ' + inviter + ' 邀请我进群 ' + groupId + '\n不是' + owner + '邀请的 我没同意')
    return true
  }

  // A small group or a friend's invite can add the bot directly (no request
  // event): the join notice names the inviter as operator_id.
  if (e.post_type === 'notice' && e.notice_type === 'group_increase' && str(e.user_id) === deps.selfId()) {
    const groupId = str(e.group_id)
    const operator = str(e.operator_id)
    if (isAdmin(operator) && deps.config.autoAllowInvitedGroups && isGroupId(groupId)) {
      const result = await deps.access.allow(groupId)
      if (result === 'added') await deps.notifyAdmins(owner + '把我拉进群 ' + groupId + ' 啦\n已经加进白名单 在群里 @我 就能聊')
      return true
    }
    if (!isAdmin(operator)) {
      await deps.notifyAdmins('我被拉进了群 ' + groupId + (operator !== '' && operator !== '0' ? '（邀请人 QQ ' + operator + '）' : '') + '\n这个群不在白名单里的话 我不会说话')
      return true
    }
    return false
  }

  // Kicked out of (or left) a group: drop it from the allowlist, so it is
  // only spoken in again after a fresh admin invite re-allowlists it.
  if (e.post_type === 'notice' && e.notice_type === 'group_decrease' && str(e.user_id) === deps.selfId()) {
    const groupId = str(e.group_id)
    const result = isGroupId(groupId) ? await deps.access.remove(groupId) : 'absent'
    const head = e.sub_type === 'kick_me' ? '呜 我被踢出群 ' + groupId + ' 了' : '我已经不在群 ' + groupId + ' 了'
    await deps.notifyAdmins(result === 'removed' ? head + '\n已经从白名单里删掉 ' + owner + '再拉我进去就会自动加回来' : head)
    return true
  }

  return false
}

/** /group usage line. */
export const GROUP_USAGE = '用法：/group [list] 查看白名单；/group allow <群号> 允许在这个群说话；/group remove <群号> 移出白名单（也可以写 允许 / 移除 / 列表）'

/** /group command body. */
export async function handleGroupCommand(
  access: GroupAccessLike | undefined,
  arg: string,
  reply: (text: string) => Promise<unknown>,
): Promise<void> {
  if (access === undefined) {
    await reply('群白名单管理未启用。')
    return
  }
  const [rawVerb = '', target = ''] = arg.trim().split(/\s+/)
  const verb = rawVerb.toLowerCase()
  if (verb === '' || verb === 'list' || verb === 'ls' || verb === '列表') {
    const s = access.snapshot()
    const lines = [
      '群白名单（' + s.effective.length + ' 个）：' + (s.effective.length > 0 ? s.effective.join('、') : '（空）'),
      '· 配置文件里的：' + (s.configured.length > 0 ? s.configured.join('、') : '无'),
      '· 后来允许的：' + (s.added.length > 0 ? s.added.join('、') : '无'),
    ]
    if (s.removed.length > 0) lines.push('· 后来移除的：' + s.removed.join('、'))
    if (s.groupPolicy !== 'allowlist') lines.push('注意：当前群聊策略是 ' + s.groupPolicy + '，白名单不生效')
    lines.push(GROUP_USAGE)
    await reply(lines.join('\n'))
    return
  }
  if (!isGroupId(target)) {
    await reply('群号不对：' + (target === '' ? '（没写群号）' : target) + '\n' + GROUP_USAGE)
    return
  }
  if (verb === 'allow' || verb === 'add' || verb === '允许' || verb === '添加') {
    const result = await access.allow(target)
    await reply(result === 'added' ? '✅ 已允许群 ' + target + '，在群里 @我 就能聊' : '群 ' + target + ' 本来就在白名单里')
    return
  }
  if (verb === 'remove' || verb === 'rm' || verb === 'del' || verb === '移除' || verb === '删除') {
    const result = await access.remove(target)
    await reply(result === 'removed' ? '✅ 已把群 ' + target + ' 移出白名单，我在那里不会再说话' : '群 ' + target + ' 本来就不在白名单里')
    return
  }
  await reply('不认识的操作：' + rawVerb + '\n' + GROUP_USAGE)
}
