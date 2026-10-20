/** CJK-capable families, most preferred first. */
export declare const CJK_FAMILIES: string[];
/** Register configured font files (each path once; missing files skipped). */
export declare function registerFontFiles(files: readonly string[]): void;
export interface FontStacks {
    /** Body text (CSS family list). */
    text: string;
    /** Code (monospace first, then the text list for CJK / emoji). */
    mono: string;
}
/**
 * Font lists for one configuration.
 * @throws when no CJK font is installed — a card would render tofu.
 */
export declare function fontStacks(preferred?: readonly string[]): FontStacks;
