#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { discover } from './discover.js'
import { diagnoseAll } from './diagnose.js'
import { diagnoseLogs } from './logs.js'
import { redactSpecSecrets } from './redact.js'
import { renderTerminal } from './report/terminal.js'
import { VERSION } from './version.js'
import type { Diagnosis, ServerSpec, WtfOptions, WtfReport } from './types.js'

const HELP = `
  mcp-wtf ${VERSION}
  Your MCP server won't connect. Find out why in 10 seconds.

  USAGE
    mcp-wtf                         diagnose every configured MCP server
    mcp-wtf --config <file>         diagnose the servers in one config file
    mcp-wtf --server <name>         only the named server(s); repeatable
    mcp-wtf -- <command> [...]      diagnose one stdio server directly
    mcp-wtf --url <url>             diagnose one remote (HTTP/SSE) server
    mcp-wtf --logs [file]           classify failures in the host's log files
                                    (auto-discovered when no file is given)

  OPTIONS
    --header "Name: value"  sent with --url; repeatable
    --json                  machine-readable report
    --timeout <ms>          per-server handshake timeout (default 15000)
    --concurrency <n>       servers checked at once (default 4)

  WHAT IT CHECKS
    the config itself       valid JSON, commands split from args, cwd exists
    the command             actually resolvable on PATH (with PATHEXT on
                            Windows) -- the source of "spawn npx ENOENT"
    the environment         placeholder API keys ("YOUR_KEY_HERE"), empty
                            secrets, \${input:...} entries
    the launch              crashes on start, missing modules, missing
                            packages, ports already in use, rejected keys
    the protocol            handshake completes, stdout carries only JSON
                            (stdout pollution = "disconnects randomly")
    remote endpoints        DNS, refused connections, expired certificates,
                            401/403 (including OAuth-protected resources),
                            404 paths, SSE-vs-streamable mismatches,
                            redirects, and HTML pages pretending to be MCP
    host logs               the same signatures, read out of the log files
                            Claude Desktop already wrote

  Exit codes: 0 all healthy, 1 something is broken, 2 could not run.

  Configs searched: Claude Desktop, Claude Code (~/.claude.json, ./.mcp.json),
  Cursor, Windsurf, VS Code, Cline, Roo Code, Gemini CLI, Zed. mcp-wtf never
  invokes your tools, never prints the values of env secrets, and redacts
  anything token-shaped out of the log lines it quotes.
`

