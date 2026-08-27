import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerSpec } from './types.js'

/** VS Code's per-user directory -- the root the extensions hang their state off. */
function vscodeUserDir(platform: string, home: string): string {
  if (platform === 'win32') return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Code', 'User')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Code', 'User')
  return join(home, '.config', 'Code', 'User')
}

/**
 * Every place the well-known hosts keep their MCP configuration. Three shapes
 * exist in the wild: `mcpServers` (Claude Desktop, Claude Code, Cursor,
 * Windsurf, Gemini CLI, Cline, Roo Code), `servers` (VS Code) and
 * `context_servers` (Zed).
 */
export function knownConfigPaths(platform = process.platform, home = homedir(), cwd = process.cwd()): Array<{ path: string; host: string }> {
  const paths: Array<{ path: string; host: string }> = []
  const push = (path: string, host: string) => paths.push({ path, host })

  if (platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    push(join(appdata, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(appdata, 'Code', 'User', 'mcp.json'), 'VS Code')
    push(join(appdata, 'Zed', 'settings.json'), 'Zed')
  } else if (platform === 'darwin') {
    push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'), 'VS Code')
    push(join(home, '.config', 'zed', 'settings.json'), 'Zed')
  } else {
    push(join(home, '.config', 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(home, '.config', 'Code', 'User', 'mcp.json'), 'VS Code')
    push(join(home, '.config', 'zed', 'settings.json'), 'Zed')
  }

  // The VS Code extensions keep their servers in globalStorage, not in the
  // editor's own config -- which is why "I configured it in Cline and nothing
  // else can see it" is not a bug.
  const vscode = vscodeUserDir(platform, home)
  push(join(vscode, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), 'Cline')
  push(join(vscode, 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'), 'Roo Code')

  push(join(home, '.claude.json'), 'Claude Code')
  push(join(cwd, '.mcp.json'), 'Claude Code (project)')
  push(join(home, '.cursor', 'mcp.json'), 'Cursor')
  push(join(cwd, '.cursor', 'mcp.json'), 'Cursor (project)')
  push(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'Windsurf')
  push(join(home, '.gemini', 'settings.json'), 'Gemini CLI')
  push(join(cwd, '.gemini', 'settings.json'), 'Gemini CLI (project)')
  push(join(cwd, '.vscode', 'mcp.json'), 'VS Code (workspace)')
  return paths
}

/**
 * JSON.parse, but tolerant of what these files actually contain. VS Code's
 * mcp.json and Zed's settings.json are JSONC -- Zed ships a default settings
 * file that is nothing but comments -- and calling those "not valid JSON"
 * would be a confident, wrong diagnosis. Comments and trailing commas are
 * stripped; anything still broken is genuinely broken.
 */
export function parseJsonc(text: string): unknown {
  const out: string[] = []
  let inString = false
  let escaped = false

  // Only ever drop a comma that a closing bracket makes illegal, and only
  // outside a string -- a blind regex would corrupt values like "a, }b".
  const dropTrailingComma = () => {
    let i = out.length - 1
    while (i >= 0 && /\s/.test(out[i]!)) i--
    if (i >= 0 && out[i] === ',') out.splice(i, 1)
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out.push(ch)
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out.push(ch)
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out.push('\n')
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === '}' || ch === ']') dropTrailingComma()
    out.push(ch)
  }
  return JSON.parse(out.join(''))
}

interface RawEntry {
  command?: unknown
  args?: unknown
  env?: unknown
  cwd?: unknown
  url?: unknown
  serverUrl?: unknown
  httpUrl?: unknown
  headers?: unknown
  type?: unknown
  disabled?: unknown
  enabled?: unknown
}

/**
 * Zed nests the launch under `command`: {"path": "npx", "args": [], "env": {}}.
 * Everyone else puts a bare string there. Both mean the same thing.
 */
function flatten(raw: RawEntry): { command: string | null; args: unknown; env: unknown } {
  if (raw.command && typeof raw.command === 'object' && !Array.isArray(raw.command)) {
    const nested = raw.command as { path?: unknown; args?: unknown; env?: unknown }
    return {
      command: typeof nested.path === 'string' ? nested.path : null,
      args: nested.args ?? raw.args,
      env: nested.env ?? raw.env,
    }
  }
  return { command: typeof raw.command === 'string' ? raw.command : null, args: raw.args, env: raw.env }
}

function toSpec(name: string, raw: RawEntry, source: string): ServerSpec | null {
  if (raw.disabled === true || raw.enabled === false) return null

  const sources = [source]
  const url =
    typeof raw.url === 'string'
      ? raw.url
      : typeof raw.serverUrl === 'string'
        ? raw.serverUrl
        : typeof raw.httpUrl === 'string' // Gemini CLI's name for streamable HTTP
          ? raw.httpUrl
          : null
  if (url) {
    return { name, kind: 'http', url, headers: (raw.headers as Record<string, string>) ?? {}, sources }
  }

  const flat = flatten(raw)
  if (!flat.command) return null

  const args = Array.isArray(flat.args) ? flat.args.filter((a): a is string => typeof a === 'string') : []
  // Hand-edited configs contain numbers and booleans where the launcher only
  // ever passes strings; keeping them would make later checks throw on a file
  // that is merely odd.
  const env: Record<string, string> = {}
  if (flat.env && typeof flat.env === 'object' && !Array.isArray(flat.env)) {
    for (const [key, value] of Object.entries(flat.env as Record<string, unknown>)) {
      if (typeof value === 'string') env[key] = value
    }
  }

  const spec: ServerSpec = {
    name,
    kind: 'stdio',
    command: flat.command,
    args,
    env,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    sources,
  }

  // VS Code configs can reference interactive inputs (${input:apiKey}); those
  // servers cannot be launched non-interactively, but they should still show
  // up in the report rather than silently vanish.
  const joined = [flat.command, ...args, JSON.stringify(spec.env)].join(' ')
  if (joined.includes('${input:')) {
    spec.unlaunchable = 'uses ${input:...} placeholders that need interactive values'
  }
  return spec
}

/** Pull every server out of one config file. Returns [] when unreadable. */
export function readConfigFile(path: string, host: string): ServerSpec[] {
  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonc(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return []
  }
  const out: ServerSpec[] = []
  const source = `${host} (${path})`

  const collect = (block: unknown) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return
    for (const [name, entry] of Object.entries(block as Record<string, RawEntry>)) {
      const spec = toSpec(name, entry ?? {}, source)
      if (spec) out.push(spec)
    }
  }

  collect(parsed['mcpServers'])
  collect(parsed['servers'])
  collect(parsed['context_servers']) // Zed

  // Claude Code also nests per-project servers under `projects`.
  const projects = parsed['projects']
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const proj of Object.values(projects as Record<string, Record<string, unknown>>)) {
      collect(proj?.['mcpServers'])
    }
  }
  return out
}

