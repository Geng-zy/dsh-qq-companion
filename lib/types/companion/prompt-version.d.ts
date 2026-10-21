/**
 * The persona text of a profile patch file: every `prefix: |` block (the
 * presets' persona), in file order. '' when the file cannot be read.
 */
export declare function personaBlocks(patchFile: string): string;
/** A short fingerprint of the given parts. */
export declare function promptFingerprint(...parts: string[]): string;
