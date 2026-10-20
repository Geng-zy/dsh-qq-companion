/**
 * dsh-qq-companion — `onebotSettings` Typert Remote service
 *
 * Host-plane root service declared in cordis.patch.yml（仓库模板同名文件）via an
 * independent insert row (`- id: onebot-settings-remote / name:
 * <DEPLOY_DIR>/lib/settings-remote.js`)，so the api-gateway discovers the
 * `onebotSettings` Remote namespace and the settings page client
 * (lib/client.js) can read/write the plugin entry's config override row.
 *
 * Contract — namespace `onebotSettings`，每方法一个 descriptor，全 positional
 * （宿主网关按 descriptor 位置序调用，methodParameterNames 拒绝解构/默认值/
 * rest，dsh-api-gateway/lib/index.js:1458-1495）：
 *
 *   getSettings()                            → OnebotSettingsSnapshot
 *   updateSettings(patch, expectedRevision)  → OnebotSettingsSnapshot
 *   listWorkspaces()                         → WorkspaceListResult（只读查询宿主
 *     dsh-workspace 注册表，供设置页「快速填入 workspace」；registry 缺席/list()
 *     失败一律降级为 {available:false, workspaces:[]}，不抛错——辅助查询绝不
 *     阻塞 getSettings/updateSettings 主链路，也绝不打开 registry 内部态）
 *
 * 持久层 = profile patch 中插件条目（行 id `dsh-onebot`）的 config 覆盖行（设置页
 * /手改 patch/宿主原生设置页三方同源，无第二优先级）。写入经宿主
 * configEditor.edit（dsh-config-editor/lib/index.js:63-123：文件锁 + 原子写 +
 * reconcile 热生效 + 激活失败自动回滚），本模块不发明第二条写路径。
 *
 * revision 语义：
 * - 每宿主进程、每服务实例一个内存计数器，从 0 开始，不持久化；
 * - 读侧每次调用将 entry.options.config 序列化为指纹与上次比较，任何来源的
 *   已提交变更都 +1（本 Remote / 宿主原生设置页 / HMR 后的手改 patch）；
 * - updateSettings 的 expectedRevision ≠ 当前值 → 拒写，抛
 *   RemoteError('onebot-settings/conflict', {expected, actual})；undefined =
 *   无条件写（对齐宿主 settingsController 的 expectedRevision 语义，
 *   dsh-api-settings-controller/lib/index.js:404）；
 * - 不递增：写入被拒（校验失败 / 锁冲突 / 激活失败回滚）、no-op（合并结果与
 *   当前生效 config 全等，跳过 edit）。
 *
 * 敏感字段：accessToken 快照返回侧脱敏——snapshot.config.accessToken 恒为
 * ''，明文是否已配置由 snapshot.secrets 标记（敏感字段行；写入侧在
 * patch 文件明文落盘是宿主既有管道默认行为，加密存储范围外）。
 *
 * @deepseek-ai/dsh-typert-protocol 不可解析时（裸 dev checkout；装好的 profile
 * 内可解析）降级为普通 cordis 服务而非炸掉插件加载（照抄
 * dsh-expert-orchestrator/lib/remote.js 的降级骨架）。
 */

import { isDeepStrictEqual } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'

/** 宿主 dsh-workspace 注册表（本模块只读消费 list()，不打开 registry 内部态）。 */
import type { WorkspaceRegistryLike } from './bridge.js'
import { Config } from './config.js'

/** patch 中插件主条目的行 id（沿用原版的 dsh-onebot，已有配置不用改）。 */
export const ENTRY_ID = 'dsh-onebot'
/** Typert Remote 命名空间 = cordis 服务键。 */
export const NAMESPACE = 'onebotSettings'
/** 快照固定值：设置页的键都是插件级热重启生效。 */
export const REMOTE_EFFECT = 'restart'

/** 设置页的分组和每组里的键（也是设置页能读写的全部键）。键的类型、默认值
 *  都从配置定义 src/config.ts 读取，这里只决定哪些键上设置页、怎么分组。 */
