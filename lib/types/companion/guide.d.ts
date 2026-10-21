export interface CompanionGuideConfig {
    ownerTitle: string;
    /** The owner's QQ numbers. */
    adminUsers: readonly string[];
    publicMemoryFile: string;
    publicMemoryMaxBytes: number;
    /** The owner's private-chat workspace (its AGENTS.md is the private memory). */
    adminWorkspacePath: string;
    privateMemoryMaxBytes: number;
    groupMemoryDir: string;
    groupMemoryMaxBytes: number;
    privateResetDays: number;
    groupResetDays: number;
    idleResetHours: number;
    groupContextLines: number;
    groupNameTriggers: readonly string[];
    groupFollowupSeconds: number;
    groupPeekEnabled: boolean;
    proactiveEnabled: boolean;
    proactiveWindowStart: string;
    proactiveWindowEnd: string;
    proactiveMaxUnanswered: number;
    stickerDir: string;
    /** HH:MM of the nightly diary prompt ('' = none). */
    diaryTime: string;
}
/** Which chat the guide is for. */
export type GuideAudience = 'owner' | 'group' | 'other';
/** The guide text for one chat. */
export declare function buildCompanionGuide(c: CompanionGuideConfig, audience: GuideAudience): string;
