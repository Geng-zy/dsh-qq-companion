import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { OneBotConnection } from '../src/connection.js'
import type { OneBotEvent } from '../src/connection.js'
import { Config, logMetaEvent } from '../src/index.js'

const CONFIG = {
  host: '127.0.0.1',
  port: 0,
  accessToken: '',
  callTimeoutMs: 3_000,
}

describe('reverse server', () => {
  it('accepts a dial-in client and correlates action calls', async () => {
    const events: OneBotEvent[] = []
    const connection = (() => {
      const conn = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
      conn.onMessage = event => events.push(event)
      return conn
    })()
    connection.start()
    await vi.waitFor(() => {
      expect(connection.address()).toBeDefined()
    })
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))

    const sentFrames: Array<Record<string, unknown>> = []
    client.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      sentFrames.push(frame)
      if (typeof frame.echo === 'string') {
        client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: frame.echo }))
      }
    })

    const result = await connection.call('send_msg', { user_id: 123, message: [{ type: 'text', data: { text: 'hi' } }] })
    expect(result).toEqual({ message_id: 42 })
    expect(sentFrames[0].action).toBe('send_msg')
    expect(connection.connected).toBe(true)

    // Inbound event dispatch.
    client.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 10002, message: 'hi' }))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0].user_id).toBe(10001)
    expect(connection.selfId).toBe('10002')
    client.close()
    await connection.stop()
  })

  it('rejects clients with a bad access token', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'secret' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await new Promise(resolve => {
      client.on('close', (code) => {
        expect(code).toBe(4401)
        resolve(undefined)
      })
      client.on('open', () => undefined)
    })
    await connection.stop()
  })

  it('refuses to start in reverse mode with an empty access token (fail-closed)', () => {
    expect(() => new OneBotConnection(CONFIG).start()).toThrow('reverse mode requires a non-empty accessToken')
  })

  it('rejects clients with a wrong but present access token (constant-time compare)', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    // Same length as the real token, so the length check passes and timingSafeEqual decides.
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tox' } })
    await new Promise(resolve => {
      client.on('close', (code) => {
        expect(code).toBe(4401)
        resolve(undefined)
      })
    })
    await connection.stop()
  })

  it('fails pending calls on disconnect', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const pending = connection.call('get_msg', { message_id: 1 })
    client.close()
    await expect(pending).rejects.toThrow(/closed|stopped/)
    await connection.stop()
  })

  it('keeps the new connection healthy when a replaced socket closes late', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const dial = (): WebSocket => new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    const first = dial()
    await vi.waitFor(() => expect(connection.connected).toBe(true))
    const second = dial()
    await vi.waitFor(() => expect(first.readyState).toBe(WebSocket.CLOSED)) // replaced with code 4000
    // The stale server-side socket's 'close' event lands asynchronously after the new attach.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connection.connected).toBe(true)
    expect((connection as unknown as { heartbeatTimer?: unknown }).heartbeatTimer).toBeDefined()
    const pending = connection.call('get_msg', { message_id: 1 })
    second.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      if (typeof frame.echo === 'string') {
        second.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: frame.echo }))
      }
    })
    await expect(pending).resolves.toEqual({ message_id: 1 }) // not failed by the stale close
    second.close()
    await connection.stop()
  })

  it('does not log raw message events', async () => {
    const events: OneBotEvent[] = []
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.onMessage = event => events.push(event)
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const logSpy = vi.spyOn(console, 'log') // attached after the 'listening' log
    client.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1, message: 'hi' }))
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(logSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
    client.close()
    await connection.stop()
  })
})

describe('config schema', () => {
  it('defaults the reverse host to loopback', () => {
    expect(Config({}).host).toBe('127.0.0.1')
  })
})

