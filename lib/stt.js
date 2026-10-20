/**
 * Voice transcription, fully local: ffmpeg turns the voice file into 16 kHz
 * mono WAV (first sttMaxSeconds only), then one engine transcribes it:
 *
 *  - sherpa-onnx: `sherpa-onnx-offline` with a SenseVoice model directory
 *    (model.int8.onnx / model.onnx + tokens.txt) — fast on CPU, strong on
 *    Chinese; recommended;
 *  - whisper-cpp: `whisper-cli` (or the older `main`) with a ggml model;
 *  - command: any program; argv template with {wav} {input} {model} {lang},
 *    transcript read from stdout;
 *  - auto: the first of sherpa-onnx / whisper-cpp that is installed.
 *
 * One transcription runs at a time; at most MAX_QUEUE wait, more are refused
 * at once. Every run has a timeout and its temp dir is always removed. Any
 * failure throws — the caller keeps the [语音] placeholder.
 * @module dsh-qq-companion/stt
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** Most transcriptions waiting behind the running one. */
export const MAX_QUEUE = 5;
/** Transcripts longer than this are cut (characters). */
export const MAX_TRANSCRIPT_CHARS = 500;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/** Run a program; resolves stdout+stderr, rejects on a non-zero exit or timeout. */
export function runProcess(program, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(program, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = (error) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else
                resolve({ stdout, stderr });
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(new Error('超时（' + Math.round(timeoutMs / 1000) + ' 秒）：' + program));
        }, timeoutMs);
        child.stdout.on('data', chunk => { if (stdout.length < 1_000_000)
            stdout += String(chunk); });
        child.stderr.on('data', chunk => { if (stderr.length < 1_000_000)
            stderr += String(chunk); });
        child.on('error', error => finish(error));
        child.on('close', code => finish(code === 0 ? undefined : new Error(program + ' 退出码 ' + code + '：' + stderr.trim().slice(-500))));
    });
}
/** Find an executable on PATH (no shell involved). */
export async function findCommand(name) {
    if (name.includes('/')) {
        try {
            await access(name, constants.X_OK);
            return name;
        }
        catch {
            return undefined;
        }
    }
    for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
        if (dir === '')
            continue;
        const candidate = join(dir, name);
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            // not here
        }
    }
    return undefined;
}
const exists = async (path) => {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
};
/** A SenseVoice model directory: the onnx file and tokens.txt. */
export async function findSenseVoiceModel(dir) {
    const candidates = dir !== '' ? [dir] : [join(process.env.HOME ?? '', '.cache', 'sherpa-onnx', 'sense-voice'), '/opt/sherpa-onnx/sense-voice'];
    for (const d of candidates) {
        const tokens = join(d, 'tokens.txt');
        if (!(await exists(tokens)))
            continue;
        for (const name of ['model.int8.onnx', 'model.onnx']) {
            if (await exists(join(d, name)))
                return { model: join(d, name), tokens };
        }
    }
    return undefined;
}
/** A whisper.cpp ggml model by path or by name (ggml-<name>.bin in the usual places). */
export async function findWhisperModel(model) {
    if (model.includes('/') || model.endsWith('.bin'))
        return (await exists(model)) ? model : undefined;
    const name = 'ggml-' + (model === '' ? 'small' : model) + '.bin';
    const home = process.env.HOME ?? '';
    for (const dir of [join(home, '.cache', 'whisper.cpp'), join(home, 'whisper.cpp', 'models'), '/usr/local/share/whisper.cpp/models', '/opt/homebrew/share/whisper.cpp/models', '/opt/whisper.cpp/models']) {
        if (await exists(join(dir, name)))
            return join(dir, name);
    }
    return undefined;
}
/** Phrases whisper tends to invent on silence or noise (subtitle credits and the like). */
const HALLUCINATIONS = [
    /请不吝点赞.*$/, /字幕(由|制作|提供|by).*$/i, /(感谢|谢谢)(您的)?(观看|收看|收听).*$/, /明镜与点点栏目/,
    /^(\s*(谢谢|嗯|啊|哦)[。！!.]?\s*)+$/, /Thanks? (you )?for watching.*$/i, /^\s*\.+\s*$/,
];
/** Clean an engine's raw transcript: engine tags, noise markers, invented credits, length. */
export function cleanTranscript(raw) {
    let text = raw
        .replace(/<\|[^|>]*\|>/g, '') // SenseVoice language / emotion / event tags
        .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|音乐|掌声|笑声)[^\]]*\]|\((音乐|掌声|笑声)\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    for (const pattern of HALLUCINATIONS)
        text = text.replace(pattern, '').trim();
    const chars = Array.from(text);
    return chars.length > MAX_TRANSCRIPT_CHARS ? chars.slice(0, MAX_TRANSCRIPT_CHARS).join('') + '…' : text;
}
/** Apply the transcript fix-up table. Longer keys go first, so a longer
 * phrase wins over a shorter one it contains; empty keys are ignored. */
