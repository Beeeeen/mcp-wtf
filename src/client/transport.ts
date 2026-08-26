import type { JsonRpcResponse } from './jsonrpc.js'

/** The surface the checks are written against, so they work over stdio or HTTP. */
export interface Transport {
  readonly kind: 'stdio' | 'http'
  readonly target: string
  /** stdout lines that were not valid JSON (stdio only; empty for HTTP). */
  readonly stdoutNoise: string[]
  readonly stderr: string[]
  readonly serverNotifications: JsonRpcResponse[]

  start(): Promise<void>
  request(method: string, params?: unknown, timeoutMs?: number): Promise<JsonRpcResponse>
  requestRaw(payload: Record<string, unknown>, id: number | string, method: string, timeoutMs?: number): Promise<JsonRpcResponse>
  notify(method: string, params?: unknown): void
  writeRaw(text: string): void
  isAlive(): boolean
  exitInfo(): { code: number | null; signal: string | null } | null
  close(): Promise<void>
}