interface Parsed {
  options: WtfOptions
  json: boolean
  config?: string
  serverFilter: string[]
  direct?: ServerSpec
  logs: boolean
  logFiles: string[]
  help: boolean
  version: boolean
  error?: string
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    options: { timeoutMs: 15_000, concurrency: 4 },
    json: false,
    serverFilter: [],
    logs: false,
    logFiles: [],
    help: false,
    version: false,
  }
  let url: string | null = null
  const headers: Record<string, string> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') {
      const rest = argv.slice(i + 1)
      if (rest.length === 0) return { ...out, error: '`--` must be followed by the server command' }
      out.direct = { name: rest.join(' '), kind: 'stdio', command: rest[0]!, args: rest.slice(1), sources: ['command line'] }
      break
    }
    const next = () => argv[++i]

    switch (arg) {
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      case '--json':
        out.json = true
        break
      case '--config':
        out.config = next()
        break
      case '--server':
        out.serverFilter.push(...(next() ?? '').split(',').filter(Boolean))
        break
      case '--url':
        url = next() ?? null
        break
      case '--logs': {
        // The file is optional: `--logs` alone means "find them yourself".
        out.logs = true
        const peek = argv[i + 1]
        if (peek !== undefined && !peek.startsWith('-')) out.logFiles.push(argv[++i]!)
        break
      }
      case '--header': {
        const raw = next() ?? ''
        const idx = raw.indexOf(':')
        if (idx < 1) return { ...out, error: `--header expects "Name: value", got "${raw}"` }
        headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim()
        break
      }
      case '--timeout': {
        const v = Number(next())
        if (!Number.isFinite(v) || v <= 0) return { ...out, error: '--timeout needs a positive number of milliseconds' }
        out.options.timeoutMs = v
        break
      }
      case '--concurrency': {
        const v = Number(next())
        if (!Number.isFinite(v) || v <= 0) return { ...out, error: '--concurrency needs a positive number' }
        out.options.concurrency = Math.floor(v)
        break
      }
      default:
        return { ...out, error: `Unknown option "${arg}". Try --help.` }
    }
  }
  if (url) out.direct = { name: url, kind: 'http', url, headers, sources: ['command line'] }
  return out
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))

  if (parsed.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (parsed.version) {
    process.stdout.write(VERSION + '\n')
    process.exit(0)
  }
  if (parsed.error) {
    process.stderr.write(`mcp-wtf: ${parsed.error}\n`)
    process.exit(2)
  }

  const emit = (report: WtfReport): void => {
    // Whatever leaves this process is safe to paste into a bug report.
    const safe: WtfReport = { ...report, diagnoses: report.diagnoses.map(redactSpecSecrets) }
    if (parsed.json) process.stdout.write(JSON.stringify(safe, null, 2) + '\n')
    else process.stdout.write(renderTerminal(safe))
    process.exit(safe.broken > 0 || safe.configErrors.length > 0 ? 1 : 0)
  }

  if (parsed.logs) {
    const missing = parsed.logFiles.filter((f) => !existsSync(f))
    if (missing.length > 0) {
      process.stderr.write(`mcp-wtf: no such log file: ${missing.join(', ')}\n`)
      process.exit(2)
    }
    const t0 = Date.now()
    const { diagnoses, scanned } = diagnoseLogs(parsed.logFiles)
    if (scanned.length === 0) {
      process.stderr.write(
        'mcp-wtf: no MCP log files found. Claude Desktop writes them to %APPDATA%\\Claude\\logs (Windows), ~/Library/Logs/Claude (macOS) or ~/.config/Claude/logs (Linux). Point at one with `mcp-wtf --logs <file>`.\n',
      )
      process.exit(2)
    }
    emit({
      diagnoses,
      mode: 'logs',
      logsScanned: scanned,
      configsSearched: [],
      configErrors: [],
      healthy: diagnoses.filter((d) => d.verdict === 'healthy').length,
      broken: diagnoses.filter((d) => d.verdict === 'broken').length,
      warnings: diagnoses.filter((d) => d.verdict === 'warning').length,
      durationMs: Date.now() - t0,
    })
    return
  }

  let specs: ServerSpec[]
  let configsSearched: string[] = []
  let configErrors: Array<{ path: string; error: string }> = []

  if (parsed.direct) {
    specs = [parsed.direct]
  } else {
    if (parsed.config && !existsSync(parsed.config)) {
      process.stderr.write(`mcp-wtf: no such config file: ${parsed.config}\n`)
      process.exit(2)
    }
    const found = discover(parsed.config)
    specs = found.specs
    configsSearched = found.configsSearched
    configErrors = found.configErrors

    if (parsed.serverFilter.length > 0) {
      specs = specs.filter((s) => parsed.serverFilter.includes(s.name))
      const missing = parsed.serverFilter.filter((f) => !specs.some((s) => s.name === f))
      if (missing.length > 0) {
        process.stderr.write(`mcp-wtf: no server named ${missing.map((m) => `"${m}"`).join(', ')} in the discovered configs\n`)
        process.exit(2)
      }
    }
  }

  if (specs.length === 0 && configErrors.length === 0) {
    process.stderr.write(
      configsSearched.length === 0
        ? 'mcp-wtf: no MCP config files found. Point it at one with --config <file>, or at a server with `mcp-wtf -- <command>`.\n'
        : `mcp-wtf: searched ${configsSearched.length} config file(s) but found no MCP servers in them.\n`,
    )
    process.exit(2)
  }

  const t0 = Date.now()
  const diagnoses: Diagnosis[] = await diagnoseAll(specs, parsed.options)

  emit({
    diagnoses,
    mode: 'config',
    configsSearched,
    configErrors,
    healthy: diagnoses.filter((d) => d.verdict === 'healthy').length,
    broken: diagnoses.filter((d) => d.verdict === 'broken').length,
    warnings: diagnoses.filter((d) => d.verdict === 'warning').length,
    durationMs: Date.now() - t0,
  })
}

main().catch((e: unknown) => {
  process.stderr.write(`mcp-wtf: internal error: ${(e as Error).stack ?? String(e)}\n`)
  process.exit(2)
})
