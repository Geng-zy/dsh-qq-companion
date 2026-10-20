#!/usr/bin/env node
// End-to-end test: a real `dsh web` host loads this checkout as a profile
// bundle, a fake DeepSeek endpoint (Anthropic Messages SSE) answers the model
// calls, and a fake NapCat dials the plugin's reverse WebSocket.
//
// Checks: wrong token is refused (4401); /status and /doctor are answered
// without the model; a private message from the admin reaches the model with
// the QQ text and the reply comes back as send_msg; a group message without
// @ is ignored, one with @ gets a reply.
//
// Needs `dsh` on PATH and a built lib/ (./scripts/build.sh). No network, no
// real API key. Usage: node scripts/e2e.mjs   (exit 0 = pass)
// E2E_HOLD=1 keeps the host running after the checks (web UI on
// E2E_WEB_PORT, default random) to look at the settings page; Ctrl-C ends it.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import WebSocket from 'ws'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = 'e2e-token'
const ADMIN = 123450001
const BOT = 123450009
const GROUP = 888000001
const WS_PORT = 18000 + Math.floor(Math.random() * 1000)
const REPLY = 'E2E模型回复：收到啦'
const deadline = Date.now() + Number(process.env.E2E_TIMEOUT_MS ?? 180_000)

const log = (...a) => console.log('[e2e]', ...a)
const fail = async message => { console.error('[e2e] FAIL: ' + message); await cleanup(); process.exit(1) }

// ---- fake DeepSeek (Anthropic Messages, streaming)
const modelRequests = []
const llm = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found"}}')
      return
    }
    const json = JSON.parse(body || '{}')
    modelRequests.push(json)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const ev = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
    ev('message_start', { message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: json.model ?? 'e2e', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: REPLY } })
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
    ev('message_stop', {})
    res.end()
  })
})
await new Promise(r => llm.listen(0, '127.0.0.1', r))
const llmUrl = 'http://127.0.0.1:' + llm.address().port + '/anthropic'
log('fake model at ' + llmUrl)

// ---- isolated DSH_HOME with this checkout as a profile bundle
const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-'))
const profile = join(home, 'profiles', 'web')
mkdirSync(join(profile, 'node_modules'), { recursive: true })
symlinkSync(ROOT, join(profile, 'node_modules', 'dsh-qq-companion'), 'dir')
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-qq-companion'] } },
  dependencies: { 'dsh-qq-companion': 'link:' + ROOT },
}, null, 2))
const workspace = join(home, 'workspace')
mkdirSync(workspace)
writeFileSync(join(profile, 'cordis.patch.yml'), `- id: dsh-onebot
  name: 'dsh-qq-companion'
  config:
    mode: reverse
    host: 127.0.0.1
    port: ${WS_PORT}
    accessToken: ${TOKEN}
    botQQ: '${BOT}'
    adminUsers: ['${ADMIN}']
    groupPolicy: allowlist
    groupAllowFrom: ['${GROUP}']
    requireMention: true
    workspacePath: ${workspace}
    sttEnabled: false
    textImageThreshold: 0
`)

const dsh = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', process.env.E2E_WEB_PORT ?? '0', '--no-open'], {
  env: { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'sk-e2e-fake', DEEPSEEK_BASE_URL: llmUrl, DSH_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let dshLog = ''
for (const s of [dsh.stdout, dsh.stderr]) s.on('data', d => { dshLog += d; if (process.env.E2E_VERBOSE) process.stdout.write(d) })
dsh.on('exit', code => { if (!finished) void fail('dsh exited early (' + code + ')\n' + dshLog.slice(-4000)) })

let finished = false
// dsh still writes into its home while shutting down: wait for it to exit
// before removing the temp home.
async function cleanup() {
  finished = true
  if (dsh.exitCode === null && dsh.signalCode === null) {
    const exited = new Promise(resolve => dsh.once('exit', resolve))
    try { dsh.kill('SIGTERM') } catch {}
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 15_000))])
    if (dsh.exitCode === null && dsh.signalCode === null) try { dsh.kill('SIGKILL') } catch {}
  }
  llm.close()
  if (!process.env.E2E_KEEP) rmSync(home, { recursive: true, force: true })
}

// ---- fake NapCat
const url = 'ws://127.0.0.1:' + WS_PORT + '/ws'
async function dial(token) {
  for (;;) {
    if (Date.now() > deadline) await fail('plugin WS never came up\n' + dshLog.slice(-4000))
    const result = await new Promise(resolve => {
      const ws = new WebSocket(url, token === undefined ? {} : { headers: { Authorization: 'Bearer ' + token } })
      ws.once('open', () => resolve({ ws }))
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }))
      ws.once('close', code => resolve({ closed: code }))
      ws.once('error', error => resolve({ error }))
    })
    if (result.error?.code === 'ECONNREFUSED') { await new Promise(r => setTimeout(r, 500)); continue }
    return result
  }
}

