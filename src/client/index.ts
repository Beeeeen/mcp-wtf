import type { Transport } from './transport.js'
import type { JsonRpcResponse } from './jsonrpc.js'
import type { ToolDef } from '../types.js'

export { StdioTransport } from './stdio.js'
export { HttpTransport } from './http.js'
export type { Transport } from './transport.js'

/** Versions we will negotiate, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface HandshakeResult {
  raw: JsonRpcResponse
  protocolVersion: string | null
  serverInfo: { name?: string; version?: string } | null
  capabilities: Record<string, unknown>
  ms: number
}

/**
 * A thin, unopinionated MCP client. It performs the handshake and exposes the
 * few calls the checks need -- but never normalises or repairs a response,
 * because the checks have to see exactly what the server sent.
 */
export class McpClient {
  constructor(
    public readonly transport: Transport,
    private timeoutMs = 10_000,
  ) {}

  get target(): string {
    return this.transport.target
  }

  async start(): Promise<void> {
    await this.transport.start()
  }

  async initialize(protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0]!): Promise<HandshakeResult> {
    const t0 = Date.now()
    const raw = await this.transport.request(
      'initialize',
      {
        protocolVersion,
        capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
        clientInfo: { name: 'mcp-wtf', version: '0.1.0' },
      },
      this.timeoutMs,
    )
    const ms = Date.now() - t0
    const result = (raw.result ?? {}) as Record<string, unknown>
    return {
      raw,
      ms,
      protocolVersion: typeof result['protocolVersion'] === 'string' ? result['protocolVersion'] : null,
      serverInfo: (result['serverInfo'] as HandshakeResult['serverInfo']) ?? null,
      capabilities: (result['capabilities'] as Record<string, unknown>) ?? {},
    }
  }

  /** The spec requires this notification before any other request. */
  notifyInitialized(): void {
    this.transport.notify('notifications/initialized')
  }

  call(method: string, params?: unknown, timeoutMs?: number): Promise<JsonRpcResponse> {
    return this.transport.request(method, params, timeoutMs ?? this.timeoutMs)
  }

  callRaw(payload: Record<string, unknown>, id: number | string, method: string, timeoutMs?: number) {
    return this.transport.requestRaw(payload, id, method, timeoutMs ?? this.timeoutMs)
  }

  /** Walk `nextCursor` so a paginated server does not under-report. */
  async listAll(method: 'tools/list' | 'resources/list' | 'prompts/list', key: string): Promise<{ items: unknown[]; pages: number; error?: JsonRpcResponse }> {
    const items: unknown[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const res = await this.call(method, cursor ? { cursor } : {})
      if (res.error) return { items, pages, error: res }
      pages++
      const result = (res.result ?? {}) as Record<string, unknown>
      const batch = result[key]
      if (Array.isArray(batch)) items.push(...batch)
      const next = result['nextCursor']
      if (typeof next === 'string' && next && pages < 50) cursor = next
      else break
    }
    return { items, pages }
  }

  async listTools(): Promise<{ tools: ToolDef[]; pages: number; error?: JsonRpcResponse }> {
    const { items, pages, error } = await this.listAll('tools/list', 'tools')
    return { tools: items as ToolDef[], pages, error }
  }

  close(): Promise<void> {
    return this.transport.close()
  }
}