/**
 * Search every known location, merge duplicates (the same server configured
 * in several hosts is one server with several sources), and report which
 * config files were actually found -- and which exist but cannot be parsed,
 * because a malformed config is the diagnosis, not a thing to skip.
 */
export function discover(explicitConfig?: string): {
  specs: ServerSpec[]
  configsSearched: string[]
  configErrors: Array<{ path: string; error: string }>
} {
  const candidates = explicitConfig
    ? [{ path: explicitConfig, host: 'config' }]
    : knownConfigPaths()

  const configsSearched: string[] = []
  const configErrors: Array<{ path: string; error: string }> = []
  const byIdentity = new Map<string, ServerSpec>()

  for (const { path, host } of candidates) {
    if (!existsSync(path)) continue
    configsSearched.push(path)
    try {
      parseJsonc(readFileSync(path, 'utf8'))
    } catch (e) {
      configErrors.push({ path, error: (e as Error).message })
      continue
    }
    for (const spec of readConfigFile(path, host)) {
      // Identity is what would actually run, not the display name -- two hosts
      // pointing at the same command are one server. The environment is part
      // of what runs: the same command with a different env (one with a real
      // token, one with a placeholder) is a different server, and merging
      // them would silently drop one from the report.
      const envKey = JSON.stringify(Object.entries(spec.env ?? {}).sort())
      const headerKey = JSON.stringify(Object.entries(spec.headers ?? {}).sort())
      const identity =
        spec.kind === 'http'
          ? `http|${spec.url}|${headerKey}`
          : `stdio|${spec.command}|${(spec.args ?? []).join(' ')}|${envKey}|${spec.cwd ?? ''}`
      const existing = byIdentity.get(identity)
      if (existing) existing.sources.push(...spec.sources)
      else byIdentity.set(identity, spec)
    }
  }
  return { specs: [...byIdentity.values()], configsSearched, configErrors }
}