describe('heartbeat pong watchdog', () => {
  interface HeartbeatView {
    socket: unknown
    lastPongAt: number
    attachSocket(socket: unknown): void
    startHeartbeat(): void
  }
  const expose = (connection: OneBotConnection): HeartbeatView => connection as unknown as HeartbeatView

  interface FakeSocket {
    readyState: number
    on(event: string, listener: (...args: unknown[]) => void): void
    removeAllListeners(): void
    close: (...args: unknown[]) => void
    ping: () => void
    terminate: () => void
    emit(event: string, ...args: unknown[]): void
  }

  /** Minimal ws-like test double: records listeners so tests can emit socket events. */
  const makeFakeSocket = (): FakeSocket => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    return {
      readyState: WebSocket.OPEN,
      on(event, listener) {
        const existing = listeners.get(event) ?? []
        existing.push(listener)
        listeners.set(event, existing)
      },
      removeAllListeners() {
        listeners.clear()
      },
      close: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn(),
      emit(event, ...args) {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
      },
    }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('terminates after two heartbeat periods without pong, but not before', () => {
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    const privateConnection = expose(connection)
    const socket = makeFakeSocket()
    privateConnection.socket = socket
    privateConnection.startHeartbeat()
    // Pretend the last pong arrived 15s ago, so the first tick sees 1.5 stale periods.
    privateConnection.lastPongAt = Date.now() - 15_000
    const warnSpy = vi.spyOn(console, 'warn')

    vi.advanceTimersByTime(30_000)
    expect(socket.ping).toHaveBeenCalledTimes(1)
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(30_000)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(socket.ping).toHaveBeenCalledTimes(1) // the stale tick terminates instead of pinging again
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('75000ms')
    warnSpy.mockRestore()
  })

  it('ignores pong from a replaced socket and refreshes from the current one', () => {
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    const privateConnection = expose(connection)
    const stale = makeFakeSocket()
    const current = makeFakeSocket()
    privateConnection.attachSocket(stale)
    const atAttach = privateConnection.lastPongAt
    privateConnection.attachSocket(current) // last-wins: the stale dial-in gets replaced
    expect(stale.close).toHaveBeenCalledWith(4000, 'replaced')
    vi.setSystemTime(atAttach + 5_000) // move the clock so a wrong refresh would be visible

    stale.emit('pong')
    expect(privateConnection.lastPongAt).toBe(atAttach) // stale pong must not refresh the new connection

    current.emit('pong')
    expect(privateConnection.lastPongAt).toBe(atAttach + 5_000) // the current socket does refresh
  })
})

describe('meta event logging', () => {
  it('keeps heartbeat meta silent but still logs other meta events', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.onMeta = event => logMetaEvent(connection.selfId, event)
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer tok' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const logSpy = vi.spyOn(console, 'log') // attached after the 'listening' log

    client.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 10002 }))
    await vi.waitFor(() => expect(connection.selfId).toBe('10002')) // the frame reached the real dispatch
    expect(logSpy).not.toHaveBeenCalled()

    client.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'life_cycle', self_id: 10002 }))
    await vi.waitFor(() => expect(logSpy).toHaveBeenCalledTimes(1))
    expect(String(logSpy.mock.calls[0]?.[0])).toContain('life_cycle')
    logSpy.mockRestore()
    client.close()
    await connection.stop()
  })
})

