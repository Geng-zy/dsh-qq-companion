/**
 * Voice transcription with fake ffmpeg / engine programs on PATH (no real
 * models needed): engine selection, output parsing and cleanup, limits,
 * SILK detection, timeouts, the queue cap and temp-dir cleanup.
 * @module dsh-qq-companion/tests/stt
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { recordResult } from '../src/inbound.js'
import { MAX_QUEUE, Transcriber, applyReplacements, cleanTranscript, parseSherpaOutput, transcriptLabel, type SttConfig } from '../src/stt.js'

afterEach(() => { vi.unstubAllEnvs() })

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p))

async function program(dir: string, name: string, body: string): Promise<void> {
  await writeFile(join(dir, name), '#!/bin/sh\n' + body + '\n')
  await chmod(join(dir, name), 0o755)
}

/** A PATH with a fake ffmpeg (copies input → the last argument). */
async function fakeTools(extra: Record<string, string> = {}): Promise<string> {
  const bin = tmp('stt-bin-')
  await program(bin, 'ffmpeg', 'in=""; prev=""; for a in "$@"; do [ "$prev" = "-i" ] && in="$a"; prev="$a"; last="$a"; done; cp "$in" "$last"')
  for (const [name, body] of Object.entries(extra)) await program(bin, name, body)
  vi.stubEnv('PATH', bin + ':/usr/bin:/bin')
  vi.stubEnv('HOME', tmp('stt-home-'))
  return bin
}

function voice(content = 'ID3 fake mp3 bytes'): string {
  const dir = tmp('stt-media-')
  const file = join(dir, 'media_1.mp3')
  writeFileSync(file, content)
  return file
}

const base: SttConfig = { enabled: true, engine: 'auto', command: '', args: [], model: '', language: 'zh', timeoutMs: 5_000, maxSeconds: 60 }

describe('engines', () => {
  it('the fix-up table corrects the transcript before she sees it', async () => {
    await fakeTools({ 'sherpa-onnx-offline': 'echo "{\\"text\\": \\"<|zh|>大飞鱼你在做什么\\"}"' })
    const dir = tmp('stt-sv-')
    writeFileSync(join(dir, 'tokens.txt'), 'x')
    writeFileSync(join(dir, 'model.int8.onnx'), 'x')
    const t = new Transcriber({ ...base, engine: 'sherpa-onnx', model: dir, replacements: { 大飞鱼: '大肥鱼' } })
    expect(await t.transcribe(voice())).toBe('大肥鱼你在做什么')
  })

  it('whisper-cpp: runs whisper-cli with the model and language, and cleans the output', async () => {
    await fakeTools({ 'whisper-cli': 'echo "  今天吃什么 [BLANK_AUDIO] "; echo "$@" > "$(dirname "$0")/args"' })
    const model = join(tmp('stt-model-'), 'ggml-small.bin')
    writeFileSync(model, 'x')
    const t = new Transcriber({ ...base, engine: 'whisper-cpp', model })
    expect(await t.transcribe(voice())).toBe('今天吃什么')
    expect(await t.engineDescription()).toContain('whisper-cpp')
  })

  it('sherpa-onnx: finds the SenseVoice model dir and parses the JSON result line', async () => {
    await fakeTools({ 'sherpa-onnx-offline': 'echo "loading model" >&2; echo "{\\"lang\\": \\"<|zh|>\\", \\"text\\": \\"<|zh|><|NEUTRAL|><|Speech|>主人早上好\\"}" >&2' })
    const dir = tmp('stt-sv-')
    writeFileSync(join(dir, 'tokens.txt'), 'x')
    writeFileSync(join(dir, 'model.int8.onnx'), 'x')
    const t = new Transcriber({ ...base, engine: 'sherpa-onnx', model: dir })
    expect(await t.transcribe(voice())).toBe('主人早上好')
  })

  it('auto prefers sherpa-onnx with a model in the default place, else whisper-cpp', async () => {
    const bin = await fakeTools({ 'whisper-cli': 'echo whisper', 'sherpa-onnx-offline': 'echo "{\\"text\\": \\"sense\\"}"' })
    const home = process.env.HOME!
    expect(await new Transcriber({ ...base, model: '' }).transcribe(voice()).catch(e => String(e))).toMatch(/没有可用的语音识别引擎/)
    await mkdir(join(home, '.cache', 'whisper.cpp'), { recursive: true })
    writeFileSync(join(home, '.cache', 'whisper.cpp', 'ggml-small.bin'), 'x')
    expect(await new Transcriber({ ...base }).transcribe(voice())).toBe('whisper')
    const sv = join(home, '.cache', 'sherpa-onnx', 'sense-voice')
    await mkdir(sv, { recursive: true })
    writeFileSync(join(sv, 'tokens.txt'), 'x')
    writeFileSync(join(sv, 'model.onnx'), 'x')
    expect(await new Transcriber({ ...base }).transcribe(voice())).toBe('sense')
    expect(bin).toBeTruthy()
  })

  it('command: substitutes the template and reads stdout; the old name "custom" still works', async () => {
    await fakeTools({ 'my-asr': 'echo "lang=$1 wav=$(basename "$2")"' })
    const t = new Transcriber({ ...base, engine: 'custom', command: 'my-asr', args: ['{lang}', '{wav}'] })
    expect(await t.transcribe(voice())).toBe('lang=zh wav=audio.wav')
  })
})

