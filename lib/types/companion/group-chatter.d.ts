/** Lines kept per group. */
export declare const GROUP_BUFFER_LINES = 40;
export interface GroupChatterConfig {
    /** Unseen lines attached when she is called (0 = off). */
    contextLines: number;
    /** Names that call her without an @ (empty = off). */
    names: readonly string[];
    /** Seconds after her reply during which the person she answered may go on without an @ (0 = off). */
    followupSeconds: number;
    /** Periodic looks at lively groups. */
    peekEnabled: boolean;
    /** Minutes between two looks at the same group. */
    peekGapMinutes: number;
    /** New lines (since her last look or reply) a group needs before a look. */
    peekMinMessages: number;
    /** No look while she talked in the group within this many minutes. */
    peekQuietMinutes: number;
    /** Local HH:MM window for looks (end may be 24:00). */
    peekWindowStart: string;
    peekWindowEnd: string;
}
export interface GroupLine {
    t: number;
    userId: string;
    nickname: string;
    text: string;
}
export declare class GroupChatter {
    private readonly config;
    private readonly now;
    private readonly groups;
    constructor(options: {
        config: GroupChatterConfig;
        now?: () => number;
    });
    private state;
    /** Groups that have sent anything since startup. */
    knownGroups(): string[];
    /** Keep one group message (every allowed one, called or not). */
    observe(groupId: string, userId: string, nickname: string, text: string): void;
    /** Whether the text calls her by one of her names. */
    callsByName(text: string): boolean;
    /** Whether this person is still talking with her (answered moments ago). */
    isFollowup(groupId: string, userId: string): boolean;
    /** She is about to answer `userId` in this group. */
    noteCalled(groupId: string, userId: string): void;
    /** She sent a message in this group (the follow-up window restarts). */
    noteSpoke(groupId: string): void;
    /**
     * The context block for a call: the lines she has not seen, minus the
     * calling message itself (the newest line), at most contextLines; all of
     * them count as seen afterwards. '' = nothing to add.
     */
    takeContext(groupId: string): string;
    /** Groups due for a look now, among `groupIds`. */
    peekDue(groupIds: readonly string[]): string[];
    /** The wake-up text of one look (marks the lines seen); '' = nothing new. */
    takePeek(groupId: string, pass: string): string;
}