describe('port conflict', () => {
  interface ReconnectInternals {
    socket?: unknown
    server?: unknown
    reverseRetryTimer?: unknown
    reverseRetryAttempts?: number
  }
  const internals = (connection: OneBotConnection): ReconnectInternals => connection as unknown as ReconnectInternals

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Dead loopback port: bind once, read the port, release it. */
  const getDeadPort = async (): Promise<number> => {
    const probe = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => probe.on('listening', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    return port
  }

  /** Advance fake timers in 100ms steps until the predicate holds; real I/O settles between ticks. */
  const advanceUntil = async (predicate: () => boolean, budgetMs: number): Promise<void> => {
    for (let advanced = 0; advanced <= budgetMs && !predicate(); advanced += 100) {
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(predicate()).toBe(true)
  }

  it('reverse server logs the port and guidance on EADDRINUSE', async () => {
    const occupier = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => occupier.on('listening', resolve))
    const occupiedPort = (occupier.address() as { port: number }).port
    const connection = new OneBotConnection({ ...CONFIG, port: occupiedPort, accessToken: 'tok' })
    const errorSpy = vi.spyOn(console, 'error')
    connection.start()
    await vi.waitFor(() => {
      const logged = errorSpy.mock.calls.map(call => call.map(String).join(' ')).join('\n')
      expect(logged).toContain(String(occupiedPort))
      expect(logged).toContain('already in use')
      expect(logged).toContain('config.port')
    })
    errorSpy.mockRestore()
    await connection.stop()
    await new Promise<void>(resolve => occupier.close(() => resolve()))
  })
})

describe('frame cap and reverse churn guard', () => {
  interface A8Internals {
    socket?: unknown
    reverseReplaces: number[]
  }
  const internals = (connection: OneBotConnection): A8Internals => connection as unknown as A8Internals

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Dial into the running reverse server with the valid token. */
  const dial = (port: number): WebSocket => new WebSocket('ws://127.0.0.1:' + port + '/ws', { headers: { Authorization: 'Bearer tok' } })

  /** Fake-timer poll: advance in small steps (real I/O settles between ticks) until the predicate holds. */
  const advanceUntil = async (predicate: () => boolean, budgetMs = 5_000): Promise<void> => {
    for (let advanced = 0; advanced <= budgetMs && !predicate(); advanced += 50) {
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(predicate()).toBe(true)
  }

  it('closes with 1009 a frame that exceeds the 64MiB cap', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const port = connection.address()!.port
    const client = dial(port)
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    let close: { code: number; reason: string } | undefined
    client.on('close', (code, reason) => {
      close = { code, reason: reason.toString() }
    })
    // One binary frame a single byte over the cap: the server must abort it
    // instead of buffering the frame (the ws default cap is 100MiB).
    client.send(Buffer.alloc(64 * 1024 * 1024 + 1, 0x61))
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.CLOSED), { timeout: 10_000 })
    expect(close?.code).toBe(1009)
    await connection.stop()
  })

  it('rejects the 6th healthy-socket replacement within the 60s window', async () => {
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await advanceUntil(() => connection.address() !== undefined)
    const port = connection.address()!.port
    let current = dial(port)
    await advanceUntil(() => connection.connected && current.readyState === WebSocket.OPEN)
    // Five replacements of the healthy dial-in land inside the window...
    for (let i = 0; i < 5; i++) {
      const previous = current
      current = dial(port)
      await advanceUntil(() => connection.connected && current.readyState === WebSocket.OPEN && previous.readyState === WebSocket.CLOSED)
    }
    // ...so the 6th dial-in is rejected without touching the healthy socket.
    const warnSpy = vi.spyOn(console, 'warn')
    const sixth = dial(port)
    let sixthClose: { code: number; reason: string } | undefined
    sixth.on('close', (code, reason) => {
      sixthClose = { code, reason: reason.toString() }
    })
    await advanceUntil(() => sixthClose !== undefined)
    expect(sixthClose?.code).toBe(4000)
    expect(sixthClose?.reason).toBe('too many connections')
    expect(current.readyState).toBe(WebSocket.OPEN) // the legitimate socket survives
    expect(connection.connected).toBe(true)
    expect(warnSpy.mock.calls.some(call => String(call[0]).includes('too many connection replacements'))).toBe(true)
    warnSpy.mockRestore()
    await connection.stop()
  })

  it('allows paced replacements and the drop-then-redial flow', async () => {
    vi.useFakeTimers()
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok' })
    connection.start()
    await advanceUntil(() => connection.address() !== undefined)
    const port = connection.address()!.port
    let current = dial(port)
    await advanceUntil(() => connection.connected && current.readyState === WebSocket.OPEN)
    for (let i = 0; i < 2; i++) {
      const previous = current
      await vi.advanceTimersByTimeAsync(10_000) // normal redial spacing, still inside the window
      current = dial(port)
      await advanceUntil(() => connection.connected && current.readyState === WebSocket.OPEN && previous.readyState === WebSocket.CLOSED)
    }
    // NapCat drop-then-redial: the dead socket never counts as a replacement.
    current.close()
    await advanceUntil(() => !connection.connected)
    const redial = dial(port)
    await advanceUntil(() => connection.connected && redial.readyState === WebSocket.OPEN)
    expect(internals(connection).reverseReplaces).toHaveLength(2) // only the healthy replacements counted
    await connection.stop()
  })
})

