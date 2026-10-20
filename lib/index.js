/**
 * dsh-qq-companion: a QQ (OneBot 11 / NapCat) chat channel for DeepSeek Harness.
 *
 * Mounts inside the dsh host process: a reverse- or forward-WebSocket link to
 * NapCat, one Agent per QQ chat, inbound images/voice handled for the model
 * (whisper STT when enabled), outbound replies split at sentence boundaries,
 * [[qq_forward]] merged forwards, allowlist/mention access control, and a set
 * of qq_* tools for media and NapCat APIs.
 * @module dsh-qq-companion
 */
import { selfCheck } from './selfcheck.js';
import { QqLiveness } from './liveness.js';
import { ChatActivity, DailyScheduler, NoteCounter, ProactiveScheduler, SendCounter, TypingPacer, companionStatusLines, setDefaultNoteCounter } from './companion/index.js';
import { GroupAccess, handleGroupEvent } from './groups.js';
import { join } from 'node:path';
// 部署加固：peer 依赖解析失败/关键模块缺失时必须显眼报错并 fail-loud，
// 不能静默不挂载。静态 import 会在本模块任何代码运行之前就以晦涩的
// ERR_MODULE_NOT_FOUND 失败（宿主侧表现为插件被静默跳过），因此运行时
// 值依赖改为入口顶部受控动态加载：失败时先输出含「peer/依赖」的显式
// 错误，再把原错误抛出。
let configModule;
let OneBotConnection;
let ChatBridge;
let MediaStore;
let Transcriber;
let TraceSink;
let redactSnapshot;
let describeError;
try {
    configModule = await import('./config.js');
    ({ OneBotConnection } = await import('./connection.js'));
    ({ ChatBridge } = await import('./bridge.js'));
    ({ MediaStore } = await import('./media.js'));
    ({ Transcriber } = await import('./stt.js'));
    ({ TraceSink } = await import('./trace.js'));
    ({ redactSnapshot } = await import('./health.js'));
    ({ describeError } = await import('./errors.js'));
}
catch (error) {
    console.error('[qq-companion] 挂载失败：peer 依赖解析失败或关键模块缺失 —— 部署副本必须带完整 node_modules 链接集（scripts/link-host.sh 产物），只复制 lib/ 不够。原始错误：' + (error instanceof Error ? error.message : String(error)));
    throw error;
}
export const name = 'dsh-qq-companion';
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'sessionPersistence', 'workspaceRegistry', 'commands', 'llm'];
export const Config = configModule.Config;
export const { defaultMediaDir, dshHome, resolveDeprecatedConfig } = configModule;
const { resolvePolicy } = configModule;
/** Severity rank for the logLevel gate (debug < info < warn < error). */
const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
/** Log a meta event; periodic heartbeat events are silenced to keep the log readable. */
export function logMetaEvent(selfId, event, minLevel = 'info') {
    const metaType = typeof event.meta_event_type === 'string' ? event.meta_event_type : '';
    if (metaType === 'heartbeat')
        return;
    if (LOG_LEVEL_RANK.info < LOG_LEVEL_RANK[minLevel])
        return;
    console.log('[qq-companion] meta event; bot QQ: ' + selfId + '; ' + metaType);
}
/** Mount the plugin. */
export function apply(ctx, config) {
    // honor the deprecated config names before any consumer reads them.
    config = resolveDeprecatedConfig(config);
    const mediaDir = config.mediaDir !== '' ? config.mediaDir : defaultMediaDir();
    const policy = resolvePolicy(config);
    /** Console log line callback (level, message) — shared by the bridge deps,
     * the connection log port and the host-ready boot gate below. */
    const log = (level, message) => {
        if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[config.logLevel])
            return;
        const prefix = '[qq-companion] ';
        if (level === 'error')
            console.error(prefix + message);
        else if (level === 'warn')
            console.warn(prefix + message);
        else
            console.log(prefix + message);
    };
    // 方案 B: the host exposes no queryable default workspace —
    // WorkspaceRegistry has no default getter and the session controller's
    // defaultCwd is assembly-internal — so the unconfigured fallback stays the
    // host process cwd. Say so once at mount so a /root surprise is explainable.
    if (config.workspacePath === '') {
        log('warn', '未配置 workspacePath：QQ 会话默认目录将使用宿主进程工作目录 ' + process.cwd() + '，建议在配置中设置 workspacePath，避免会话工作区落在宿主启动目录');
    }
    // runtime group allowlist (configured ∪ added − removed),
    // persisted under mediaDir; loads before the bridge sees any message.
    const groupAccess = new GroupAccess({ policy, mediaDir, log });
    const groupAccessLoaded = groupAccess.load();
    // chat activity (idle reset / handoff / diary input).
    const activity = new ChatActivity({ mediaDir, log });
    const activityLoaded = activity.load();
    // Counts what the account sends (shown by /doctor).
    const sendCounter = new SendCounter();
    const typingPacer = new TypingPacer({ config: { perCharMs: config.typingDelayPerCharMs, minMs: config.typingDelayMinMs, maxMs: config.typingDelayMaxMs } });
    // Per-day memory-note counts survive restarts.
    const noteCounter = new NoteCounter(join(mediaDir, 'note-counts.json'), log);
    setDefaultNoteCounter(noteCounter);
    // Late-bound: the proactive scheduler needs the bridge, the bridge's /task
    // needs the scheduler.
    let proactiveRef;
    const proactiveHandle = {
        remaining: () => proactiveRef?.remaining() ?? [],
        fireNow: async () => { await proactiveRef?.fireNow(); },
    };
    const connection = new OneBotConnection({
        host: config.host,
        port: config.port,
        accessToken: config.accessToken,
        callTimeoutMs: 30_000,
        log,
    });
    const media = new MediaStore(mediaDir, config.tempTtlHours, config.inboundImageMaxPx, { maxBytes: config.inboundFileMaxBytes, allowPrivateHosts: config.allowPrivateHosts });
    // the trace sink exists only when explicitly enabled — default off
    // means no sink, no traceIds, no jsonl, zero behavior difference.
    const traceSink = config.traceEnabled
        ? new TraceSink({ dir: mediaDir, level: config.traceLevel, log: (level, message) => log(level, message) })
        : undefined;
    const transcriber = new Transcriber({
        enabled: config.sttEnabled,
        engine: config.sttEngine,
        command: config.sttCommand,
        args: config.sttArgs,
        model: config.sttModel,
        language: config.sttLanguage,
        maxSeconds: config.sttMaxSeconds,
        timeoutMs: config.sttTimeoutMs,
    });
    connection.onMessage = (event) => {
        void bridge.handleInbound(event);
    };
    connection.onNoticeOrRequest = (event) => {
        liveness.onNotice(event);
        void groupAccessLoaded.then(() => handleGroupEvent(event, {
            adminUsers: () => policy.adminUsers,
            selfId: () => connection.selfId,
            access: groupAccess,
            call: (action, params) => connection.call(action, params),
            notifyAdmins: async (text) => {
                for (const admin of policy.adminUsers) {
                    await bridge.sendToChat(('private:' + admin), text).catch((error) => {
                        log('warn', '通知管理员失败: ' + String(error));
                    });
                }
            },
            config: { autoAcceptAdminRequests: config.autoAcceptAdminRequests, autoAllowInvitedGroups: config.autoAllowInvitedGroups, ownerTitle: config.ownerTitle },
            log,
        })).catch((error) => log('warn', '群/好友事件处理失败: ' + String(error)));
    };
    // QQ account liveness beyond the open WebSocket (see liveness.ts).
    const liveness = new QqLiveness({ log, connected: () => connection.connected, drop: reason => connection.dropSocket(reason) });
    connection.onMeta = (event) => {
        liveness.onMeta(event);
        logMetaEvent(connection.selfId, event, config.logLevel);
    };
    // Dedup / write-gate keys: BridgeConfig (bridge.ts) keeps its declared shape; the
    // pipelines read them off the runtime object via optional intersection
    // members (see InboundContext/OutboundContext.config), so the spread here
    // is the wiring — no bridge.ts change.
    const gateConfig = {
        dedupWindowSeconds: config.dedupWindowSeconds,
        actionRatePerMinute: config.actionRatePerMinute,
        actionRatePerDay: config.actionRatePerDay,
        actionAuditEnabled: config.actionAuditEnabled,
    };
    const bridge = new ChatBridge({
        ctx,
        // the bridge sees only explicit ports — the session-event feed
        // (this context's own `on`) and the two injectables below; the 'loader'
        // service lookup lives here, not in the bridge.
        hostReady: async () => {
            try {
                const loader = ctx.get('loader');
                await loader?.await();
            }
            catch (error) {
                log('debug', 'loader.await failed: ' + describeError(error));
            }
        },
        // Live llm lookup per call — same semantics as the pre-port live getter.
        llmCatalog: {
            listProviders: () => ctx.llm.listProviders(),
            listModels: provider => ctx.llm.listModels(provider),
        },
        connection,
        dshHome: dshHome(),
        media,
        transcriber,
        agents: ctx.agents,
        sessions: ctx.sessions,
        agentPresets: ctx.agentPresets,
        commands: ctx.commands,
        sessionPersistence: ctx.sessionPersistence,
        workspaceRegistry: ctx.workspaceRegistry,
        agentDefaultModel: ctx.agentDefaultModel,
        defaultModel: () => {
            try {
                return ctx.agentDefaultModel.currentSelection();
            }
            catch {
                return undefined;
            }
        },
        config: {
            botQQ: config.botQQ,
            ignoreSelf: config.ignoreSelf,
            requireMention: config.requireMention,
            unknownCommand: config.unknownCommand,
            newMessagePolicy: config.newMessagePolicy,
            autoSteerPolicy: config.autoSteerPolicy,
            deferredTimeoutMs: config.deferredTimeoutMs,
            interimMessages: config.interimMessages,
            interimRecallMs: config.interimRecallMs,
            interimRecall: config.interimRecall,
            sendErrorNotice: config.sendErrorNotice,
            rateLimitPerMinute: config.rateLimitPerMinute,
            restrictedMemberPrefix: config.restrictedMemberPrefix,
            sensitivePatterns: config.sensitivePatterns,
            mediaDir,
            maxImageBytes: config.outboundImageMaxBytes,
            maxVoiceBytes: config.maxVoiceBytes,
            maxFileBytes: config.maxFileBytes,
            textImageThreshold: config.textImageThreshold,
            splitLines: config.splitLines,
            splitMaxMessages: config.splitMaxMessages,
            groupSplitLines: config.groupSplitLines,
            typingDelayPerCharMs: config.typingDelayPerCharMs,
            typingDelayMinMs: config.typingDelayMinMs,
            typingDelayMaxMs: config.typingDelayMaxMs,
            cardFooter: config.cardFooter,
            fontFiles: config.fontFiles,
            fontFamilies: config.fontFamilies,
            agentPreset: config.agentPreset,
            adminPreset: config.adminPreset,
            adminPermission: config.adminPermission,
            adminWorkspacePath: config.adminWorkspacePath,
            idleResetHours: config.idleResetHours,
            publicMemoryFile: config.publicMemoryFile,
            scheduledPrompts: config.scheduledPrompts,
            publicMemoryMaxBytes: config.publicMemoryMaxBytes,
            ownerTitle: config.ownerTitle,
            groupMemoryDir: config.groupMemoryDir,
            groupMemoryMaxBytes: config.groupMemoryMaxBytes,
            privateResetDays: config.privateResetDays,
            groupResetDays: config.groupResetDays,
            workspacePath: config.workspacePath,
            maxInboundFileBytes: config.inboundFileMaxBytes,
            chatIdleEvictDays: config.chatIdleEvictDays,
            ...gateConfig,
            trace: traceSink,
        },
        policy,
        groupAccess,
        activity,
        ...(config.proactiveEnabled ? { proactive: proactiveHandle } : {}),
        sendCounter,
        ...(config.humanTypingPace ? { typingPacer } : {}),
        companionStatus: () => companionStatusLines({
            sendCounter: () => sendCounter.snapshot(),
            liveness: () => liveness.snapshot(),
            scheduler: () => scheduler.snapshot(),
            ...(proactiveRef !== undefined ? { proactive: () => proactiveRef.snapshot() } : {}),
            memoryFiles: [
                { label: '公开', path: config.publicMemoryFile, max: config.publicMemoryMaxBytes },
                ...(config.adminWorkspacePath !== '' ? [{ label: '私密', path: join(config.adminWorkspacePath, 'AGENTS.md') }] : []),
            ],
            groupMemoryDir: config.groupMemoryDir,
            groupMemoryMaxBytes: config.groupMemoryMaxBytes,
        }),
        // health: the config snapshot is redacted at the source — secrets
        // (token/password/apikey…) never leave this closure in the clear.
        configSnapshot: () => redactSnapshot(config),
        log,
    });
    // connection faults mint QQ-CONN-… references through the
    // bridge (registry + trace + structured log); the transport appends the
    // returned reference to its own log line, so host logs and qq-trace.jsonl
    // share the same number for one fault.
    connection.onFailure = (stage, detail) => bridge.registerConnectionFailure(stage, detail);
    // A group that leaves the allowlist (/group remove, kicked, or dropped from
    // the config while dsh was down) has its session retired.
    groupAccess.onRemoved = groupId => bridge.retireGroup(groupId);
    // Lifecycle: start the bridge and transport; unwind everything on unload.
    // daily scheduled prompts (diary …), fired into their chats.
    const scheduler = new DailyScheduler({ prompts: config.scheduledPrompts, fire: prompt => bridge.fireScheduled(prompt), log, stateFile: join(mediaDir, 'scheduler-state.json') });
    // proactive wake-ups in the owner's chat.
    const proactive = config.proactiveEnabled && config.proactiveChatId !== ''
        ? new ProactiveScheduler({
            config: {
                chatId: config.proactiveChatId,
                windowStart: config.proactiveWindowStart,
                windowEnd: config.proactiveWindowEnd,
                minPerDay: config.proactiveMinPerDay,
                maxPerDay: config.proactiveMaxPerDay,
                minGapMinutes: config.proactiveMinGapMinutes,
                skipIfActiveMinutes: config.proactiveSkipIfActiveMinutes,
                maxUnanswered: config.proactiveMaxUnanswered,
            },
            activity,
            fire: context => bridge.fireCheckin(config.proactiveChatId, context),
            log,
            stateFile: join(mediaDir, 'proactive-state.json'),
        })
        : undefined;
    proactiveRef = proactive;
    ctx.effect(() => {
        bridge.start();
        // after start(): the mapping load it kicks off is what this waits for.
        void groupAccessLoaded.then(() => bridge.retireDisallowedGroups()).catch(error => log('warn', '清理不在白名单的群会话失败: ' + String(error)));
        void Promise.all([activityLoaded, scheduler.load(), proactive?.load(), noteCounter.load()]).then(() => { scheduler.start(); proactive?.start(); });
        liveness.start();
        connection.start();
        // QQ 平台说明与 qq_* 工具现按会话 agent 注入（见 ChatBridge.installChannelScope）
        return async () => {
            scheduler.stop();
            proactive?.stop();
            liveness.stop();
            await bridge.stop();
            // After the bridge: its last replies are recorded too.
            await activity.flush();
            await connection.stop();
        };
    }, 'qq-companion.lifecycle');
    // Configuration self-check: plain-language warnings, once at mount.
    const problems = selfCheck({ ...config, adminUsers: policy.adminUsers, allowAllUsers: policy.allowAllUsers });
    if (problems.length === 0)
        log('info', '配置自检通过');
    else
        for (const problem of problems)
            log('warn', '配置自检：' + problem);
    console.log('[qq-companion] mounted (listen=' + config.host + ':' + config.port + ', media=' + mediaDir + ', admins=' + policy.adminUsers.length + ')');
}
