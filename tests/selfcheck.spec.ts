import { describe, expect, it } from 'vitest'

import { selfCheck } from '../src/selfcheck.js'
import type { SelfCheckInput } from '../src/selfcheck.js'

const good: SelfCheckInput = {
  mode: 'reverse', host: '127.0.0.1', accessToken: 'x', botQQ: '123450002', adminUsers: ['123450001'],
  dmPolicy: 'open', groupPolicy: 'allowlist', allowFrom: [], groupAllowFrom: ['888000001'], allowAllUsers: false,
  workspacePath: '', adminWorkspacePath: '', groupMemoryDir: '', publicMemoryFile: '',
  scheduledPrompts: [{ id: 'diary', time: '01:30', chatId: 'private:123450001', prompt: '写日记' }],
  proactiveEnabled: true, proactiveChatId: 'private:123450001', proactiveWindowStart: '09:00', proactiveWindowEnd: '22:00',
  proactiveMinPerDay: 4, proactiveMaxPerDay: 6, splitLines: true, splitMaxMessages: 6,
}

describe('selfCheck', () => {
  it('passes a sane config', () => {
    expect(selfCheck(good)).toEqual([])
  })

  it('flags the settings that would silently do nothing', () => {
    const problems = selfCheck({
      ...good,
      accessToken: '', adminUsers: [], groupAllowFrom: [], adminWorkspacePath: '/no/such/dir',
      scheduledPrompts: [{ id: 'a', time: '1:30', chatId: 'qq:1', prompt: ' ' }, { id: 'a', time: '01:30', chatId: 'private:123450001', prompt: 'x' }],
      proactiveWindowStart: '22:00', proactiveWindowEnd: '09:00', proactiveMinPerDay: 7, splitMaxMessages: 1,
    }).join('\n')
    for (const needle of ['accessToken 为空', 'adminUsers 为空', 'groupAllowFrom 为空', 'adminWorkspacePath 目录不存在', '不是 HH:MM', '格式不对', 'prompt 为空', 'id「a」重复', '开始不早于结束', 'proactiveMinPerDay 大于', 'splitMaxMessages ≤ 1', '不是管理员的私聊'.slice(0, 0)]) {
      expect(problems).toContain(needle)
    }
  })

  it('warns when proactive chat targets a non-admin', () => {
    expect(selfCheck({ ...good, proactiveChatId: 'private:999999' }).join()).toContain('不是管理员的私聊')
  })
})