describe('injected log port', () => {
  it('routes transport diagnostics through the injected log sink', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const connection = new OneBotConnection({
      ...CONFIG, accessToken: 'secret',
      log: (level, message) => logs.push({ level, message }),
    })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    // The listening info line arrives through the port, not the console.
    expect(logs.some(l => l.level === 'info' && l.message.includes('listening on ws://'))).toBe(true)
    const warnSpy = vi.spyOn(console, 'warn')
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws')
    await new Promise(resolve => {
      client.on('close', code => { expect(code).toBe(4401); resolve(undefined) })
      client.on('open', () => undefined)
    })
    // The rejection warning flows through the sink and never touches console.
    expect(logs.some(l => l.level === 'warn' && l.message.includes('bad access token'))).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
    client.close()
    await connection.stop()
  })

  it('falls back to the console when no log is injected (standalone usability)', async () => {
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'secret' })
    connection.start()
    await vi.waitFor(() => expect(connection.address()).toBeDefined())
    const address = connection.address()!
    const client = new WebSocket('ws://127.0.0.1:' + address.port + '/ws', { headers: { Authorization: 'Bearer secret' } })
    await vi.waitFor(() => expect(client.readyState).toBe(WebSocket.OPEN))
    const warnSpy = vi.spyOn(console, 'warn')
    client.send('not-json')
    await vi.waitFor(() => {
      expect(warnSpy.mock.calls.some(call => String(call[0]).includes('dropping non-JSON WS frame'))).toBe(true)
    })
    warnSpy.mockRestore()
    client.close()
    await connection.stop()
  })
})