export const SETTINGS_GROUPS: Readonly<Record<string, readonly string[]>> = {
  connection: ['host', 'port', 'accessToken', 'botQQ', 'workspacePath'],
  permissions: ['requireMention', 'adminUsers', 'dmPolicy', 'groupPolicy', 'allowAllUsers', 'allowFrom', 'groupAllowFrom'],
  behavior: ['interimMessages', 'interimRecall', 'interimRecallMs', 'sendErrorNotice', 'unknownCommand', 'rateLimitPerMinute', 'newMessagePolicy', 'autoSteerPolicy', 'deferredTimeoutMs'],
  diagnostics: ['actionAuditEnabled', 'traceEnabled'],
  companion: ['ownerTitle', 'agentPreset', 'adminPreset', 'adminPermission', 'adminWorkspacePath', 'splitLines', 'splitMaxMessages', 'textImageThreshold', 'inboundImageMaxPx', 'autoAcceptAdminRequests', 'autoAllowInvitedGroups', 'groupSplitLines', 'humanTypingPace', 'typingDelayPerCharMs', 'typingDelayMinMs', 'typingDelayMaxMs'],
  memory: ['idleResetHours', 'privateResetDays', 'groupResetDays', 'publicMemoryFile', 'publicMemoryMaxBytes', 'groupMemoryDir', 'groupMemoryMaxBytes'],
  proactive: ['proactiveEnabled', 'proactiveChatId', 'proactiveWindowStart', 'proactiveWindowEnd', 'proactiveMinPerDay', 'proactiveMaxPerDay', 'proactiveMinGapMinutes', 'proactiveSkipIfActiveMinutes', 'proactiveMaxUnanswered'],
}

/** 设置页能读写的全部键。 */
export const ALL_KEYS: readonly string[] = Object.values(SETTINGS_GROUPS).flat()

type KeyKind = { kind: 'enum'; values: readonly string[] } | { kind: 'number' | 'boolean' | 'string' | 'string[]' }

/** 从配置定义里读出一个键的类型（schemastery 的 dict 元数据）。 */
function kindOf(key: string): KeyKind {
  const schema = (Config as unknown as { dict: Record<string, { type: string; list?: Array<{ type: string; value?: unknown }>; inner?: { type: string } }> }).dict[key]
  if (schema === undefined) throw new Error('settings-remote: 配置定义里没有 ' + key)
  if (schema.type === 'union') return { kind: 'enum', values: (schema.list ?? []).map(item => String(item.value)) }
  if (schema.type === 'array') return { kind: 'string[]' }
  if (schema.type === 'number' || schema.type === 'boolean' || schema.type === 'string') return { kind: schema.type }
  throw new Error('settings-remote: 设置页不支持 ' + key + ' 的类型 ' + schema.type)
}

const KEY_KINDS: Readonly<Record<string, KeyKind>> = Object.fromEntries(ALL_KEYS.map(key => [key, kindOf(key)]))

/** 配置定义里的默认值，快照生效值的底层。 */
export const SCHEMA_DEFAULTS: Readonly<Record<string, unknown>> = Object.fromEntries(ALL_KEYS.map(key =>
  [key, (Config as unknown as { dict: Record<string, { meta?: { default?: unknown } }> }).dict[key]?.meta?.default]))

/** 快照返回侧脱敏的键。 */
export const SECRET_KEYS: readonly string[] = ['accessToken']

/** 数字键的取值范围：端口 1–65535，其余（时长、次数、字节数）≥ 0；越界在
 *  Remote 层直接拒绝。 */
function numberRange(key: string): readonly [number, number | undefined] {
  return key === 'port' ? [1, 65535] : [0, undefined]
}

/** OnebotSettingsSnapshot。 */
export interface OnebotSettingsSnapshot {
  /** §3.1 乐观锁计数器。 */
  revision: number
  /** 插件条目 fiber 是否 active（fiber.state === 2，同 configEditor.edit 的活性判据）。 */
  entryActive: boolean
  /** 设置页各键的生效值；accessToken 脱敏为 ''。 */
  config: Record<string, unknown>
  /** 脱敏键标记：明文是否已配置。 */
  secrets: Array<{ path: string[]; set: boolean }>
  groups: Record<string, string[]>
  effect: typeof REMOTE_EFFECT
}

/** §3.1 revision 计数器状态（内存态，随宿主进程/服务实例存续）。 */
export interface RevisionState {
  revision: number
  /** 上次观察到的 entry.options.config 序列化指纹；null = 尚未建立基线。 */
  fingerprint: string | null
}

