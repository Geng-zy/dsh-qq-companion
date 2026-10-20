/**
 * Shared bridge test harnesses: the fake agent
 * registry, the full reverse-WS harness, the compact command harness, and
 * the disconnect/reconnect helpers. Extracted from bridge.spec.ts so
 * the five-split target specs (commands/inbound/outbound/interim/registry)
 * can reuse the same stubs.
 * @module dsh-qq-companion/tests/helpers/bridge-harness
 */
import { expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import WebSocket from 'ws'

import { OneBotConnection } from '../../src/connection.js'
import { ChatBridge } from '../../src/bridge.js'
import { MediaStore } from '../../src/media.js'
import { Transcriber } from '../../src/stt.js'
import { TraceSink } from '../../src/trace.js'

/** A fake agent handle for the bridge. */
export function makeFakeAgents(
  sessionIds: string[],
  captured: { followups: Array<{ text: string; sessionId: string }>; steers?: Array<{ text: string; sessionId: string }>; createdMeta?: Array<{ cwd?: string; agentPreset?: string }> },
  opts?: { failCreateFor?: string; resumeOk?: boolean; createDelayMs?: number },
) {
  const disposed: string[] = []
  const agents = {
    create: vi.fn(async (options: { sessionId: string; meta?: { cwd?: string; agentPreset?: string }; setup?: (agentCtx: unknown) => unknown }) => {
      if (opts?.createDelayMs !== undefined) await new Promise(resolve => setTimeout(resolve, opts.createDelayMs))
      const sessionId = String(options.sessionId)
      sessionIds.push(sessionId)
      captured.createdMeta?.push({ ...options.meta })
      if (opts?.failCreateFor !== undefined && sessionId === opts.failCreateFor) {
        throw new Error('session "' + sessionId + '" already has a persisted log on disk that does not match this live session (id collision)')
      }
      const agent = {
        session: { id: sessionId, seq: 0, header: { cwd: options.meta?.cwd ?? process.cwd() } },
        status: 'idle',
        cancel: () => { agent.status = 'idle' },
        followup: (message: { content: Array<{ type: string; text?: string }> }) => {
          const text = message.content.map(b => b.text ?? '').join('')
          captured.followups.push({ text, sessionId })
        },
        // the transcript steer path (raw text capture).
        steer: (message: { content: Array<{ type: string; text?: string }> }) => {
          captured.steers?.push({ text: message.content.map(b => b.text ?? '').join(''), sessionId })
        },
        whenIdle: async () => undefined,
      }
      if (typeof options.setup === 'function') {
        // Agent setup receives the agent's own scope: platform prompt section
        // + qq_* tools must register here (installChannelScope), never on the
        // plugin context.
        const agentCtx = {
          on: () => () => undefined,
          systemPrompt: { section: (s: { name: string }) => { captured.channelSections?.push(s.name); return () => undefined } },
          tools: { register: (t: { name: string }) => { captured.channelTools?.push(t.name); return () => undefined } },
        }
        await options.setup(agentCtx)
      }
      return { agent, dispose: vi.fn(async () => { disposed.push(sessionId) }) }
    }),
    disposed,
    resume: vi.fn(async (options: { resumeSessionId: string; setup?: (agentCtx: unknown) => unknown }) => {
      if (opts?.resumeOk !== true) throw new Error('not persisted')
      const sessionId = String(options.resumeSessionId)
      sessionIds.push(sessionId)
      const agent = {
        session: { id: sessionId, seq: 1, header: { cwd: process.cwd() } },
        status: 'idle',
        cancel: () => { agent.status = 'idle' },
        followup: (message: { content: Array<{ type: string; text?: string }> }) => {
          const text = message.content.map(b => b.text ?? '').join('')
          captured.followups.push({ text, sessionId })
        },
        steer: (message: { content: Array<{ type: string; text?: string }> }) => {
          captured.steers?.push({ text: message.content.map(b => b.text ?? '').join(''), sessionId })
        },
        whenIdle: async () => undefined,
      }
      if (typeof options.setup === 'function') {
        await options.setup({ on: () => () => undefined, systemPrompt: { section: () => () => undefined }, tools: { register: () => () => undefined } })
      }
      return { agent, dispose: async () => undefined }
    }),
  }
  return agents
}

/** Full bridge + WS harness: inbound via real WebSocket, outbound captured. */
export async function makeHarness(opts?: { failCreateFor?: string; mediaDir?: string; interimMessages?: boolean; textImageThreshold?: number; maxImageBytes?: number; resumeOk?: boolean; createDelayMs?: number; transcriber?: Transcriber; trace?: TraceSink; ignoreSelf?: boolean; newMessagePolicy?: 'queue' | 'steer'; deferredTimeoutMs?: number; log?: (level: string, message: string) => void }) {
  const ctx = new Context()
  const sessionIds: string[] = []
  const captured = { followups: [] as Array<{ text: string; sessionId: string }>, steers: [] as Array<{ text: string; sessionId: string }>, channelTools: [] as string[], channelSections: [] as string[] }
  const agents = makeFakeAgents(sessionIds, captured, opts)
  const sessions = { flush: vi.fn(async () => undefined) }
  const mediaDir = opts?.mediaDir ?? mkdtempSync(join(tmpdir(), 'onebot-test-'))
  const connection = new OneBotConnection({
    host: '127.0.0.1', port: 0, accessToken: 'test-token', callTimeoutMs: 3_000,
  })
  const bridge = new ChatBridge({
    ctx,
    connection,
    media: new MediaStore(join(mediaDir, 'media'), 6),
    transcriber: opts?.transcriber ?? new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
    agents: agents as never,
    sessions: sessions as never,
    agentPresets: undefined as never,
    workspaceRegistry: undefined as never,
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: opts?.ignoreSelf ?? false, requireMention: true,
      interimMessages: opts?.interimMessages ?? true, sendErrorNotice: true, restrictedMemberPrefix: false,
      sensitivePatterns: [], mediaDir, maxImageBytes: opts?.maxImageBytes ?? 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      textImageThreshold: opts?.textImageThreshold ?? 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      agentPreset: 'standard', workspacePath: mediaDir,
      // busy-turn policy override (absent = the 'queue' default).
      ...(opts?.newMessagePolicy !== undefined ? { newMessagePolicy: opts.newMessagePolicy } : {}),
      // deferred-delivery timeout override (absent = the 10min default).
      ...(opts?.deferredTimeoutMs !== undefined ? { deferredTimeoutMs: opts.deferredTimeoutMs } : {}),
      // optional decision-trace sink (absent = tracing off).
      trace: opts?.trace,
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: (level: string, message: string) => opts?.log?.(level, message),
  })
  connection.onMessage = event => {
    void bridge.handleInbound(event)
  }
  bridge.start()
  connection.start()
  await vi.waitFor(() => expect(connection.address()).toBeDefined())
  const address = connection.address()!
  const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
  await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
  const outbound: Array<Record<string, unknown>> = []
  client.on('message', data => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>
    outbound.push(frame)
    if (typeof frame.echo === 'string') {
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
    }
  })
  const sendText = (text: string): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: 10001, nickname: '小明' },
    }))
  }
  return { ctx, sessionIds, captured, sessions, mediaDir, connection, bridge, client, outbound, sendText }
}

