export interface ToolDef {
  name: string
  description?: string
  inputSchema?: JsonSchema
}

export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  [k: string]: unknown
}

/**
 * One MCP server as found in a host config file (or given on the CLI). `log`
 * is a server we only know from a host's log file: there is nothing to launch,
 * just failures already recorded against its name.
 */
export interface ServerSpec {
  name: string
  kind: 'stdio' | 'http' | 'log'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  sources: string[]
  unlaunchable?: string
}

export type Verdict = 'healthy' | 'broken' | 'warning'

export interface Finding {
  /** Stable dotted id, e.g. `cmd.not_found`. */
  code: string
  severity: 'fatal' | 'warn' | 'info'
  /** What is wrong, in one plain-language sentence. */
  message: string
  /** What to do about it, concretely, naming the file to edit when known. */
  fix?: string
  /** Raw evidence: the stderr tail, the offending line, the resolved path. */
  detail?: string
}

export interface Diagnosis {
  spec: ServerSpec
  verdict: Verdict
  findings: Finding[]
  /** Populated when the handshake succeeded. */
  serverInfo?: { name?: string; version?: string } | null
  toolCount?: number
  connectMs?: number
}

export interface WtfOptions {
  timeoutMs: number
  concurrency: number
}

export interface WtfReport {
  diagnoses: Diagnosis[]
  configsSearched: string[]
  /** Config files that exist but could not be parsed, with the parse error. */
  configErrors: Array<{ path: string; error: string }>
  /** Set in --logs mode: what was read instead of configs. */
  mode?: 'config' | 'logs'
  logsScanned?: string[]
  healthy: number
  broken: number
  warnings: number
  durationMs: number
}