/** configEditor（dsh-config-editor）本模块实际消费的最小面。 */
export interface ConfigEditorEntry {
  options: { id?: string; name?: string; config?: Record<string, unknown> }
  fiber?: { state?: number } | undefined
}
export interface ConfigEditorLike {
  entries(): readonly ConfigEditorEntry[]
  edit(entry: ConfigEditorEntry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

interface RemoteErrorLike extends Error {
  code: string
  details?: unknown
  isDSHRemoteError?: boolean
}
type RemoteErrorCtor = new (code: string, message: string, details?: unknown, options?: ErrorOptions) => RemoteErrorLike

/** typert-protocol 不可解析时的降级错误：结构对齐 RemoteError（code/details/
 *  isDSHRemoteError 标记），保证失败路径语义一致。 */
class FallbackRemoteError extends Error implements RemoteErrorLike {
  code: string
  details?: unknown
  isDSHRemoteError = true
  constructor(code: string, message: string, details?: unknown, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.details = details
    this.name = 'RemoteError'
  }
}

let protocol: typeof import('@deepseek-ai/dsh-typert-protocol') | null = null
try {
  protocol = await import('@deepseek-ai/dsh-typert-protocol')
} catch {
  protocol = null
}
/** RemoteError 统一出口：协议在位用宿主类（跨域识别按 isDSHRemoteError），否则降级类。
 *  宿主类对 code 有 RemoteErrorDetailsMap 泛型约束（类型层），本服务使用自有
 *  onebot-settings/* 错误码（运行期任意字符串均可，网关原样透传），故统一收窄为
 *  本模块的宽松构造签名。 */
const RemoteError = (protocol?.RemoteError ?? FallbackRemoteError) as unknown as RemoteErrorCtor

/** 乐观锁/降级以外唯一会抛的宿主依赖缺失情形：configEditor 不在位。 */
function requireConfigEditor(ctx: { get(key: string): unknown } | undefined): ConfigEditorLike {
  const editor = ctx?.get?.('configEditor') as ConfigEditorLike | undefined
  if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    throw new RemoteError(
      'onebot-settings/no-config-editor',
      'configEditor service is unavailable: the onebot-settings-remote row must mount beside the host bundle\'s dsh-config-editor',
      { entryId: ENTRY_ID },
    )
  }
  return editor
}

/** 在 profile patch 的可寻址条目中定位插件主条目；不存在必须显式报错
 *。 */
function findEntry(editor: ConfigEditorLike): ConfigEditorEntry {
  const entry = editor.entries().find((candidate) => candidate?.options?.id === ENTRY_ID)
  if (!entry) {
    throw new RemoteError(
      'onebot-settings/no-entry',
      `no active "${ENTRY_ID}" entry in the profile patch — mount dsh-qq-companion first`,
      { entryId: ENTRY_ID },
    )
  }
  return entry
}

/** 条目 fiber.state === 2 = active（与 configEditor.edit 的活性判据一致）。 */
function entryActiveOf(entry: ConfigEditorEntry): boolean {
  return entry.fiber !== undefined && entry.fiber.state === 2
}

export function createRevisionState(): RevisionState {
  return { revision: 0, fingerprint: null }
}

function fingerprintOf(config: unknown): string {
  return JSON.stringify(config ?? null)
}

/** §3.1 #2：读侧观察——config 指纹相对上次有差异即 +1（任何来源的已提交变更
 *  一视同仁）；首次调用仅建立基线不递增。 */
export function observeRevision(state: RevisionState, config: unknown): number {
  const fingerprint = fingerprintOf(config)
  if (state.fingerprint !== null && fingerprint !== state.fingerprint) state.revision += 1
  state.fingerprint = fingerprint
  return state.revision
}

/** listWorkspaces 返回的单条 workspace 摘要（sessionCount = 注册表里挂在
 *  该 workspace 下的会话数，纯展示用途）。 */
export interface WorkspaceSummary {
  id: string
  path: string
  sessionCount: number
}

/** listWorkspaces 返回值。available=false = 宿主 workspaceRegistry 缺席或
 *  list() 抛错（降级语义：空列表 + 标注，不抛错——设置页隐藏快速填入行并提示
 *  可直接输入路径）。 */
export interface WorkspaceListResult {
  available: boolean
  workspaces: WorkspaceSummary[]
}

/** listWorkspaces 纯实现（descriptor 方法体共用；对 registry 形状做防御性
 *  校验——与 requireConfigEditor 同款「运行期再校验形状」风格，但绝不抛错：
 *  缺席/形状不符/list() 失败都归一为 unavailable 空列表）。 */
export function listWorkspaces(registry: WorkspaceRegistryLike | undefined): WorkspaceListResult {
  if (registry === undefined || typeof registry.list !== 'function') {
    return { available: false, workspaces: [] }
  }
  try {
    const workspaces = registry.list().map((workspace) => ({
      id: String(workspace?.id ?? ''),
      path: String(workspace?.path ?? ''),
      sessionCount: Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.length : 0,
    }))
    return { available: true, workspaces }
  } catch {
    // 只读辅助查询：注册表异常（存储失败等）不该炸掉设置页，降级为不可用。
    return { available: false, workspaces: [] }
  }
}

/** 惰性解析宿主 workspaceRegistry（不经 static inject——保持可选依赖，
 *  registry 缺席时服务照常挂载，仅 listWorkspaces 降级 unavailable）。 */
function resolveWorkspaceRegistry(ctx: { get(key: string): unknown } | undefined): WorkspaceRegistryLike | undefined {
  const registry = ctx?.get?.('workspaceRegistry') as WorkspaceRegistryLike | undefined
  return registry !== undefined && registry !== null && typeof registry.list === 'function' ? registry : undefined
}

/** 设置页各键的生效值 = 配置定义的默认值 ← 条目 config 覆盖。 */
export function effectiveConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const effective: Record<string, unknown> = {}
  for (const key of ALL_KEYS) {
    const value = raw[key]
    effective[key] = value === undefined ? SCHEMA_DEFAULTS[key] : value
  }
  return effective
}

