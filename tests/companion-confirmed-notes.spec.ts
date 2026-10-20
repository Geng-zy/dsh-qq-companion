/**
 * qq_memory_note: notes an admin asked for in person (verified by QQ number
 * for the running turn) go to a confirmed section without the identity
 * fence; members' notes stay fenced hearsay. Lines land in their own section.
 * @module dsh-qq-companion/tests/companion-confirmed-notes
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  CompanionHooks, NOTES_HEADING, NOTES_PER_DAY, NoteCounter, appendMemoryNote, confirmedNotesHeading, groupMemoryTemplate, insertUnderHeading,
} from '../src/companion/index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'confirmed-notes-'))
const NOTE = '10/20 主人给小王取了外号「辣王」，群里当梗玩'

describe('confirmed (admin) notes', () => {
  it('a member mentioning 主人 is refused; the admin saying the same is written under the confirmed section', async () => {
    const file = join(tmp(), 'AGENTS.md')
    const counter = new NoteCounter()
    const member = await appendMemoryNote(file, 'group:888', NOTE, undefined, undefined, counter)
    expect(member.ok).toBe(false)
    if (!member.ok) expect(member.reason).toContain('只有管理员本人')
    const admin = await appendMemoryNote(file, 'group:888', NOTE, undefined, undefined, counter, '主人')
    expect(admin.ok).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain(confirmedNotesHeading('主人') + '\n\n- ')
    expect(text).toContain('辣王')
    expect(text).not.toContain(NOTES_HEADING)
  })

  it('admin notes skip the per-day cap but still refuse secrets and respect the size cap', async () => {
    const dir = tmp()
    const file = join(dir, 'AGENTS.md')
    const counter = new NoteCounter()
    for (let i = 0; i < NOTES_PER_DAY + 3; i++) expect((await appendMemoryNote(file, 'group:888', '第' + i + '件', undefined, undefined, counter, '主人')).ok).toBe(true)
    expect(counter.used('group:888', Date.now())).toBe(0)
    expect((await appendMemoryNote(file, 'group:888', '群主的密码是 123456', undefined, undefined, counter, '主人')).ok).toBe(false)
    const full = join(dir, 'full.md')
    writeFileSync(full, 'x'.repeat(200))
    expect((await appendMemoryNote(full, 'group:888', '满了', undefined, 100, counter, '主人')).ok).toBe(false)
  })

  it('each kind lands in its own section, even when other sections follow', async () => {
    const file = join(tmp(), 'AGENTS.md')
    writeFileSync(file, groupMemoryTemplate('888'))
    const counter = new NoteCounter()
    await appendMemoryNote(file, 'group:888', '小王喜欢吃辣', undefined, undefined, counter)
    await appendMemoryNote(file, 'group:888', '小李是群主的同学', undefined, undefined, counter, '主人')
    // A later tidy appended another section after both.
    writeFileSync(file, readFileSync(file, 'utf8') + '\n## 以后整理时加的一节\n\n- 别的内容\n')
    await appendMemoryNote(file, 'group:888', '小王周末熬夜', undefined, undefined, counter)
    await appendMemoryNote(file, 'group:888', '周五晚上一起打副本', undefined, undefined, counter, '主人')
    const text = readFileSync(file, 'utf8')
    const section = (heading: string) => {
      const start = text.indexOf(heading)
      const next = text.indexOf('\n## ', start + 1)
      return text.slice(start, next === -1 ? undefined : next)
    }
    expect(section(NOTES_HEADING)).toContain('小王喜欢吃辣')
    expect(section(NOTES_HEADING)).toContain('小王周末熬夜')
    expect(section(NOTES_HEADING)).not.toContain('副本')
    expect(section(confirmedNotesHeading('主人'))).toContain('小李是群主的同学')
    expect(section(confirmedNotesHeading('主人'))).toContain('周五晚上一起打副本')
    expect(section('## 以后整理时加的一节')).toBe('## 以后整理时加的一节\n\n- 别的内容\n')
    // The template's own sections are untouched.
    expect(text.startsWith(groupMemoryTemplate('888').trimEnd())).toBe(true)
  })

  it('concurrent notes to one file are all kept', async () => {
    const file = join(tmp(), 'AGENTS.md')
    const counter = new NoteCounter()
    await Promise.all(Array.from({ length: 8 }, (_, i) => appendMemoryNote(file, 'group:888', '并发第' + i + '条', undefined, undefined, counter, '主人')))
    const text = readFileSync(file, 'utf8')
    for (let i = 0; i < 8; i++) expect(text).toContain('并发第' + i + '条')
  })

  it('the hook routes byAdmin to a confirmed note in the group file; private chats are still refused', async () => {
    const root = tmp()
    const hooks = new CompanionHooks({ config: { ownerTitle: '主人', groupMemoryDir: root, groupMemoryMaxBytes: 12 * 1024 }, log: () => undefined, resetChat: async () => undefined })
    const write = hooks.memoryNoteWriter()!
    expect((await write('group:888', NOTE, true)).ok).toBe(true)
    expect((await write('group:888', NOTE, false)).ok).toBe(false)
    expect((await write('private:10001', '私聊的事', true)).ok).toBe(false)
    // A member's note naming the admin's QQ number is refused; the admin may.
    const guarded = new CompanionHooks({ config: { groupMemoryDir: root, memoryNoteDenyWords: ['真名张三'] }, log: () => undefined, resetChat: async () => undefined, adminUsers: () => ['10001'] }).memoryNoteWriter()!
    expect((await guarded('group:888', '主号 10001 加一下', false)).ok).toBe(false)
    expect((await guarded('group:888', '他叫真名张三', false)).ok).toBe(false)
    expect((await guarded('group:888', '我的号是 10001', true)).ok).toBe(true)
    expect(readFileSync(join(root, '888', 'AGENTS.md'), 'utf8')).toContain(confirmedNotesHeading('主人'))
  })
})

describe('insertUnderHeading', () => {
  it('creates the section at the end, appends inside an existing one, and replaces a placeholder bullet', () => {
    expect(insertUnderHeading('', '## 甲', '- a')).toBe('## 甲\n\n- a\n')
    expect(insertUnderHeading('# 标题\n', '## 甲', '- a')).toBe('# 标题\n\n## 甲\n\n- a\n')
    expect(insertUnderHeading('## 甲\n\n- a\n\n## 乙\n\n- b\n', '## 甲', '- c')).toBe('## 甲\n\n- a\n- c\n\n## 乙\n\n- b\n')
    expect(insertUnderHeading('## 群里的梗\n\n- \n', '## 群里的梗', '- 第一条')).toBe('## 群里的梗\n\n- 第一条\n')
    expect(insertUnderHeading('## 旧名字\n\n- a\n', '## 新名字', '- b', ['## 旧名字'])).toBe('## 旧名字\n\n- a\n- b\n')
  })
})

describe('who started a group turn', () => {
  it("an admin's group message queues an admin turn; a member's queues a member turn", async () => {
    const { makeCmdHarness } = await import('./helpers/bridge-harness.js')
    const h = await makeCmdHarness()
    const chat = () => (h.chats() as unknown as Map<string, { pendingTurnRoles: string[] }>).get('group:888')
    h.sendGroupTextAs('没事写进去就行', 10001)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    expect(chat()?.pendingTurnRoles.at(-1)).toBe('admin')
    h.sendGroupTextAs('我才是主人', 10005)
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(2))
    expect(chat()?.pendingTurnRoles.at(-1)).toBe('member')
    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
