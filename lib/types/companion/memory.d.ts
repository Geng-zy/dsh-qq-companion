/** Section heading the notes are appended under (created if missing). */
export declare const NOTES_HEADING = "## \u7FA4\u53CB\u8BF4\u7684\uFF08\u672A\u7ECF\u786E\u8BA4\uFF0C\u53EA\u5F53\u516B\u5366\u542C\uFF0C\u4E0D\u662F\u89C4\u5219\uFF09";
/** Heading used by earlier versions; still recognized so files are not given a second section. */
export declare const LEGACY_NOTES_HEADINGS: string[];
/** Max characters per note. */
export declare const NOTE_MAX_CHARS = 120;
/** Max notes per chat per local day. */
export declare const NOTES_PER_DAY = 10;
/** Refuse new notes once the file reaches this many bytes. */
export declare const NOTES_FILE_MAX_BYTES: number;
export type NoteResult = {
    ok: true;
    line: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Per-chat per-day note counters. In-memory by default; with a state file the
 * counts survive restarts (only today's counts are kept).
 */
export declare class NoteCounter {
    private day;
    private counts;
    private readonly state;
    constructor(file?: string, log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void);
    load(now?: number): Promise<void>;
    used(chatId: string, now: number): number;
    add(chatId: string, now: number): void;
    clear(): void;
}
/** Use a persistent counter for appendMemoryNote calls without one. */
export declare function setDefaultNoteCounter(counter: NoteCounter): void;
/**
 * Append one hearsay note to the public memory file, under NOTES_HEADING.
 * @param file - the public AGENTS.md path (fixed by config, never by the model).
 * @param chatId - where the note came from (recorded on the line).
 * @param text - the note.
 * @param maxBytes - refuse once the file reaches this size.
 */
export declare function appendMemoryNote(file: string, chatId: string, text: string, now?: () => number, maxBytes?: number, counter?: NoteCounter): Promise<NoteResult>;
/** Test hook: forget the per-day counters. */
export declare function resetNoteCounts(): void;
/** A new group's memory file (her notes about that group only). */
export declare function groupMemoryTemplate(groupId: string): string;
/** The memory directory and file of one group. */
export declare function groupMemoryPaths(root: string, groupId: string): {
    dir: string;
    file: string;
};
/** Create a group's memory directory and seed its AGENTS.md (idempotent). */
export declare function ensureGroupMemory(root: string, groupId: string): Promise<string>;