function buildSnapshot(entry: ConfigEditorEntry, state: RevisionState): OnebotSettingsSnapshot {
  const raw = entry.options.config ?? {}
  const revision = observeRevision(state, raw)
  const config = effectiveConfig(raw)
  const secrets = SECRET_KEYS.map((key) => {
    const set = typeof raw[key] === 'string' && (raw[key] as string).length > 0
    config[key] = '' // 脱敏：快照不回显明文
    return { path: [key], set }
  })
  return {
    revision,
    entryActive: entryActiveOf(entry),
    config,
    secrets,
    groups: Object.fromEntries(Object.entries(SETTINGS_GROUPS).map(([group, keys]) => [group, [...keys]])),
    effect: REMOTE_EFFECT,
  }
}

/** updateSettings 入参校验。未知键整单
 *  拒绝（不静默丢弃）；类型/枚举不符拒绝；具体取值合法性交由宿主 schemastery
 *  校验 + reconcile 失败自动回滚兜底。 */
export function validatePatch(patch: unknown): Record<string, unknown> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new RemoteError('onebot-settings/bad-request', 'patch must be a flat JSON object keyed by setting names', {
      issues: ['patch 必须是扁平 JSON 对象'],
    })
  }
  const issues: string[] = []
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const spec = Object.hasOwn(KEY_KINDS, key) ? KEY_KINDS[key] : undefined
    if (spec === undefined) {
      issues.push(`未知设置键 "${key}"（仅支持 ${ALL_KEYS.length} 键：${ALL_KEYS.join(', ')}）`)
    } else if (spec.kind === 'enum') {
      if (typeof value === 'string' && spec.values.includes(value)) clean[key] = value
      else issues.push(`${key} 必须是 ${spec.values.join(' | ')} 之一`)
    } else if (spec.kind === 'number') {
      const [min, max] = numberRange(key)
      if (typeof value === 'number' && Number.isFinite(value) && value >= min && (max === undefined || value <= max)) clean[key] = value
      else issues.push(`${key} 必须是 ${max === undefined ? `≥${min}` : `${min}–${max}`} 的有限数字`)
    } else if (spec.kind === 'boolean') {
      if (typeof value === 'boolean') clean[key] = value
      else issues.push(`${key} 必须是布尔值`)
    } else if (spec.kind === 'string') {
      if (typeof value === 'string') clean[key] = value
      else issues.push(`${key} 必须是字符串`)
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      clean[key] = value
    } else {
      issues.push(`${key} 必须是字符串数组`)
    }
  }
  if (issues.length > 0) {
    throw new RemoteError('onebot-settings/bad-request', `invalid settings patch: ${issues.join('; ')}`, { issues })
  }
  return clean
}

/** getSettings 实现（descriptor 方法体共用；descriptor 参数 0 个）。 */
export function getSettings(editor: ConfigEditorLike, state: RevisionState): OnebotSettingsSnapshot {
  return buildSnapshot(findEntry(editor), state)
}

