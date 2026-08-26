export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: JsonRpcError
}

/** Error codes the spec pins down. Servers get these wrong constantly. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export class TimeoutError extends Error {
  constructor(public method: string, public ms: number) {
    super(`No response to \`${method}\` within ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

export class TransportClosedError extends Error {
  constructor(message: string, public code?: number | null, public stderr?: string) {
    super(message)
    this.name = 'TransportClosedError'
  }
}
