export type SttEngine = 'auto' | 'sherpa-onnx' | 'whisper-cpp' | 'command';
export interface SttConfig {
    enabled: boolean;
    /** Engine; the old names 'custom' (= command) and 'openai' (= auto) are accepted. */
    engine: SttEngine | 'custom' | 'openai';
    /** Program for the command engine. */
    command: string;
    /** argv template for the command engine. */
    args: string[];
    /** sherpa-onnx: model directory; whisper-cpp: ggml model name or .bin path. */
    model: string;
    /** Spoken language: 'auto' or a code such as 'zh' / 'en'. */
    language?: string;
    /** Per-transcription timeout (ms). */
    timeoutMs: number;
    /** Only the first this-many seconds are transcribed. */
    maxSeconds?: number;
    /** Fix-ups applied to every transcript: misheard text → what was meant
     * (e.g. 大飞鱼 → 大肥鱼, a name the engine cannot know). */
    replacements?: Readonly<Record<string, string>>;
}
/** Most transcriptions waiting behind the running one. */
export declare const MAX_QUEUE = 5;
/** Transcripts longer than this are cut (characters). */
export declare const MAX_TRANSCRIPT_CHARS = 500;
/** Run a program; resolves stdout+stderr, rejects on a non-zero exit or timeout. */
export declare function runProcess(program: string, args: readonly string[], timeoutMs: number): Promise<{
    stdout: string;
    stderr: string;
}>;
/** Find an executable on PATH (no shell involved). */
export declare function findCommand(name: string): Promise<string | undefined>;
/** A SenseVoice model directory: the onnx file and tokens.txt. */
export declare function findSenseVoiceModel(dir: string): Promise<{
    model: string;
    tokens: string;
} | undefined>;
/** A whisper.cpp ggml model by path or by name (ggml-<name>.bin in the usual places). */
export declare function findWhisperModel(model: string): Promise<string | undefined>;
/** Clean an engine's raw transcript: engine tags, noise markers, invented credits, length. */
export declare function cleanTranscript(raw: string): string;
/** Apply the transcript fix-up table. Longer keys go first, so a longer
 * phrase wins over a shorter one it contains; empty keys are ignored. */
export declare function applyReplacements(text: string, replacements: Readonly<Record<string, string>> | undefined): string;
/** sherpa-onnx prints a JSON object with "text" (on stdout or stderr, depending on version). */
export declare function parseSherpaOutput(output: string): string;
export declare class Transcriber {
    private readonly config;
    private chain;
    private waiting;
    private resolved;
    constructor(config: SttConfig);
    get enabled(): boolean;
    /** Transcribe one voice file (queued). @returns the cleaned transcript ('' = nothing said). */
    transcribe(filePath: string): Promise<string>;
    /** Which engine would run (for diagnostics); throws when none is usable. */
    engineDescription(): Promise<string>;
    private engineName;
    private resolve;
    private resolveNow;
    private transcribeNow;
    private runEngine;
}
/** The transcript as shown to the model ('' when nothing was said). */
export declare function transcriptLabel(text: string): string;