// 1. wrong token refused
const bad = await dial('wrong-token')
if (bad.ws) {
  const code = await new Promise(r => bad.ws.once('close', c => r(c)))
  if (code !== 4401) await fail('wrong token: expected close 4401, got ' + code)
} else if (bad.status !== 401 && bad.closed !== 4401) {
  await fail('wrong token: unexpected result ' + JSON.stringify({ status: bad.status, closed: bad.closed, error: String(bad.error ?? '') }))
}
log('wrong token refused ✓')

// 2. good token: talk
const good = await dial(TOKEN)
if (!good.ws) await fail('good token refused: ' + JSON.stringify({ status: good.status, closed: good.closed }))
const ws = good.ws
const sends = []
let msgId = 7000
ws.on('message', data => {
  const frame = JSON.parse(data.toString())
  if (typeof frame.action !== 'string') return
  if (frame.action === 'send_msg' || frame.action === 'send_private_msg' || frame.action === 'send_group_msg') {
    const segs = frame.params?.message ?? []
    const text = (Array.isArray(segs) ? segs : [segs]).map(s => s?.data?.text ?? '').join('')
    sends.push({ to: frame.params?.user_id ?? frame.params?.group_id, text })
    log('<< ' + text.slice(0, 80))
  }
  const data2 = frame.action === 'get_login_info' ? { user_id: BOT, nickname: 'e2e' }
    : frame.action === 'get_status' ? { online: true, good: true }
    : { message_id: msgId++ }
  ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: data2, echo: frame.echo }))
})
ws.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect', time: Math.floor(Date.now() / 1000), self_id: BOT }))

const privateMsg = text => ws.send(JSON.stringify({
  post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: ADMIN, self_id: BOT, time: Math.floor(Date.now() / 1000),
  message_id: msgId++, message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: ADMIN, nickname: '测试主人' },
}))
const groupMsg = (text, from, mention = false) => ws.send(JSON.stringify({
  post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: GROUP, user_id: from, self_id: BOT, time: Math.floor(Date.now() / 1000),
  message_id: msgId++,
  message: [...(mention ? [{ type: 'at', data: { qq: String(BOT) } }] : []), { type: 'text', data: { text } }],
  raw_message: (mention ? '[CQ:at,qq=' + BOT + '] ' : '') + text,
  sender: { user_id: from, nickname: '群友', card: '' },
}))
async function until(what, cond, ms = 90_000) {
  const end = Math.min(deadline, Date.now() + ms)
  while (!cond()) {
    if (Date.now() > end) await fail('timed out waiting for ' + what + '\nsends=' + JSON.stringify(sends) + '\n' + dshLog.slice(-4000))
    await new Promise(r => setTimeout(r, 200))
  }
}

// Slash command: answered by the plugin, no model call.
privateMsg('/status')
await until('/status reply', () => sends.some(s => s.to === ADMIN && s.text.length > 0))
log('/status answered ✓')

// /doctor includes the companion block (real wiring in index.ts).
privateMsg('/doctor')
await until('/doctor reply', () => sends.some(s => s.text.includes('▍陪伴状态') && s.text.includes('QQ 账号')))
const callsAfterStatus = modelRequests.length
log('/doctor companion block ✓')

// A real turn: QQ text reaches the model; the reply comes back.
privateMsg('你好呀，这是端到端测试')
await until('model reply over QQ', () => sends.some(s => s.text.includes(REPLY)))
const turn = modelRequests.slice(callsAfterStatus).find(r => JSON.stringify(r.messages ?? []).includes('这是端到端测试'))
if (turn === undefined) await fail('the model never saw the QQ text')
if (!JSON.stringify(turn.system ?? '').includes('QQ')) await fail('the system prompt lacks the QQ platform notes')
log('private turn round-trip ✓')

// Group message without @: ignored (requireMention).
const before = sends.length
groupMsg('大家好，没有 at 机器人', 123450002)
await new Promise(r => setTimeout(r, 3000))
if (sends.slice(before).some(s => s.to === GROUP)) await fail('replied to a group message without @')
log('group without @ ignored ✓')

// Group message with @: a member turn in its own session, reply to the group.
const callsBeforeGroup = modelRequests.length
groupMsg('你好呀群里的端到端', 123450002, true)
await until('group reply', () => sends.some(s => s.to === GROUP && s.text.includes(REPLY)))
const groupTurn = modelRequests.slice(callsBeforeGroup).find(r => JSON.stringify(r.messages ?? []).includes('群里的端到端'))
if (groupTurn === undefined) await fail('the model never saw the group text')
log('group @ turn round-trip ✓')

log('PASS')
if (process.env.E2E_HOLD) {
  log('holding; dsh output:\n' + dshLog.split('\n').filter(l => /http:\/\//.test(l)).join('\n'))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void cleanup().then(() => process.exit(0)) })
} else {
  await cleanup()
  process.exit(0)
}
