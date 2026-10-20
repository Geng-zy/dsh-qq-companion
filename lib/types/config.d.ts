import type Z from '@deepseek-ai/schemastery';
import type { AccessPolicyConfig } from './chat.js';
import type { ScheduledPrompt } from './companion/index.js';
/** Plugin configuration (validated by schemastery). */
export interface Config {
    host: string;
    port: number;
    accessToken: string;
    botQQ: string;
    requireMention: boolean;
    /** Unknown slash-command handling: intercept（默认）=拦截并给建议；passthrough=透传给模型。 */
    unknownCommand: 'intercept' | 'passthrough';
    /** 任务运行中的新消息处理策略：queue=排队（默认）；steer=插话进当前任务。 */
    newMessagePolicy: 'queue' | 'steer';
    /** steer 模式下自动插话资格：admin=仅管理员（默认）；all=不限。 */
    autoSteerPolicy: 'admin' | 'all';
    /** 等待模型回复超时阈值（毫秒）——超时后登记补发跟踪、回合完成后向原聊天补发最终文字；0=关闭。 */
    deferredTimeoutMs: number;
    dmPolicy: 'open' | 'allowlist' | 'disabled';
    groupPolicy: 'open' | 'allowlist' | 'disabled';
    allowFrom: string[];
    groupAllowFrom: string[];
    adminUsers: string[];
    allowAllUsers: boolean;
    autoAcceptAdminRequests: boolean;
    autoAllowInvitedGroups: boolean;
    ownerTitle: string;
    ignoreSelf: boolean;
    interimMessages: boolean;
    /** Per-interim auto-recall delay (ms) from each interim's send completion. */
    interimRecallMs: number;
    /** interim recall degrade switch (false = send-only interims). */
    interimRecall: boolean;
    sendErrorNotice: boolean;
    /** Per-chat per-minute sliding-window cap for normal (non-command) messages; 0 disables. */
    rateLimitPerMinute: number;
    restrictedMemberPrefix: boolean;
    sensitivePatterns: string[];
    mediaDir: string;
    tempTtlHours: number;
    outboundImageMaxBytes: number;
    maxVoiceBytes: number;
    maxFileBytes: number;
    inboundImageMaxPx: number;
    /** @deprecated alias of inboundImageMaxPx; honored for one release. */
    imageMaxSize?: number;
    /** @deprecated alias of outboundImageMaxBytes; honored for one release. */
    maxImageBytes?: number;
    sttEnabled: boolean;
    sttEngine: 'auto' | 'sherpa-onnx' | 'whisper-cpp' | 'command' | 'openai' | 'custom';
    sttCommand: string;
    sttArgs: string[];
    sttModel: string;
    sttTimeoutMs: number;
    sttLanguage: string;
    sttMaxSeconds: number;
    sttReplacements: Record<string, string>;
    textImageThreshold: number;
    cardFooter: string;
    splitLines: boolean;
    splitMaxMessages: number;
    groupSplitLines: boolean;
    humanTypingPace: boolean;
    typingDelayPerCharMs: number;
    typingDelayMinMs: number;
    typingDelayMaxMs: number;
    fontFiles: string[];
    fontFamilies: string[];
    agentPreset: string;
    adminPreset: string;
    adminPermission: string;
    adminWorkspacePath: string;
    idleResetHours: number;
    publicMemoryFile: string;
    scheduledPrompts: ScheduledPrompt[];
    publicMemoryMaxBytes: number;
    groupMemoryDir: string;
    groupMemoryMaxBytes: number;
    stickerDir: string;
    stickerMaxCount: number;
    stickerMaxBytes: number;
    stickerDailyMax: number;
    privateResetDays: number;
    groupResetDays: number;
    memoryNoteDenyWords: string[];
    privateSessionKeepDays: number;
    groupSessionKeepDays: number;
    proactiveEnabled: boolean;
    proactiveChatId: string;
    proactiveWindowStart: string;
    proactiveWindowEnd: string;
    proactiveMinPerDay: number;
    proactiveMaxPerDay: number;
    proactiveMinGapMinutes: number;
    proactiveSkipIfActiveMinutes: number;
    proactiveMaxUnanswered: number;
    workspacePath: string;
    inboundFileMaxBytes: number;
    /** @deprecated alias of inboundFileMaxBytes; honored for one release. */
    maxInboundFileBytes?: number;
    /** chats idle longer than this many days are evicted (0 disables). */
    chatIdleEvictDays: number;
    groupReasoningEffort: '' | 'off' | 'low' | 'high' | 'max';
    /** Escape hatch: skip the download private-address check (local reverse proxy). */
    allowPrivateHosts: boolean;
    /** inbound (chatId, message_id) dedup window in seconds; 0 disables. */
    dedupWindowSeconds: number;
    /** tool-send audit jsonl (mediaDir/qq-actions.log). */
    actionAuditEnabled: boolean;
    /** decision-trace jsonl (mediaDir/qq-trace.jsonl); default off — no
     * file, no behavior difference. */
    traceEnabled: boolean;
    /** trace level; 'warn' records only ok:false (rejected/failed/dropped) events. */
    traceLevel: 'debug' | 'warn';
    /** Console log gate: messages below this level are dropped (debug < info < warn < error). */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}
/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export declare function defaultMediaDir(): string;
/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export declare function dshHome(): string;
export declare const Config: Z<Config>;
/** Map deprecated config names onto their renamed fields: a legacy value is
 * honored only while the new name still sits at its schema default (the new
 * name wins when both are configured), each legacy use warns once, and the
 * legacy keys never leak into the effective config. */
export declare function resolveDeprecatedConfig(config: Config): Config;
/** Resolve env-var fallbacks into the effective access policy. */
export declare function resolvePolicy(config: Config): AccessPolicyConfig;
