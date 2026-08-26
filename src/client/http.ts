import type { Transport } from './transport.js'
import { TimeoutError, TransportClosedError, type JsonRpcResponse } from './jsonrpc.js'

export interface HttpOptions {
  url: string
  headers?: Record<string, string>
}

/**
 * Streamable HTTP transport. Each request is a POST; the server may answer
 * with `application/json` or an SSE stream, and may hand us a session id on
 * the initialize response that must be echoed on every later call.
 */
export class HttpTransport implements Transport {
  readonly kind = 'http'
  readonly target: string
  readonly stdoutNoise: string[] = []
  readonly stderr: string[] = []
  readonly serverNotifications: JsonRpcResponse[] = []

  private nextId = 1
  private sessionId: string | null = null
  private closed = false
  /** Populated when a response arrives with a shape we could not read. */
  readonly protocolNotes: string[] = []

  constructor(private opts: HttpOptions) {
    this.target = opts.url
  }

  async start(): Promise<void> {
    /* Nothing to spawn; the first POST is the real connection test. */
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.opts.headers,
    }
    if (this.sessionId) h['mcp-session-id'] = this.sessionId
    return h
  }

  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<JsonRpcResponse> {
    const id = this.nextId++
    return this.post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, method, timeoutMs)
  }

  requestRaw(payload: Record<string, unknown>, _id: number | string, method: string, timeoutMs = 10_000) {
    return this.post(payload, method, timeoutMs)
  }

  private async post(payload: unknown, method: string, timeoutMs: number): Promise<JsonRpcResponse> {
    if (this.closed) throw new TransportClosedError('Transport already closed')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(this.opts.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      if (ac.signal.aborted) throw new TimeoutError(method, timeoutMs)
      throw new TransportClosedError(`POST ${this.opts.url} failed: ${(e as Error).message}`)
    }
    clearTimeout(timer)

    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid

    // 202 with no body is the legal answer to a notification.
    if (res.status === 202) return {}

    const ctype = res.headers.get('content-type') ?? ''
    const body = await res.text()

    if (!res.ok) {
      throw new TransportClosedError(`HTTP ${res.status} ${res.statusText} from ${this.opts.url}: ${body.slice(0, 400)}`)
    }
    if (ctype.includes('text/event-stream')) return this.parseSse(body, method)
    if (!body.trim()) return {}
    try {
      return JSON.parse(body) as JsonRpcResponse
    } catch {
      this.protocolNotes.push(`Non-JSON body for \`${method}\` (content-type: ${ctype || 'none'}): ${body.slice(0, 200)}`)
      throw new TransportClosedError(`Server returned unparseable body for \`${method}\``)
    }
  }

  /** Pull the first `data:` frame that carries a JSON-RPC reply. */
  private parseSse(body: string, method: string): JsonRpcResponse {
    const frames = body.split(/\n\n/)
    let last: JsonRpcResponse | null = null
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('')
      if (!data) continue
      let msg: JsonRpcResponse
      try {
        msg = JSON.parse(data)
      } catch {
        this.protocolNotes.push(`Unparseable SSE frame during \`${method}\`: ${data.slice(0, 200)}`)
        continue
      }
      if (msg.id !== undefined && msg.id !== null) last = msg
      else this.serverNotifications.push(msg)
    }
    if (!last) throw new TransportClosedError(`SSE stream for \`${method}\` carried no JSON-RPC response`)
    return last
  }

  notify(method: string, params?: unknown): void {
    void this.post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }, method, 5000).catch(() => {
      /* Notifications are fire-and-forget; a failure here is not a check result. */
    })
  }

  writeRaw(text: string): void {
    void fetch(this.opts.url, { method: 'POST', headers: this.headers(), body: text }).catch(() => {})
  }

  isAlive(): boolean {
    return !this.closed
  }

  exitInfo(): null {
    return null
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