/** 错误归一：宿主 configEditor.edit 的原生失败（文件锁超时 / 活性检查 /
 *  schema 校验 / home-patch 守卫 / 激活失败回滚后 rethrow）按
 *  宿主错误类型归类，转成面板可直接渲染的
 *  中文 RemoteError('onebot-settings/edit-failed')，原始错误挂 cause（网关透传
 *  detail 不吞诊断信息）。归类按宿主错误消息特征词匹配，未命中走通用文案；
 *  所有分支的共同事实（该文档 §3 已钉死）：失败时 patch 文件要么从未被写、要么
 *  已被宿主逐字节还原，本模块不做任何补偿写（不重试、不回写），仅归一转发。 */
export const EDIT_FAILED_CODE = 'onebot-settings/edit-failed'
export function describeEditFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/timed out waiting for the writer lock/i.test(message)) {
    return '写入失败：配置文件被其他写入方占用（等待文件锁超时），本次修改未落盘，请稍后重试'
  }
  if (/no longer available|changed during reload/i.test(message)) {
    return '写入失败：QQ 插件条目在编辑期间被替换或失活，本次修改未落盘，请刷新后重试'
  }
  if (/no longer active/i.test(message)) {
    return '写入失败：QQ 插件当前未激活，本次修改未落盘，请检查插件加载状态'
  }
  if (/overridden by a home patch|command-line overlay/i.test(message)) {
    return '写入失败：该配置被 home patch 或命令行覆盖层接管，修改被宿主拒绝；请改在对应层修改'
  }
  return `写入失败：宿主 configEditor 拒绝了本次修改（${message}），配置保持不变`
}

/** updateSettings 实现（descriptor 参数 (patch, expectedRevision)，全 positional）。
 *
 * 流程：定位条目 → 观察当前 revision → 乐观锁校验 → patch 校验 → no-op 短路
 * （合并结果与当前生效 config 全等则不写、不递增）→ configEditor.edit 合并写
 * （next = fresh config ∪ patch，未知原键原样保留；等于继承层时由宿主整行删
 * 除覆盖行，dsh-config-editor/lib/index.js:93-104）→ 成功后返回新快照（指纹
 * 变化 → revision +1）。
 *
 * edit 失败不再裸抛宿主原生 Error（此前锁超时/激活回滚等错误绕开
 * onebot-settings/* 错误码体系直达网关，面板拿到的是英文技术文案）——按
 * describeEditFailure 归一为 onebot-settings/edit-failed 中文错误并保留 cause；
 * 失败路径 revision 不递增（指纹观察只在成功后的 buildSnapshot 发生）、不重试、
 * 不补偿写，patch 文件由宿主保证未被破坏。 */
export async function updateSettings(
  editor: ConfigEditorLike,
  state: RevisionState,
  patch: unknown,
  expectedRevision?: number,
): Promise<OnebotSettingsSnapshot> {
  const entry = findEntry(editor)
  const actual = observeRevision(state, entry.options.config ?? {})
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision !== actual)) {
    throw new RemoteError(
      'onebot-settings/conflict',
      `expectedRevision ${String(expectedRevision)} does not match current revision ${actual}; re-read getSettings() and replay`,
      { expected: expectedRevision, actual },
    )
  }
  const clean = validatePatch(patch)
  const current = entry.options.config ?? {}
  const merged = { ...current, ...clean }
  if (isDeepStrictEqual(merged, current)) return buildSnapshot(entry, state) // no-op：不递增（§3.1 #4）
  try {
    await editor.edit(entry, (fresh) => ({ ...fresh, ...clean }))
  } catch (cause) {
    // 错误归一：只翻译、不重试、不补偿写；宿主已保证 patch 文件未被破坏或已逐字节还原。
    // details 带宿主原文（可跨网关序列化），cause 仅进程内诊断。
    throw new RemoteError(EDIT_FAILED_CODE, describeEditFailure(cause), { hostMessage: cause instanceof Error ? cause.message : String(cause) }, { cause })
  }
  return buildSnapshot(findEntry(editor), state)
}

/** 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。
 *  workspaceRegistry 可选注入——省略时 listWorkspaces 降级 unavailable
 *  （与类分支的惰性 ctx 解析同一 listWorkspaces 纯函数出口）。 */
