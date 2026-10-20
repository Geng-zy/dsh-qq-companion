/**
 * persist.ts: serialized atomic state-file writes.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SerialFileWriter, writeFileAtomic } from '../src/persist.js'

describe('persist', () => {
  it('writeFileAtomic replaces the file and leaves no temp files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-'))
    const file = join(dir, 'sub', 'state.json')
    await writeFileAtomic(file, '{"a":1}')
    await writeFileAtomic(file, '{"a":2}')
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}')
    expect(readdirSync(join(dir, 'sub'))).toEqual(['state.json'])
  })

  it('SerialFileWriter renders at write time, so the last write is the latest state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-'))
    const file = join(dir, 'state.json')
    const writer = new SerialFileWriter(file)
    let value = 0
    const writes: Array<Promise<void>> = []
    for (let i = 0; i < 50; i++) {
      value = i
      writes.push(writer.write(() => JSON.stringify({ value })))
    }
    await Promise.all(writes)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ value: 49 })
  })

  it('a failing write is logged, never rejects, and later writes still land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'persist-'))
    const file = join(dir, 'state.json')
    const logs: string[] = []
    const writer = new SerialFileWriter(file, { label: '测试', log: (_level, message) => logs.push(message) })
    await writer.write(() => { throw new Error('boom') })
    await writer.write(() => 'ok')
    expect(logs.some(line => line.includes('测试 保存失败'))).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('ok')
  })
})