describe('limits and failures', () => {
  it('refuses SILK files with a clear reason, and an empty file transcribes to nothing', async () => {
    await fakeTools({ 'whisper-cli': 'echo x' })
    const t = new Transcriber({ ...base, engine: 'command', command: 'whisper-cli' })
    await expect(t.transcribe(voice('\u0002#!SILK_V3 raw'))).rejects.toThrow(/SILK/)
    expect(await t.transcribe(voice(''))).toBe('')
  })

  it('times out a hanging engine and always removes its temp dir', async () => {
    await fakeTools({ 'slow-asr': 'sleep 5' })
    const file = voice()
    const t = new Transcriber({ ...base, engine: 'command', command: 'slow-asr', timeoutMs: 300 })
    await expect(t.transcribe(file)).rejects.toThrow(/超时/)
    expect(readdirSync(join(file, '..')).filter(n => n.startsWith('stt_'))).toEqual([])
  })

  it('runs one at a time and refuses beyond the queue cap', async () => {
    await fakeTools({ 'asr': 'sleep 0.2; echo ok' })
    const t = new Transcriber({ ...base, engine: 'command', command: 'asr' })
    const runs = Array.from({ length: MAX_QUEUE + 2 }, () => t.transcribe(voice()).catch(e => String(e)))
    const results = await Promise.all(runs)
    expect(results.filter(r => r === 'ok')).toHaveLength(MAX_QUEUE)
    expect(results.filter(r => /排队已满/.test(r))).toHaveLength(2)
  })

  it('a missing ffmpeg or program is a clear error', async () => {
    vi.stubEnv('PATH', tmp('stt-empty-'))
    await expect(new Transcriber({ ...base, engine: 'command', command: 'nope' }).transcribe(voice())).rejects.toThrow(/ffmpeg/)
  })
})

describe('output handling', () => {
  it('cleanTranscript drops engine tags, noise markers and invented subtitle credits; caps length', () => {
    expect(cleanTranscript('<|zh|><|HAPPY|>你好呀')).toBe('你好呀')
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('')
    expect(cleanTranscript('请不吝点赞 订阅 转发 打赏支持明镜与点点栏目')).toBe('')
    expect(cleanTranscript('明天见 字幕由 Amara.org 社区提供')).toBe('明天见')
    expect(cleanTranscript('谢谢。')).toBe('')
    expect(Array.from(cleanTranscript('字'.repeat(600)))).toHaveLength(501)
    expect(transcriptLabel('')).toBe('')
    expect(transcriptLabel('好')).toBe('（语音转写：好）')
  })

  it('parseSherpaOutput takes the last JSON line with text', () => {
    expect(parseSherpaOutput('noise\n/tmp/a.wav\n{"lang":"<|zh|>","text":"测试"}\n')).toBe('测试')
    expect(parseSherpaOutput('no json here')).toBe('')
  })

  it('recordResult understands NapCat answers: base64, URL, absolute path', () => {
    expect(recordResult({ base64: 'QUJD' })).toEqual({ url: undefined, file: 'base64://QUJD' })
    expect(recordResult({ url: 'https://x.y/a.mp3' })).toEqual({ url: 'https://x.y/a.mp3' })
    expect(recordResult({ file: '/home/napcat/cache/a.mp3' })).toEqual({ url: undefined, file: 'file:///home/napcat/cache/a.mp3' })
    expect(recordResult({ file: 'hash-only' })).toBeUndefined()
    expect(recordResult(undefined)).toBeUndefined()
  })
})

describe('applyReplacements', () => {
  it('replaces every occurrence, longer keys first, in a single pass', () => {
    expect(applyReplacements('大飞鱼大飞鱼', { 大飞鱼: '大肥鱼' })).toBe('大肥鱼大肥鱼')
    expect(applyReplacements('小大飞鱼呀', { 大飞鱼: '大肥鱼', 小大飞鱼: '小肥鱼' })).toBe('小肥鱼呀')
    // a replacement is never fed back in (飞→肥, 肥→胖 does not chain)
    expect(applyReplacements('飞', { 飞: '肥', 肥: '胖' })).toBe('肥')
  })

  it('treats keys literally and ignores empty keys or a missing table', () => {
    expect(applyReplacements('a.b a*b', { 'a.b': 'x' })).toBe('x a*b')
    expect(applyReplacements('abc', { '': 'x' })).toBe('abc')
    expect(applyReplacements('abc', undefined)).toBe('abc')
    expect(applyReplacements('abc', {})).toBe('abc')
  })
})
