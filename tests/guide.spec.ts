/**
 * The companion guide: written from the config, tailored per chat — a group
 * never hears about the owner's private memory or diary.
 * @module dsh-qq-companion/tests/guide
 */
import { describe, expect, it } from 'vitest'

import { buildCompanionGuide, type CompanionGuideConfig } from '../src/companion/index.js'

const config: CompanionGuideConfig = {
  ownerTitle: '主人', adminUsers: ['10001'],
  publicMemoryFile: '/m/AGENTS.md', publicMemoryMaxBytes: 16384,
  adminWorkspacePath: '/m/private', privateMemoryMaxBytes: 24576,
  groupMemoryDir: '/m/groups', groupMemoryMaxBytes: 10240,
  privateResetDays: 5, groupResetDays: 1, idleResetHours: 168,
  groupContextLines: 15, groupNameTriggers: ['大肥鱼', '肥鱼'], groupFollowupSeconds: 180, groupPeekEnabled: true,
  proactiveEnabled: true, proactiveWindowStart: '09:00', proactiveWindowEnd: '22:00', proactiveMaxUnanswered: 2,
  stickerDir: '/m/stickers', diaryTime: '01:30',
}

describe('buildCompanionGuide', () => {
  it('the owner chat: identity, every memory file with its limit, diary, check-ins, sticker editing', () => {
    const g = buildCompanionGuide(config, 'owner')
    expect(g).toContain('QQ 号是 10001')
    expect(g).toContain('/m/private/AGENTS.md')
    expect(g).toContain('24KB')
    expect(g).toContain('16KB')
    expect(g).toContain('/m/private/diary/')
    expect(g).toContain('01:30')
    expect(g).toContain('09:00–22:00')
    expect(g).toContain('私聊每 5 天')
    expect(g).toContain('qq_sticker_delete')
    expect(g).not.toContain('[叫到我]')
  })

  it('a group: triggers from the config, group memory rules, nothing private', () => {
    const g = buildCompanionGuide(config, 'group')
    expect(g).toContain('大肥鱼、肥鱼')
    expect(g).toContain('3 分钟')
    expect(g).toContain('[看一眼群聊')
    expect(g).toContain('[不发]')
    expect(g).toContain('qq_memory_note')
    expect(g).toContain('群聊每天')
    expect(g).not.toContain('/m/private')
    expect(g).not.toContain('diary')
    expect(g).not.toContain('主动聊天的机会')
    expect(g).not.toContain('qq_sticker_delete')
  })

  it('switched-off features are not mentioned', () => {
    const g = buildCompanionGuide({ ...config, groupNameTriggers: [], groupFollowupSeconds: 0, groupPeekEnabled: false, stickerDir: '' }, 'group')
    expect(g).not.toContain('[叫到我]')
    expect(g).not.toContain('[接着和我说]')
    expect(g).not.toContain('看一眼')
    expect(g).not.toContain('表情包库')
  })
})