export function makeEvent(type: string, data: unknown): SessionEvent {
  return { seq: 0, time: Date.now(), type: type as never, data: data as never } as SessionEvent
}

/** Compact harness for the slash-command tests (options inject stubs). */
export async function makeCmdHarness(opts?: {
  agentPresets?: unknown
  dshHome?: string
  interimMessages?: boolean
  unknownCommand?: 'intercept' | 'passthrough'
  interimRecallMs?: number
  interimRecall?: boolean
  rateLimitPerMinute?: number
  restrictedMemberPrefix?: boolean
  newMessagePolicy?: 'queue' | 'steer'
  /** auto-steer eligibility knob; absent = the bridge default 'admin'. */
  autoSteerPolicy?: 'admin' | 'all'
  /** deferred-delivery timeout override (absent = the 10min default). */
  deferredTimeoutMs?: number
  /** media dir override（重启恢复测试复用同一目录的注册表/映射文件）。 */
  mediaDir?: string
  commands?: unknown
  /** Admin private-chat defaults. */
  adminPreset?: string
  adminPermission?: string
  adminWorkspacePath?: string
  idleResetHours?: number
  groupMemoryDir?: string
  privateResetDays?: number
  groupResetDays?: number
  activity?: unknown
  allowAllUsers?: boolean
  agentDefaultModel?: unknown
  workspaceRegistry?: unknown
  /** /session list previews: a SessionPersistenceLike stub (stat probe +
   * open read handles). Absent = the bridge sees no persistence service and
   * the list renders preview-less items. */
  sessionPersistence?: unknown
  /** optional trace sink (absent = tracing off). */
  trace?: TraceSink
  /** optional log capture for reference-number assertions. */
  log?: (level: string, message: string) => void
  /** Group access (absent = open). The array is used as-is, so a test can
   * mutate it like GroupAccess does. */
  groupPolicy?: 'open' | 'allowlist' | 'disabled'
  groupAllowFrom?: string[]
  /** Risk control wiring (a typingPacer also turns humanTypingPace on). */
  typingPacer?: { wait(text: string): Promise<void> }
  sendCounter?: { record(): void }
  splitLines?: boolean
  groupSplitLines?: boolean
}) {
  const ctx = new Context()
  const sessionIds: string[] = []
  const capturedMeta: Array<{ cwd?: string; agentPreset?: string }> = []
  // steers are captured alongside followups so the /steer and
  // 'steer'-policy tests can assert the exact steered text.
  const captured = { followups: [] as Array<{ text: string; sessionId: string }>, steers: [] as Array<{ text: string; sessionId: string }>, createdMeta: capturedMeta }
  const agents = makeFakeAgents(sessionIds, captured)
  const sessions = { flush: vi.fn(async () => undefined) }
  const mediaDir = opts?.mediaDir ?? mkdtempSync(join(tmpdir(), 'onebot-test-'))
  const connection = new OneBotConnection({
    host: '127.0.0.1', port: 0, accessToken: 'test-token', callTimeoutMs: 3_000,
  })
  const bridge = new ChatBridge({
    ctx,
    connection,
    dshHome: opts?.dshHome,
    media: new MediaStore(join(mediaDir, 'media'), 6),
    transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10_000 }),
    agents: agents as never,
    sessions: sessions as never,
    agentPresets: opts?.agentPresets as never,
    ...(opts?.activity !== undefined ? { activity: opts.activity as never } : {}),
    commands: (opts?.commands ?? {
      execute: vi.fn(async (_agent: unknown, _line: string, attachments: readonly unknown[], signal: AbortSignal | undefined) => {
        // Mirror the host: execute() reads submittedAttachments.length and
        // signal.aborted unconditionally.
        if (!Array.isArray(attachments)) throw new Error("Cannot read properties of undefined (reading 'length')")
        if (signal === undefined) throw new Error("Cannot read properties of undefined (reading 'aborted')")
        return { commandId: 'cmd-test', result: { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' } }
      }),
    }) as never,
    sessionPersistence: (opts?.sessionPersistence ?? undefined) as never,
    workspaceRegistry: (opts?.workspaceRegistry ?? undefined) as never,
    agentDefaultModel: (opts?.agentDefaultModel ?? undefined) as never,
    defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      interimMessages: opts?.interimMessages ?? true,
      ...(opts?.unknownCommand !== undefined ? { unknownCommand: opts.unknownCommand } : {}),
      ...(opts?.interimRecallMs !== undefined ? { interimRecallMs: opts.interimRecallMs } : {}),
      ...(opts?.interimRecall !== undefined ? { interimRecall: opts.interimRecall } : {}),
      ...(opts?.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: opts.rateLimitPerMinute } : {}),
      sendErrorNotice: true,
      ...(opts?.restrictedMemberPrefix !== undefined ? { restrictedMemberPrefix: opts.restrictedMemberPrefix } : {}),
      ...(opts?.newMessagePolicy !== undefined ? { newMessagePolicy: opts.newMessagePolicy } : {}),
      ...(opts?.autoSteerPolicy !== undefined ? { autoSteerPolicy: opts.autoSteerPolicy } : {}),
      // deferred-delivery timeout override (absent = the 10min default).
      ...(opts?.deferredTimeoutMs !== undefined ? { deferredTimeoutMs: opts.deferredTimeoutMs } : {}),
      sensitivePatterns: [], mediaDir, maxImageBytes: 8 * 1024 * 1024,
      maxVoiceBytes: 15 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024,
      textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
      agentPreset: 'standard', workspacePath: mediaDir,
      ...(opts?.adminPreset !== undefined ? { adminPreset: opts.adminPreset } : {}),
      ...(opts?.adminPermission !== undefined ? { adminPermission: opts.adminPermission } : {}),
      ...(opts?.adminWorkspacePath !== undefined ? { adminWorkspacePath: opts.adminWorkspacePath } : {}),
      ...(opts?.idleResetHours !== undefined ? { idleResetHours: opts.idleResetHours } : {}),
      ...(opts?.groupMemoryDir !== undefined ? { groupMemoryDir: opts.groupMemoryDir } : {}),
      ...(opts?.privateResetDays !== undefined ? { privateResetDays: opts.privateResetDays } : {}),
      ...(opts?.groupResetDays !== undefined ? { groupResetDays: opts.groupResetDays } : {}),
      ...(opts?.trace !== undefined ? { trace: opts.trace } : {}),
      ...(opts?.splitLines !== undefined ? { splitLines: opts.splitLines, typingDelayMinMs: 0, typingDelayMaxMs: 0, typingDelayPerCharMs: 0 } : {}),
      ...(opts?.groupSplitLines !== undefined ? { groupSplitLines: opts.groupSplitLines } : {}),
      ...(opts?.typingPacer !== undefined ? { humanTypingPace: true } : {}),
    },
    ...(opts?.typingPacer !== undefined ? { typingPacer: opts.typingPacer } : {}),
    ...(opts?.sendCounter !== undefined ? { sendCounter: opts.sendCounter } : {}),
    policy: {
      dmPolicy: 'open', groupPolicy: opts?.groupPolicy ?? 'open', allowFrom: [], groupAllowFrom: opts?.groupAllowFrom ?? [],
      adminUsers: ['10001'], allowAllUsers: opts?.allowAllUsers ?? false, requireMention: true,
    },
    log: (level: string, message: string) => opts?.log?.(level, message),
  })
  connection.onMessage = event => { void bridge.handleInbound(event) }
  bridge.start()
  connection.start()
  await vi.waitFor(() => expect(connection.address()).toBeDefined())
  const address = connection.address()!
  const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
  await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
  const outbound: Array<Record<string, unknown>> = []
  client.on('message', data => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>
    outbound.push(frame)
    if (typeof frame.echo === 'string') {
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
    }
  })
  const sendText = (text: string): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: 10001, nickname: '小明' },
    }))
  }
  // Variant senders for the turn-role tests (non-default users / group).
  const sendTextAs = (text: string, userId: number): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'private', user_id: userId, self_id: 10002,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: userId, nickname: '用户' + userId },
    }))
  }
  const sendGroupTextAs = (text: string, userId: number): void => {
    client.send(JSON.stringify({
      post_type: 'message', message_type: 'group', user_id: userId, group_id: 888, self_id: 10002,
      message: [
        { type: 'at', data: { qq: '10002' } },
        { type: 'text', data: { text } },
      ],
      raw_message: '[CQ:at,qq=10002]' + text,
      sender: { user_id: userId, nickname: '用户' + userId },
    }))
  }
  const chats = () => (bridge as unknown as {
    chats: Map<string, { agent: { session: { id: string } }, lastFollowup: string | undefined, busy: boolean }>
  }).chats
  return { ctx, sessionIds, capturedMeta, captured, sessions, mediaDir, connection, bridge, client, outbound, sendText, sendTextAs, sendGroupTextAs, chats }
}

