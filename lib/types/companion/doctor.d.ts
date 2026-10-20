import type { LivenessSnapshot } from '../liveness.js';
export interface CompanionStatusDeps {
    liveness?: () => LivenessSnapshot;
    scheduler?: () => Array<{
        id: string;
        time: string;
        firedToday: boolean;
    }>;
    proactive?: () => {
        remaining: string[];
        firedToday: number;
    };
    /** Memory files to size; `max` (bytes) renders a percentage. */
    memoryFiles?: Array<{
        label: string;
        path: string;
        max?: number;
    }>;
    /** Root of per-group memory dirs (<root>/<group>/AGENTS.md). */
    groupMemoryDir?: string;
    groupMemoryMaxBytes?: number;
    now?: () => number;
}
/** Render the companion lines (never throws: a failing part renders 未知). */
export declare function companionStatusLines(deps: CompanionStatusDeps): Promise<string[]>;
