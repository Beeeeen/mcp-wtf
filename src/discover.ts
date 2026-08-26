import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerSpec } from './types.js'

/**
 * Every place the well-known hosts keep their MCP configuration. Two shapes
 * exist in the wild: `mcpServers` (Claude Desktop, Claude Code, Cursor,
 * Windsurf) and `servers` (VS Code).
 */
export function knownConfigPaths(platform = process.platform, home = homedir(), cwd = process.cwd()): Array<{ path: string; host: string }> {
  const paths: Array<{ path: string; host: string }> = []
  const push = (path: string, host: string) => paths.push({ path, host })

  if (platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    push(join(appdata, 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(appdata, 'Code', 'User', 'mcp.json'), 'VS Code')
  } else if (platform === 'darwin') {
    push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'), 'VS Code')
  } else {
    push(join(home, '.config', 'Claude', 'claude_desktop_config.json'), 'Claude Desktop')
    push(join(home, '.config', 'Code', 'User', 'mcp.json'), 'VS Code')
  }

  push(join(home, '.claude.json'), 'Claude Code')
  push(join(cwd, '.mcp.json'), 'Claude Code (project)')
  push(join(home, '.cursor', 'mcp.json'), 'Cursor')
  push(join(cwd, '.cursor', 'mcp.json'), 'Cursor (project)')
  push(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'Windsurf')
  push(join(cwd, '.vscode', 'mcp.json'), 'VS Code (workspace)')
  return paths
}

interface RawEntry {
  command?: unknown
  args?: unknown
  env?: unknown
  cwd?: unknown
  url?: unknown
  serverUrl?: unknown
  headers?: unknown
  type?: unknown
  disabled?: unknown
}

function toSpec(name: string, raw: RawEntry, source: string): ServerSpec | null {
  if (raw.disabled === true) return null

  const sources = [source]
  const url = typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : null
  if (url) {
    return { name, kind: 'http', url, headers: (raw.headers as Record<string, string>) ?? {}, sources }
  }
  if (typeof raw.command !== 'string' || !raw.command) return null

  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : []
  const spec: ServerSpec = {
    name,
    kind: 'stdio',
    command: raw.command,
    args,
    env: (raw.env as Record<string, string>) ?? {},
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    sources,
  }

  // VS Code configs can reference interactive inputs (${input:apiKey}); those
  // servers cannot be launched non-interactively, but they should still show
  // up in the report rather than silently vanish.
  const joined = [raw.command, ...args, JSON.stringify(spec.env)].join(' ')
  if (joined.includes('${input:')) {
    spec.unlaunchable = 'uses ${input:...} placeholders that need interactive values'
  }
  return spec
}

/** Pull every server out of one config file. Returns [] when unreadable. */
export function readConfigFile(path: string, host: string): ServerSpec[] {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
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
      JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      configErrors.push({ path, error: (e as Error).message })
      continue
    }
    for (const spec of readConfigFile(path, host)) {
      // Identity is what would actually run, not the display name -- two hosts
      // pointing at the same command are one server.
      const identity =
        spec.kind === 'http' ? `http|${spec.url}` : `stdio|${spec.command}|${(spec.args ?? []).join(' ')}`
      const existing = byIdentity.get(identity)
      if (existing) existing.sources.push(...spec.sources)
      else byIdentity.set(identity, spec)
    }
  }
  return { specs: [...byIdentity.values()], configsSearched, configErrors }
}