describe('EADDRINUSE takeover', () => {
  interface BindInternals {
    server?: unknown
    reverseRetryTimer?: unknown
    reverseRetryAttempts?: number
  }
  const internals = (connection: OneBotConnection): BindInternals => connection as unknown as BindInternals
  type LogSink = Array<{ level: string; message: string }>
  const sink = (logs: LogSink) => (level: 'info' | 'warn' | 'error' | 'debug', message: string): void => {
    logs.push({ level, message })
  }
  /** An EADDRINUSE-shaped error for mocking the ws server 'error' event. */
  const bindError = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })
  type Emitterish = { emit(event: string, ...args: unknown[]): void }

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Dead loopback port: bind once, read the port, release it. */
  const getDeadPort = async (): Promise<number> => {
    const probe = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => probe.on('listening', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    return port
  }

  /** Fake-timer poll: advance in 100ms steps (real I/O settles between ticks) until the predicate holds. */
  const advanceUntil = async (predicate: () => boolean, budgetMs = 5_000): Promise<void> => {
    for (let advanced = 0; advanced <= budgetMs && !predicate(); advanced += 100) {
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(predicate()).toBe(true)
  }

  it('mock EADDRINUSE: cleans the dead instance and schedules a 15s retry with one error line', async () => {
    vi.useFakeTimers()
    const logs: LogSink = []
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok', log: sink(logs) })
    const internal = internals(connection)
    connection.start()
    await advanceUntil(() => connection.address() !== undefined)
    const firstServer = internal.server as Emitterish
    const closeSpy = vi.spyOn(firstServer as unknown as { close: (cb?: () => void) => void }, 'close')
    firstServer.emit('error', bindError)
    // Dead-instance cleanup: detached from this.server and closed (no hang, no locked restart).
    expect(internal.server).toBeUndefined()
    expect(closeSpy).toHaveBeenCalled()
    // The retry loop is scheduled, not awaited.
    expect(internal.reverseRetryTimer).toBeDefined()
    // First failure logs one error line announcing the retry cadence.
    expect(logs.filter(l => l.level === 'error' && l.message.includes('already in use'))).toHaveLength(1)
    expect(logs.find(l => l.level === 'error' && l.message.includes('already in use'))?.message).toContain('retrying every 15s')
    await connection.stop()
    expect(internal.reverseRetryTimer).toBeUndefined()
  })

  it('keeps retrying a busy port for 10+ minutes while deduping the steady-state error log', async () => {
    // A real occupier held for the whole test: every re-bind genuinely fails, so the
    // log-dedup path (first line + one per 10 minutes) is exercised end to end.
    const occupier = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => occupier.on('listening', resolve))
    const occupiedPort = (occupier.address() as { port: number }).port
    vi.useFakeTimers()
    const logs: LogSink = []
    const connection = new OneBotConnection({ ...CONFIG, port: occupiedPort, accessToken: 'tok', log: sink(logs) })
    const internal = internals(connection)
    connection.start()
    await advanceUntil(() => internal.reverseRetryTimer !== undefined)
    const errorLines = () => logs.filter(l => l.level === 'error' && l.message.includes('already in use'))
    expect(errorLines()).toHaveLength(1) // attempt 1
    // Attempts 2..39 (15s apart, within 10 minutes) stay silent at error level.
    for (let attempt = 2; attempt <= 39; attempt++) {
      await vi.advanceTimersByTimeAsync(15_000)
      await advanceUntil(() => internal.reverseRetryTimer !== undefined) // failed again, next retry scheduled
      if (attempt === 20) expect(errorLines()).toHaveLength(1) // still only the first line mid-way
    }
    // Attempt 40 (~10 minutes in) logs the second line.
    await vi.advanceTimersByTimeAsync(15_000)
    await advanceUntil(() => internal.reverseRetryTimer !== undefined)
    expect(errorLines()).toHaveLength(2)
    expect(internal.reverseRetryAttempts).toBe(40)
    await connection.stop()
    await new Promise<void>(resolve => occupier.close(() => resolve()))
  })

  it('takes over the port automatically once the occupier releases it', async () => {
    // Deterministic occupier: bind first, then reuse its exact port — no random-port race.
    const occupier = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => occupier.on('listening', resolve))
    const occupiedPort = (occupier.address() as { port: number }).port
    vi.useFakeTimers()
    const logs: LogSink = []
    const connection = new OneBotConnection({ ...CONFIG, port: occupiedPort, accessToken: 'tok', log: sink(logs) })
    const internal = internals(connection)
    connection.start()
    await advanceUntil(() => internal.reverseRetryTimer !== undefined) // real EADDRINUSE settled
    expect(logs.some(l => l.level === 'error' && l.message.includes('already in use'))).toBe(true)
    // Release; the pending retry re-binds the same port without any external nudge.
    await new Promise<void>(resolve => occupier.close(() => resolve()))
    await vi.advanceTimersByTimeAsync(15_000)
    await advanceUntil(() => connection.address() !== undefined)
    expect(connection.address()!.port).toBe(occupiedPort)
    expect(logs.some(l => l.level === 'info' && l.message.includes('took over'))).toBe(true)
    expect(internal.reverseRetryAttempts).toBe(0) // the takeover resets the retry accounting
    await connection.stop()
  })

  it('stop() terminates the reverse bind-retry loop and leaves no ghost timers', async () => {
    vi.useFakeTimers()
    const logs: LogSink = []
    const connection = new OneBotConnection({ ...CONFIG, accessToken: 'tok', log: sink(logs) })
    const internal = internals(connection)
    connection.start()
    await advanceUntil(() => connection.address() !== undefined)
    ;(internal.server as Emitterish).emit('error', bindError)
    expect(internal.reverseRetryTimer).toBeDefined()
    await connection.stop()
    expect(internal.reverseRetryTimer).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    // Long idle time must not resurrect a bind.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(internal.server).toBeUndefined()
    expect(logs.filter(l => l.level === 'info' && l.message.includes('listening'))).toHaveLength(1) // only the initial bind
  })

  it('start() returns synchronously while the port is busy (startup is never blocked)', async () => {
    const occupier = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>(resolve => occupier.on('listening', resolve))
    const occupiedPort = (occupier.address() as { port: number }).port
    const connection = new OneBotConnection({ ...CONFIG, port: occupiedPort, accessToken: 'tok' })
    // start() neither throws nor waits for the bind outcome; the retry is purely async.
    expect(connection.start()).toBeUndefined()
    await vi.waitFor(() => expect(internals(connection).reverseRetryTimer).toBeDefined())
    await connection.stop()
    await new Promise<void>(resolve => occupier.close(() => resolve()))
  })

})