export function createOnebotSettingsMethods(
  editor: ConfigEditorLike,
  state: RevisionState = createRevisionState(),
  workspaceRegistry?: WorkspaceRegistryLike,
): {
  getSettings(): Promise<OnebotSettingsSnapshot> | OnebotSettingsSnapshot
  updateSettings(patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot>
  listWorkspaces(): Promise<WorkspaceListResult>
} {
  return {
    getSettings: () => getSettings(editor, state),
    updateSettings: (patch, expectedRevision) => updateSettings(editor, state, patch, expectedRevision),
    listWorkspaces: async () => listWorkspaces(workspaceRegistry),
  }
}

/** 把 typert-protocol 的 Remote 标记应用到类原型（无原生装饰器语法的 shim，
 *  照抄 dsh-expert-orchestrator/lib/remote.js:99-115；mark() 对同一原型幂等）。 */
function markRemote(klass: object, methodName: string): void {
  if (!protocol?.Remote) return
  const initializers: Array<(this: unknown) => void> = []
  const decorator = protocol.Remote(methodName) as unknown as (
    method: undefined,
    context: { name: string; private: boolean; static: boolean; addInitializer(fn: () => void): void },
  ) => void
  decorator(undefined, {
    name: methodName,
    private: false,
    static: false,
    addInitializer(fn) { initializers.push(fn) },
  })
  const receiver = Object.create((klass as { prototype: object }).prototype)
  for (const fn of initializers) fn.call(receiver)
}

/** 服务装配：协议在位 → TypertRemoteService 子类（网关按 typertRemote 绑定 +
 *  原型 descriptor 发现）；否则降级为普通 cordis 服务（同名方法面，仅无网关
 *  发现）。两个分支共用上方导出的实现函数与同一 descriptor 形状。 */
// 显式 any：两个分支的类形状在运行期二选一，降级分支没有 Service 基类可声明。
let OnebotSettingsService: any
if (protocol?.TypertRemoteService) {
  class OnebotSettingsRemote extends protocol.TypertRemoteService {
    static inject = ['configEditor', 'profileContext']
    readonly state: RevisionState = createRevisionState()
    /** Service 基类的 ctx 为 protected 且跨包声明，此处自存一份只读引用供惰性解析。 */
    private readonly ownerCtx: Context

    constructor(ctx: Context) {
      super(ctx, NAMESPACE)
      this.ownerCtx = ctx
    }

    /** 惰性解析宿主 configEditor（static inject 保证在位；运行期再校验形状）。 */
    configEditor(): ConfigEditorLike {
      return requireConfigEditor(this.ownerCtx)
    }

    async getSettings(): Promise<OnebotSettingsSnapshot> {
      return getSettings(this.configEditor(), this.state)
    }

    async updateSettings(patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot> {
      return updateSettings(this.configEditor(), this.state, patch, expectedRevision)
    }

    /** 只读查询宿主 workspace 注册表（惰性解析，缺席降级 unavailable，不抛错）。 */
    async listWorkspaces(): Promise<WorkspaceListResult> {
      return listWorkspaces(resolveWorkspaceRegistry(this.ownerCtx))
    }
  }
  markRemote(OnebotSettingsRemote, 'getSettings')
  markRemote(OnebotSettingsRemote, 'updateSettings')
  markRemote(OnebotSettingsRemote, 'listWorkspaces')
  OnebotSettingsService = OnebotSettingsRemote
} else {
  console.warn('[qq-companion] @deepseek-ai/dsh-typert-protocol unavailable — onebotSettings remote degrades to a plain cordis service')
  class OnebotSettingsPlain {
    static inject = ['configEditor', 'profileContext']
    name = NAMESPACE
    state: RevisionState = createRevisionState()
    private ctx: { get(key: string): unknown } | undefined

    constructor(ctx: { get(key: string): unknown }) {
      this.ctx = ctx
    }

    configEditor(): ConfigEditorLike {
      return requireConfigEditor(this.ctx)
    }

    getSettings(): OnebotSettingsSnapshot {
      return getSettings(this.configEditor(), this.state)
    }

    async updateSettings(patch: unknown, expectedRevision?: number): Promise<OnebotSettingsSnapshot> {
      return updateSettings(this.configEditor(), this.state, patch, expectedRevision)
    }

    /** 与 typert 分支同一惰性解析 + 降级语义。 */
    async listWorkspaces(): Promise<WorkspaceListResult> {
      return listWorkspaces(resolveWorkspaceRegistry(this.ctx))
    }
  }
  OnebotSettingsService = OnebotSettingsPlain
}

export default OnebotSettingsService
export { OnebotSettingsService }
