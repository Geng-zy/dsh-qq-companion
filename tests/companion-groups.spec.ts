/**
 * runtime group allowlist, owner-only auto-accept, /group.
 * @module dsh-qq-companion/tests/companion-groups
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { GROUP_ALLOWLIST_FILE, GroupAccess, handleGroupCommand, handleGroupEvent } from '../src/groups.js'
import type { GroupEventDeps } from '../src/groups.js'

function makeAccess(configured: string[] = ['111111'], dir = mkdtempSync(join(tmpdir(), 'companion-groups-'))) {
  const policy = { groupAllowFrom: configured as readonly string[], groupPolicy: 'allowlist' as const }
  const access = new GroupAccess({ policy, mediaDir: dir, log: () => undefined })
  return { policy, access, dir }
}

describe('GroupAccess', () => {
  it('allow/remove update the live policy list and persist across a reload', async () => {
    const { policy, access, dir } = makeAccess()
    await access.load()
    expect(policy.groupAllowFrom).toEqual(['111111'])

    expect(await access.allow('222222')).toBe('added')
    expect(policy.groupAllowFrom).toEqual(['111111', '222222'])
    expect(await access.allow('222222')).toBe('already')

    expect(await access.remove('111111')).toBe('removed')
    expect(policy.groupAllowFrom).toEqual(['222222'])
    expect(await access.remove('333333')).toBe('absent')

    // A fresh instance (restart) over the same dir restores the runtime layer.
    const again = makeAccess(['111111'], dir)
    await again.access.load()
    expect(again.policy.groupAllowFrom).toEqual(['222222'])
    expect(JSON.parse(readFileSync(join(dir, GROUP_ALLOWLIST_FILE), 'utf8'))).toEqual({ added: ['222222'], removed: ['111111'] })

    // Re-allowing a configured group clears its removal.
    await again.access.allow('111111')
    expect(again.policy.groupAllowFrom).toEqual(['111111', '222222'])
  })

  it('a corrupt file keeps the configured list only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-groups-'))
    writeFileSync(join(dir, GROUP_ALLOWLIST_FILE), '{not json')
    const { policy, access } = makeAccess(['111111'], dir)
    await access.load()
    expect(policy.groupAllowFrom).toEqual(['111111'])
  })
})

function makeDeps(overrides: Partial<GroupEventDeps> = {}) {
  const { access, policy } = makeAccess([])
  const calls: Array<{ action: string; params: Record<string, unknown> }> = []
  const notices: string[] = []
  const deps: GroupEventDeps = {
    adminUsers: () => ['123450001'],
    selfId: () => '123450002',
    access,
    call: async (action, params) => { calls.push({ action, params }); return {} },
    notifyAdmins: async text => { notices.push(text) },
    config: { autoAcceptAdminRequests: true, autoAllowInvitedGroups: true },
    log: () => undefined,
    ...overrides,
  }
  return { deps, calls, notices, policy }
}

describe('handleGroupEvent', () => {
  it('approves an admin invite and allowlists the group', async () => {
    const { deps, calls, notices, policy } = makeDeps()
    await handleGroupEvent({ post_type: 'request', request_type: 'group', sub_type: 'invite', user_id: 123450001, group_id: 888000001, flag: 'F1' } as never, deps)
    expect(calls).toEqual([{ action: 'set_group_add_request', params: { flag: 'F1', sub_type: 'invite', approve: true } }])
    expect(policy.groupAllowFrom).toEqual(['888000001'])
    expect(notices[0]).toContain('888000001')
  })

  it('never approves an invite from anyone else, and tells the admin', async () => {
    const { deps, calls, notices, policy } = makeDeps()
    await handleGroupEvent({ post_type: 'request', request_type: 'group', sub_type: 'invite', user_id: 123456, group_id: 999999, flag: 'F2' } as never, deps)
    expect(calls).toEqual([])
    expect(policy.groupAllowFrom).toEqual([])
    expect(notices[0]).toContain('不是管理员邀请的')
  })

  it('approves an admin friend request only', async () => {
    const { deps, calls, notices } = makeDeps()
    await handleGroupEvent({ post_type: 'request', request_type: 'friend', user_id: 123450001, flag: 'F3' } as never, deps)
    await handleGroupEvent({ post_type: 'request', request_type: 'friend', user_id: 555555, flag: 'F4', comment: '你好' } as never, deps)
    expect(calls).toEqual([{ action: 'set_friend_add_request', params: { flag: 'F3', approve: true } }])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('555555')
  })

  it('does nothing automatic when the switches are off', async () => {
    const { deps, calls, policy } = makeDeps({ config: { autoAcceptAdminRequests: false, autoAllowInvitedGroups: false } })
    await handleGroupEvent({ post_type: 'request', request_type: 'group', sub_type: 'invite', user_id: 123450001, group_id: 888000001, flag: 'F5' } as never, deps)
    expect(calls).toEqual([])
    expect(policy.groupAllowFrom).toEqual([])
  })

  it('allowlists a group the admin added the bot to directly (join notice)', async () => {
    const { deps, notices, policy } = makeDeps()
    await handleGroupEvent({ post_type: 'notice', notice_type: 'group_increase', sub_type: 'invite', user_id: 123450002, operator_id: 123450001, group_id: 777777 } as never, deps)
    expect(policy.groupAllowFrom).toEqual(['777777'])
    expect(notices).toHaveLength(1)
    // Someone else joining is not about us.
    expect(await handleGroupEvent({ post_type: 'notice', notice_type: 'group_increase', user_id: 1234567, operator_id: 123450001, group_id: 777777 } as never, deps)).toBe(false)
  })

  it('being kicked removes the group from the allowlist; an admin re-invite adds it back', async () => {
    const { deps, calls, notices, policy } = makeDeps()
    await deps.access.allow('888000001')
    await handleGroupEvent({ post_type: 'notice', notice_type: 'group_decrease', sub_type: 'kick_me', user_id: 123450002, operator_id: 99999, group_id: 888000001 } as never, deps)
    expect(policy.groupAllowFrom).toEqual([])
    expect(notices.at(-1)).toContain('已经从白名单里删掉')

    await handleGroupEvent({ post_type: 'request', request_type: 'group', sub_type: 'invite', user_id: 123450001, group_id: 888000001, flag: 'R1' } as never, deps)
    expect(calls.at(-1)).toEqual({ action: 'set_group_add_request', params: { flag: 'R1', sub_type: 'invite', approve: true } })
    expect(policy.groupAllowFrom).toEqual(['888000001'])
  })

  it('a kick from a base-list group overrides the configured entry until re-invited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-groups-'))
    const policy = { groupAllowFrom: ['888000001'] as readonly string[], groupPolicy: 'allowlist' as const }
    const access = new GroupAccess({ policy, mediaDir: dir, log: () => undefined })
    await access.load()
    const { deps } = makeDeps({ access })
    await handleGroupEvent({ post_type: 'notice', notice_type: 'group_decrease', sub_type: 'kick_me', user_id: 123450002, group_id: 888000001 } as never, deps)
    expect(policy.groupAllowFrom).toEqual([])
    await handleGroupEvent({ post_type: 'notice', notice_type: 'group_increase', user_id: 123450002, operator_id: 123450001, group_id: 888000001 } as never, deps)
    expect(policy.groupAllowFrom).toEqual(['888000001'])
  })

  it('a non-admin pulling the bot in does not allowlist the group', async () => {
    const { deps, notices, policy } = makeDeps()
    await handleGroupEvent({ post_type: 'notice', notice_type: 'group_increase', user_id: 123450002, operator_id: 4444444, group_id: 888888 } as never, deps)
    expect(policy.groupAllowFrom).toEqual([])
    expect(notices[0]).toContain('不在白名单')
  })
})

describe('/group command', () => {
  it('lists, allows and removes groups (English and Chinese verbs)', async () => {
    const { access } = makeAccess(['111111'])
    await access.load()
    const replies: string[] = []
    const reply = vi.fn(async (text: string) => { replies.push(text) })
    await handleGroupCommand(access, '', reply)
    expect(replies.at(-1)).toContain('111111')
    await handleGroupCommand(access, '允许 222222', reply)
    expect(replies.at(-1)).toContain('已允许群 222222')
    await handleGroupCommand(access, 'remove 111111', reply)
    expect(replies.at(-1)).toContain('已把群 111111 移出白名单')
    await handleGroupCommand(access, 'list', reply)
    expect(replies.at(-1)).toContain('群白名单（1 个）：222222')
    await handleGroupCommand(access, 'allow abc', reply)
    expect(replies.at(-1)).toContain('群号不对')
  })
})
