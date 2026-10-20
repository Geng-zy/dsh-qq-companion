export interface SelfCheckInput {
    mode: 'reverse' | 'forward';
    host: string;
    accessToken: string;
    botQQ: string;
    adminUsers: readonly string[];
    dmPolicy: string;
    groupPolicy: string;
    allowFrom: readonly string[];
    groupAllowFrom: readonly string[];
    allowAllUsers: boolean;
    workspacePath: string;
    adminWorkspacePath: string;
    groupMemoryDir: string;
    publicMemoryFile: string;
    scheduledPrompts: ReadonlyArray<{
        id: string;
        time: string;
        chatId: string;
        prompt: string;
    }>;
    proactiveEnabled: boolean;
    proactiveChatId: string;
    proactiveWindowStart: string;
    proactiveWindowEnd: string;
    proactiveMinPerDay: number;
    proactiveMaxPerDay: number;
    splitLines: boolean;
    splitMaxMessages: number;
}
/** All problems found (empty = all good). */
export declare function selfCheck(c: SelfCheckInput): string[];
