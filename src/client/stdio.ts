import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Transport } from './transport.js'
import { TimeoutError, TransportClosedError, type JsonRpcResponse } from './jsonrpc.js'

export interface StdioOptions {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

/**
 * Newline-delimited JSON-RPC over a child process's stdio.
 *
 * Deliberately hand-rolled rather than built on the official SDK: the SDK
 * discards anything it cannot parse, and the unparseable bytes are exactly
 * what we are here to find. A single stray `console.log` in a server puts a
 * non-JSON line on stdout, which corrupts the stream for every client that
 * connects to it -- and the server author never sees an error.
 */
export class StdioTransport implements Transport {
  readonly kind = 'stdio'
  readonly target: string
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<
    number | string,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private exited: { code: number | null; signal: string | null } | null = null

  /** stdout lines that were not valid JSON. Almost always a logging bug. */
  readonly stdoutNoise: string[] = []
  readonly stderr: string[] = []
  /** Pipe faults (EPIPE and friends) seen after the child went away. */
  readonly pipeErrors: string[] = []
  /** Notifications the server pushed at us, kept for later assertions. */
  readonly serverNotifications: JsonRpcResponse[] = []

  constructor(private opts: StdioOptions) {
    this.target = [opts.command, ...opts.args].join(' ')
  }

  async start(): Promise<void> {
    // On Windows, a bare command name often resolves to a .cmd shim -- npx,
    // pnpm, yarn all do -- and CreateProcess cannot execute those directly, so
    // they need a shell. A path to a real executable must NOT go through the
    // shell, because cmd.exe splits it on spaces and
    // "C:\Program Files\nodejs\node.exe" becomes "C:\Program".
    const isWin = process.platform === 'win32'
    const hasPathSeparator = /[\\/]/.test(this.opts.command)
    const isExe = /\.(exe|com)$/i.test(this.opts.command)
    const useShell = isWin && !hasPathSeparator && !isExe

    // When the shell is in play it re-parses the whole line, so anything
    // containing whitespace has to carry its own quotes.
    const quote = (s: string) => (useShell && /[\s"^&|<>]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)

    const child = spawn(quote(this.opts.command), this.opts.args.map(quote), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.opts.env },
      cwd: this.opts.cwd,
      shell: useShell,
      windowsVerbatimArguments: useShell,
    }) as ChildProcessWithoutNullStreams
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) this.stderr.push(line)
    })

    // Writing to a pipe whose far end has gone emits EPIPE on the stream. With
    // no listener Node promotes that to an uncaught exception, which would
    // crash mcp-probe instead of reporting the dead server -- and the whole
    // contract here is that a broken server produces a report, not a crash.
    // Whether the write or the exit lands first is a race, so this shows up
    // on some platforms and not others.
    const swallow = (e: Error) => {
      this.pipeErrors.push(e.message)
    }
    child.stdin.on('error', swallow)
    child.stdout.on('error', swallow)
    child.stderr.on('error', swallow)

    child.on('exit', (code, signal) => {
      this.exited = { code, signal }
      const err = new TransportClosedError(
        `Server exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}) with ${this.pending.size} request(s) in flight`,
        code,
        this.stderr.slice(-20).join('\n'),
      )
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => reject(new TransportClosedError(`Failed to spawn \`${this.target}\`: ${e.message}`))
      child.once('error', onError)
      // Give spawn a tick to fail loudly; a server that dies later is caught
      // by the in-flight rejection above.
      setTimeout(() => {
        child.off('error', onError)
        resolve()
      }, 50)
    })
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      if (!line.trim()) continue
      this.consumeLine(line)
    }
  }

  private consumeLine(line: string): void {
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(line)
    } catch {
      // Not JSON. Record it and keep going -- we want the full list, not just
      // the first one, so the report can show the author every offending line.
      if (this.stdoutNoise.length < 50) this.stdoutNoise.push(line)
      return
    }
    if (msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null) {
      const waiter = this.pending.get(msg.id)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.pending.delete(msg.id)
        waiter.resolve(msg)
        return
      }
    }
    // No id, or an id nobody is waiting on: a notification or a stray reply.
    this.serverNotifications.push(msg)
  }

  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<JsonRpcResponse> {
    const id = this.nextId++
    return this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, id, method, timeoutMs)
  }

  /** Send a request with a caller-chosen id/shape, for malformed-input probes. */
  requestRaw(payload: Record<string, unknown>, id: number | string, method: string, timeoutMs = 10_000) {
    return this.send(payload, id, method, timeoutMs)
  }

  private send(payload: unknown, id: number | string, method: string, timeoutMs: number): Promise<JsonRpcResponse> {
    if (!this.child || this.exited) {
      return Promise.reject(
        new TransportClosedError(
          `Server is not running (exit code ${this.exited?.code ?? 'unknown'})`,
          this.exited?.code ?? null,
          this.stderr.slice(-20).join('\n'),
        ),
      )
    }
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new TimeoutError(method, timeoutMs))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const failWrite = (message: string) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new TransportClosedError(`Write to stdin failed: ${message}`))
      }
      // write() reports asynchronously through the callback, but it can also
      // throw synchronously once the stream is destroyed.
      try {
        this.child!.stdin.write(JSON.stringify(payload) + '\n', (err) => {
          if (err) failWrite(err.message)
        })
      } catch (e) {
        failWrite((e as Error).message)
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.writeRaw(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n')
  }

  /**
   * Write bytes verbatim. Used to test how the server handles garbage, and the
   * single choke point for every unsolicited write, so a dead pipe is handled
   * in exactly one place.
   */
  writeRaw(text: string): void {
    if (!this.child || this.exited || !this.child.stdin.writable) return
    try {
      this.child.stdin.write(text)
    } catch (e) {
      // The child can exit between the liveness check and the write landing.
      this.pipeErrors.push((e as Error).message)
    }
  }

  isAlive(): boolean {
    return this.child !== null && this.exited === null
  }

  exitInfo(): { code: number | null; signal: string | null } | null {
    return this.exited
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) clearTimeout(p.timer)
    this.pending.clear()
    const child = this.child
    if (!child || this.exited) return
    try {
      child.stdin.end()
    } catch {
      /* Pipe already torn down; there is nothing left to close. */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
}