export function applyReplacements(text, replacements) {
    if (replacements === undefined)
        return text;
    const keys = Object.keys(replacements).filter(key => key !== '').sort((a, b) => b.length - a.length);
    if (keys.length === 0)
        return text;
    // One pass over the text, so a replacement is never replaced again.
    const pattern = new RegExp(keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    return text.replace(pattern, match => replacements[match] ?? match);
}
/** sherpa-onnx prints a JSON object with "text" (on stdout or stderr, depending on version). */
export function parseSherpaOutput(output) {
    for (const line of output.split('\n').reverse()) {
        const at = line.indexOf('{');
        if (at < 0 || !line.includes('"text"'))
            continue;
        try {
            const parsed = JSON.parse(line.slice(at));
            if (typeof parsed.text === 'string')
                return parsed.text;
        }
        catch {
            // not the result line
        }
    }
    return '';
}
/** True for a QQ SILK voice file (ffmpeg cannot decode it). */
async function isSilk(path) {
    const handle = await open(path, 'r');
    try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(12), 0, 12, 0);
        return buffer.subarray(0, bytesRead).toString('latin1').includes('#!SILK');
    }
    finally {
        await handle.close();
    }
}
export class Transcriber {
    config;
    chain = Promise.resolve();
    waiting = 0;
    resolved;
    constructor(config) {
        this.config = config;
    }
    get enabled() {
        return this.config.enabled;
    }
    /** Transcribe one voice file (queued). @returns the cleaned transcript ('' = nothing said). */
    transcribe(filePath) {
        if (this.waiting >= MAX_QUEUE)
            return Promise.reject(new Error('语音转写排队已满（' + MAX_QUEUE + ' 条），这条不转了'));
        this.waiting += 1;
        const run = this.chain.then(() => this.transcribeNow(filePath)).finally(() => { this.waiting -= 1; });
        this.chain = run.catch(() => undefined);
        return run;
    }
    /** Which engine would run (for diagnostics); throws when none is usable. */
    async engineDescription() {
        const r = await this.resolve();
        return r.engine + '（' + r.program + ('model' in r ? '，' + r.model : '') + '）';
    }
    engineName() {
        const e = this.config.engine;
        return e === 'custom' ? 'command' : e === 'openai' ? 'auto' : e;
    }
    resolve() {
        // Cache only successes: a missing tool installed later is picked up.
        this.resolved ??= this.resolveNow().catch(error => { this.resolved = undefined; throw error; });
        return this.resolved;
    }
    async resolveNow() {
        const engine = this.engineName();
        if (engine === 'command') {
            const program = await findCommand(this.config.command);
            if (program === undefined)
                throw new Error('找不到 sttCommand 指定的程序：' + (this.config.command || '（未配置）'));
            return { engine, program };
        }
        if (engine === 'sherpa-onnx' || engine === 'auto') {
            const program = await findCommand('sherpa-onnx-offline');
            const model = await findSenseVoiceModel(engine === 'sherpa-onnx' ? this.config.model : '');
            if (program !== undefined && model !== undefined)
                return { engine: 'sherpa-onnx', program, ...model };
            if (engine === 'sherpa-onnx')
                throw new Error(program === undefined ? '找不到 sherpa-onnx-offline' : '找不到 SenseVoice 模型目录（需要 tokens.txt 和 model.int8.onnx）：' + this.config.model);
        }
        const program = (await findCommand('whisper-cli')) ?? (await findCommand('whisper-cpp'));
        const model = await findWhisperModel(engine === 'whisper-cpp' ? this.config.model : this.config.model || 'small');
        if (program !== undefined && model !== undefined)
            return { engine: 'whisper-cpp', program, model };
        throw new Error(engine === 'auto'
            ? '没有可用的语音识别引擎（装 sherpa-onnx + SenseVoice 模型，或 whisper.cpp + ggml 模型）'
            : program === undefined ? '找不到 whisper-cli' : '找不到 whisper.cpp 模型：' + this.config.model);
    }
    async transcribeNow(filePath) {
        const size = (await stat(filePath)).size;
        if (size === 0)
            return '';
        if (size > MAX_INPUT_BYTES)
            throw new Error('语音文件太大（' + Math.round(size / 1024 / 1024) + 'MB）');
        if (await isSilk(filePath))
            throw new Error('这是 QQ 的 SILK 原始语音，ffmpeg 解不了（应通过 NapCat get_record 转成 mp3）');
        const ffmpeg = await findCommand('ffmpeg');
        if (ffmpeg === undefined)
            throw new Error('找不到 ffmpeg（转写需要先把语音转成 WAV）');
        const engine = await this.resolve();
        const work = join(dirname(filePath), 'stt_' + randomUUID().slice(0, 8));
        await mkdir(work, { recursive: true });
        try {
            const wav = join(work, 'audio.wav');
            const seconds = Math.max(1, this.config.maxSeconds ?? 60);
            await runProcess(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', filePath, '-t', String(seconds), '-ac', '1', '-ar', '16000', '-f', 'wav', wav], Math.min(this.config.timeoutMs, 30_000));
            return applyReplacements(cleanTranscript(await this.runEngine(engine, wav, filePath)), this.config.replacements);
        }
        finally {
            await rm(work, { recursive: true, force: true });
        }
    }
    async runEngine(r, wav, input) {
        const lang = (this.config.language ?? 'auto').trim() || 'auto';
        const timeout = this.config.timeoutMs;
        switch (r.engine) {
            case 'sherpa-onnx': {
                const { stdout, stderr } = await runProcess(r.program, [
                    '--tokens=' + r.tokens, '--sense-voice-model=' + r.model, '--sense-voice-language=' + lang,
                    '--sense-voice-use-itn=1', '--num-threads=2', wav,
                ], timeout);
                return parseSherpaOutput(stdout + '\n' + stderr);
            }
            case 'whisper-cpp': {
                const { stdout } = await runProcess(r.program, ['-m', r.model, '-f', wav, '-l', lang, '-nt', '-np', '-t', '2'], timeout);
                return stdout;
            }
            case 'command': {
                const args = this.config.args.map(a => a.replace(/\{wav\}/g, wav).replace(/\{input\}/g, input).replace(/\{model\}/g, this.config.model).replace(/\{lang\}/g, lang));
                const { stdout } = await runProcess(r.program, args.length > 0 ? args : [wav], timeout);
                return stdout;
            }
        }
    }
}
/** The transcript as shown to the model ('' when nothing was said). */
export function transcriptLabel(text) {
    return text !== '' ? '（语音转写：' + text + '）' : '';
}
