/**
 * Old-session cleanup: age limits per chat kind, in-use and non-QQ sessions
 * are never touched, the projection cache entry goes with the session, and
 * the ledger forgets deleted sessions.
 * @module dsh-qq-companion/tests/session-cleanup
 */
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SessionCleaner, pruneOldSessions } from '../src/companion/index.js'
import { SessionLedger } from '../src/session-ledger.js'

const DAY = 86_400_000
const NOW = Date.UTC(2027, 0, 1)

/** A session dir whose files were last written `daysAgo` days before NOW. */
function session(root: string, workspace: string, id: string, daysAgo: number): string {
  const dir = join(root, workspace, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, 'x')
  const t = (NOW - daysAgo * DAY) / 1000
  utimesSync(file, t, t)
  utimesSync(dir, t, t)
  return dir
}

describe('pruneOldSessions', () => {
  it('deletes private sessions after 90 days and group sessions after 30, sparing in-use and non-QQ ones', async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-cleanup-'))
    const root = join(home, 'sessions')
    const cache = join(home, 'projcache')
    mkdirSync(cache, { recursive: true })
    const oldPrivate = session(root, '--private--', 'onebot-private-1-a', 100)
    const recentPrivate = session(root, '--private--', 'onebot-private-1-b', 60)
    const oldGroup = session(root, '--groups-9--', 'onebot-group-9-a', 40)
    const recentGroup = session(root, '--groups-9--', 'onebot-group-9-b', 10)
    const inUse = session(root, '--groups-9--', 'onebot-group-9', 400)
    const web = session(root, '--Demo--', 'session-123', 400)
    writeFileSync(join(cache, 'onebot-private-1-a.json'), '{}')
    const removed: string[] = []

    const result = await pruneOldSessions({
      sessionsRoot: root,
      projectionCacheDir: cache,
      privateKeepDays: 90,
      groupKeepDays: 30,
      inUse: () => new Set(['onebot-group-9']),
      onRemoved: id => removed.push(id),
      log: () => undefined,
      now: () => NOW,
    })

    expect(result).toEqual({ private: 1, group: 1 })
    expect(existsSync(oldPrivate)).toBe(false)
    expect(existsSync(oldGroup)).toBe(false)
    expect(existsSync(join(cache, 'onebot-private-1-a.json'))).toBe(false)
    for (const kept of [recentPrivate, recentGroup, inUse, web]) expect(existsSync(kept)).toBe(true)
    expect(removed.sort()).toEqual(['onebot-group-9-a', 'onebot-private-1-a'])
  })

  it('a limit of 0 keeps everything of that kind; a missing sessions root is fine', async () => {
    const home = mkdtempSync(join(tmpdir(), 'session-cleanup-'))
    const root = join(home, 'sessions')
    const old = session(root, '--private--', 'onebot-private-1-a', 1000)
    const options = { sessionsRoot: root, projectionCacheDir: join(home, 'c'), privateKeepDays: 0, groupKeepDays: 30, inUse: () => new Set<string>(), log: () => undefined, now: () => NOW }
    expect(await pruneOldSessions(options)).toEqual({ private: 0, group: 0 })
    expect(existsSync(old)).toBe(true)
    expect(await pruneOldSessions({ ...options, sessionsRoot: join(home, 'missing') })).toEqual({ private: 0, group: 0 })
    expect(new SessionCleaner({ ...options, groupKeepDays: 0 }).enabled).toBe(false)
  })
})

describe('SessionLedger.forgetSession', () => {
  it('drops a deleted session from every switch-back list', () => {
    const ledger = new SessionLedger({ mediaDir: mkdtempSync(join(tmpdir(), 'ledger-')), log: () => undefined })
    ledger.recordSwitchable('private:1' as never, 'onebot-private-1-a')
    ledger.recordSwitchable('private:1' as never, 'onebot-private-1-b')
    ledger.forgetSession('onebot-private-1-a')
    expect(ledger.switchable('private:1' as never).map(e => e.id)).toEqual(['onebot-private-1-b'])
  })
})
