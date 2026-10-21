/**
 * Prompt versions: a short fingerprint of what a chat's system prompt is made
 * of (the persona text, that chat's companion guide, the plugin version).
 * dsh does not replace a live session's system prompt when it changes — it
 * appends the new one and keeps sending the old one too — so a chat whose
 * fingerprint moved on starts a fresh session at its next message.
 * @module dsh-qq-companion/companion/prompt-version
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
/**
 * The persona text of a profile patch file: every `prefix: |` block (the
 * presets' persona), in file order. '' when the file cannot be read.
 */
export function personaBlocks(patchFile) {
    let lines;
    try {
        lines = readFileSync(patchFile, 'utf8').split('\n');
    }
    catch {
        return '';
    }
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*)prefix: \|/.exec(lines[i]);
        if (m === null)
            continue;
        const base = m[1].length;
        for (i++; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() !== '' && line.length - line.trimStart().length <= base) {
                i--;
                break;
            }
            out.push(line);
        }
    }
    return out.join('\n');
}
/** A short fingerprint of the given parts. */
export function promptFingerprint(...parts) {
    const hash = createHash('sha256');
    for (const part of parts)
        hash.update(part).update('\u0000');
    return hash.digest('hex').slice(0, 16);
}