/** Close the harness client and wait until the bridge sees the disconnect. */
export async function disconnect(h: Awaited<ReturnType<typeof makeHarness>>): Promise<void> {
  h.client.close()
  await vi.waitFor(() => expect(h.connection.connected).toBe(false))
}

/** Reconnect a fresh WS client with the echo responder; returns its own captured outbound. */
export async function reconnect(h: Awaited<ReturnType<typeof makeHarness>>): Promise<{ client: WebSocket; outbound: Array<Record<string, unknown>> }> {
  const client = new WebSocket('ws://127.0.0.1:' + h.connection.address()!.port + '/ws', { headers: { Authorization: 'Bearer test-token' } })
  const outbound: Array<Record<string, unknown>> = []
  client.on('message', data => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>
    outbound.push(frame)
    if (typeof frame.echo === 'string') {
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: frame.echo }))
    }
  })
  await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
  return { client, outbound }
}

export const inboundAndDisconnect = async (h: Awaited<ReturnType<typeof makeHarness>>): Promise<{ id: string }> => {
  h.sendText('hi')
  await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
  const session = { id: h.sessionIds[0] }
  await disconnect(h)
  return session
}

export const sentTexts = (outbound: Array<Record<string, unknown>>): string[] =>
  outbound.filter(f => f.action === 'send_msg').map(f => JSON.stringify(f.params))

/** The bridge's internal ChatRegistry (tests reach into it directly). */
export function registryOf(h: { bridge: unknown }): ChatRegistry {
  return (h.bridge as unknown as { registry: ChatRegistry }).registry
}
