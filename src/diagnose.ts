import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { McpClient, StdioTransport, HttpTransport, type Transport } from './client/index.js'
import type { Diagnosis, Finding, ServerSpec, WtfOptions } from './types.js'

// ---------------------------------------------------------------------------
// Static checks: everything knowable without starting the server. Most broken
// setups are broken right here, and these diagnoses are exact.
// ---------------------------------------------------------------------------

/** Values people paste from READMEs and forget to replace. */
const PLACEHOLDER = /^(|\s*|your[-_ ].*|<[^>]*>|xxx+|\.\.\.|todo|changeme|change[-_ ]me|replace[-_ ]?this|sk-your.*|\$\{input:.*\}|\$[A-Z_]+|%[A-Z_]+%)$/i

/** Env keys that clearly hold credentials, where an empty value cannot work. */
const SECRET_KEY = /(token|key|secret|password|credential|auth)/i

/**
 * Resolve a command the way the OS launcher will, so "it works in my
 * terminal" stops being a mystery. On Windows this must honour PATHEXT --
 * `npx` is really `npx.cmd`, and GUI-launched hosts often have a different
 * PATH than the user's shell.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts =
    process.platform === 'win32'
      ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
      : ['']

  const isFile = (p: string) => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  }

  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (isFile(command)) return command
    for (const ext of exts) if (ext && isFile(command + ext)) return command + ext
    return null
  }

  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const base = join(dir, command)
    if (process.platform !== 'win32' && isFile(base)) return base
    for (const ext of exts) if (isFile(base + ext)) return base + ext
  }
  return null
}

function configFileOf(spec: ServerSpec): string {
  const m = spec.sources[0]?.match(/\((.+)\)$/)
  return m?.[1] ?? 'your MCP config file'
}

export function staticChecks(spec: ServerSpec): Finding[] {
  const findings: Finding[] = []
  const cfg = configFileOf(spec)

  if (spec.unlaunchable) {
    findings.push({
      code: 'config.interactive_input',
      severity: 'warn',
      message: `This entry ${spec.unlaunchable}.`,
      fix: 'VS Code fills these in interactively. Other hosts (and mcp-wtf) cannot; replace the placeholder with the real value to test it here.',
    })
    return findings
  }

  if (spec.kind === 'http') return findings

  const command = spec.command!

  // "command": "npx -y some-server" -- the whole line pasted into `command`.
  // The OS then looks for a binary whose *name* contains spaces.
  if (/\s/.test(command) && !existsSync(command)) {
    findings.push({
      code: 'config.command_has_args',
      severity: 'fatal',
      message: `The command is "${command}" -- arguments are baked into the command string.`,
      fix: `Split it: "command" should be just the binary, the rest goes into "args". In ${cfg}: {"command": "${command.split(/\s+/)[0]}", "args": ${JSON.stringify(command.split(/\s+/).slice(1).concat(spec.args ?? []))}}`,
    })
    return findings
  }

  const resolved = resolveCommand(command)
  if (!resolved) {
    const hint =
      command === 'npx' || command === 'node'
        ? 'Node.js is not on the PATH this process sees. GUI apps on macOS and Windows often get a much shorter PATH than your terminal -- use the absolute path to the binary (run `which npx` / `where npx` in your terminal and paste the result), or launch the host from a terminal.'
        : command === 'uvx' || command === 'uv'
          ? 'uv is not on the PATH this process sees. Use the absolute path to uvx (run `which uvx` / `where uvx`), or install uv system-wide.'
          : command === 'docker'
            ? 'Docker is not on the PATH this process sees, or Docker Desktop is not running.'
            : `Nothing named "${command}" exists on PATH${isAbsolute(command) ? '' : ' and it is not a path to a file'}.`
    findings.push({
      code: 'cmd.not_found',
      severity: 'fatal',
      message: `Command not found: "${command}". This produces the classic "spawn ${command} ENOENT" error.`,
      fix: hint,
      detail: `PATH has ${(process.env['PATH'] ?? '').split(delimiter).length} entries; none contains ${command}${process.platform === 'win32' ? ' (checked with PATHEXT)' : ''}.`,
    })
  }

  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (PLACEHOLDER.test(value)) {
      findings.push({
        code: 'env.placeholder',
        severity: 'fatal',
        message: `env.${key} is still the placeholder "${value || '(empty)'}".`,
        fix: `Put the real value into the "env" block of this server in ${cfg}. The server is being started with a value that cannot authenticate.`,
      })
    } else if (SECRET_KEY.test(key) && value.trim() === '') {
      findings.push({
        code: 'env.empty_secret',
        severity: 'fatal',
        message: `env.${key} is empty.`,
        fix: `Set ${key} in ${cfg}, or remove it so the server can fall back to its own lookup.`,
      })
    }
  }

  if (spec.cwd && !existsSync(spec.cwd)) {
    findings.push({
      code: 'config.cwd_missing',
      severity: 'fatal',
      message: `The configured working directory does not exist: ${spec.cwd}`,
      fix: `Fix or remove "cwd" for this server in ${cfg}.`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// Live checks: start the server and grade what actually happens. Every
// failure signature here maps to a real, frequently-reported way to die.
// ---------------------------------------------------------------------------

/** Known stderr signatures, most specific first. */
const STDERR_SIGNATURES: Array<[RegExp, (m: RegExpMatchArray, cfg: string, command: string) => Finding]> = [
  [
    /Cannot find module '([^']+)'|ERR_MODULE_NOT_FOUND.*?'([^']+)'/,
    (m, cfg) => ({
      code: 'deps.module_missing',
      severity: 'fatal',
      message: `The server crashed because a module is missing: ${m[1] ?? m[2]}.`,
      fix: `Its dependencies are not installed. If this is your own server, run npm install in its directory; if it is configured with a path into someone's repo, that checkout was never built. (Config: ${cfg})`,
    }),
  ],
  [
    /npm error 404|E404|not found in the package registry|not found.*registry/i,
    (_m, cfg, command) => {
      const registry = command === 'uvx' || command === 'uv' ? 'PyPI' : command === 'npx' ? 'npmjs.com' : 'its registry'
      return {
        code: 'deps.package_not_found',
        severity: 'fatal',
        message: 'The package manager could not find the package -- the name in the config is wrong, or it is no longer published.',
        fix: `Check the package name spelling in ${cfg} against ${registry}.`,
      }
    },
  ],
  [
    /EADDRINUSE.*?(\d+)?/,
    (m) => ({
      code: 'net.port_in_use',
      severity: 'fatal',
      message: `The server tried to bind a port that is already taken${m[1] ? ` (${m[1]})` : ''}.`,
      fix: 'Another copy is probably still running -- a previous host session that never shut it down. Kill the old process or change the port.',
    }),
  ],
  [
    /(401|unauthorized|invalid[_ ]?(api[_ ]?key|token)|authentication)/i,
    (_m, cfg) => ({
      code: 'auth.rejected',
      severity: 'fatal',
      message: 'The server started but its credentials were rejected.',
      fix: `The API key or token in the "env" block of ${cfg} is wrong, expired, or for the wrong account.`,
    }),
  ],
  [
    /ENOENT.*?'([^']+)'/,
    (m) => ({
      code: 'fs.path_missing',
      severity: 'fatal',
      message: `The server references a path that does not exist: ${m[1]}.`,
      fix: 'One of the arguments in the config points at a file or directory that is not there on this machine.',
    }),
  ],
  [
    /(SyntaxError|Unexpected token|IndentationError|Traceback \(most recent call last\))/,
    () => ({
      code: 'crash.exception',
      severity: 'fatal',
      message: 'The server crashed with an unhandled exception on startup.',
      fix: 'This is a bug in the server itself (or a version of it incompatible with your runtime). The stderr below says where.',
    }),
  ],
]

function classifyStderr(stderr: string[], cfg: string, command: string): Finding | null {
  const text = stderr.join('\n')
  for (const [pattern, build] of STDERR_SIGNATURES) {
    const m = text.match(pattern)
    if (m) return build(m, cfg, command)
  }
  return null
}

async function liveCheck(spec: ServerSpec, options: WtfOptions): Promise<{ findings: Finding[]; serverInfo?: Diagnosis['serverInfo']; toolCount?: number; connectMs?: number }> {
  const cfg = configFileOf(spec)
  const findings: Finding[] = []

  const transport: Transport =
    spec.kind === 'http'
      ? new HttpTransport({ url: spec.url!, headers: spec.headers })
      : new StdioTransport({ command: spec.command!, args: spec.args ?? [], env: spec.env, cwd: spec.cwd })
  const client = new McpClient(transport, options.timeoutMs)

  const stderrTail = () => transport.stderr.slice(-12).join('\n')

  try {
    await client.start()
  } catch (e) {
    findings.push({ code: 'spawn.failed', severity: 'fatal', message: (e as Error).message, detail: stderrTail() || undefined })
    return { findings }
  }

  let handshake
  const t0 = Date.now()
  try {
    handshake = await client.initialize()
  } catch (e) {
    const err = (e as Error).message

    // The failure races its own evidence: the child's stderr and exit events
    // land a beat after the write that noticed the dead pipe. Let them arrive
    // before deciding what happened, or the classification is a coin flip.
    await new Promise((r) => setTimeout(r, 400))

    // The server printed something that is not JSON before dying or hanging:
    // that noise usually *is* the diagnosis.
    if (transport.stdoutNoise.length > 0) {
      findings.push({
        code: 'stdio.pollution',
        severity: 'fatal',
        message: 'The server wrote non-JSON to stdout. On stdio transport, stdout IS the protocol channel -- this corrupts the stream and the host disconnects.',
        fix: 'The server (or a library it uses) is logging to stdout. Logs belong on stderr. If it is your server: replace console.log with console.error. If not: report it to the author -- and check for an env var like LOG_LEVEL or QUIET that silences it.',
        detail: transport.stdoutNoise.slice(0, 5).map((l) => `> ${l.slice(0, 160)}`).join('\n'),
      })
    }

    const classified = classifyStderr(transport.stderr, cfg, spec.command ?? '')
    if (classified) {
      findings.push({ ...classified, detail: stderrTail() || classified.detail })
    } else if (!transport.isAlive() && transport.exitInfo()) {
      const info = transport.exitInfo()!
      findings.push({
        code: 'crash.on_start',
        severity: 'fatal',
        message: `The server exited immediately (code ${info.code ?? 'null'}) without completing the MCP handshake.`,
        fix: transport.stderr.length
          ? 'Its own error output is below -- that is the actual reason.'
          : 'It printed nothing at all. Run the command from your terminal by hand and watch what happens.',
        detail: stderrTail() || undefined,
      })
    } else if (findings.length === 0) {
      findings.push({
        code: 'handshake.timeout',
        severity: 'fatal',
        message: `The server started but never answered the MCP handshake (${err}).`,
        fix: 'The process is running but not speaking MCP on stdio. Usual causes: this command starts an HTTP server (use "url" instead of "command"), the entrypoint is the wrong file, or the server waits for input it never gets.',
        detail: stderrTail() || undefined,
      })
    }
    await client.close()
    return { findings }
  }
  const connectMs = Date.now() - t0

  if (handshake.raw.error) {
    findings.push({
      code: 'handshake.rejected',
      severity: 'fatal',
      message: `The server answered the handshake with an error: ${handshake.raw.error.code} ${handshake.raw.error.message}`,
      detail: stderrTail() || undefined,
    })
    await client.close()
    return { findings }
  }
  client.notifyInitialized()

  // Connected. Still worth flagging things that will bite later.
  if (transport.stdoutNoise.length > 0) {
    findings.push({
      code: 'stdio.pollution',
      severity: 'warn',
      message: `The handshake succeeded, but the server wrote ${transport.stdoutNoise.length} non-JSON line(s) to stdout. Some hosts survive this; others disconnect at random.`,
      fix: 'Logs belong on stderr. This is the most common cause of "works sometimes, disconnects randomly".',
      detail: transport.stdoutNoise.slice(0, 3).map((l) => `> ${l.slice(0, 160)}`).join('\n'),
    })
  }

  const { tools } = await client.listTools().catch(() => ({ tools: [] }))
  if (tools.length === 0) {
    findings.push({
      code: 'tools.none',
      severity: 'warn',
      message: 'Connected fine, but the server exposes zero tools.',
      fix: 'If you expected tools here, the server may need configuration (env vars, a workspace path) to enable them.',
    })
  }

  if (connectMs > 10_000) {
    findings.push({
      code: 'perf.slow_start',
      severity: 'info',
      message: `The handshake took ${(connectMs / 1000).toFixed(1)}s. Hosts with short startup timeouts may give up on it.`,
      fix: spec.command === 'npx' ? 'npx downloads the package on a cold cache. Pin it locally (npm install -g, then reference the binary) for instant starts.' : undefined,
    })
  }

  const serverInfo = handshake.serverInfo
  await client.close()
  return { findings, serverInfo, toolCount: tools.length, connectMs }
}

// ---------------------------------------------------------------------------

export async function diagnoseServer(spec: ServerSpec, options: WtfOptions): Promise<Diagnosis> {
  const findings = staticChecks(spec)
  const fatalAlready = findings.some((f) => f.severity === 'fatal')

  // Static fatals make the live attempt pointless and its errors redundant --
  // except cmd.not_found, where actually trying confirms the diagnosis cheaply.
  if (!fatalAlready || findings.every((f) => f.code === 'cmd.not_found')) {
    if (!spec.unlaunchable) {
      const live = await liveCheck(spec, options)
      // If the static check already named the cause, drop the vaguer spawn echo.
      const filtered = fatalAlready ? live.findings.filter((f) => f.code !== 'spawn.failed') : live.findings
      findings.push(...filtered)
      if (live.serverInfo !== undefined) {
        const verdict = findings.some((f) => f.severity === 'fatal') ? 'broken' : findings.length > 0 ? 'warning' : 'healthy'
        return { spec, verdict, findings, serverInfo: live.serverInfo, toolCount: live.toolCount, connectMs: live.connectMs }
      }
    }
  }

  const verdict: Diagnosis['verdict'] = findings.some((f) => f.severity === 'fatal')
    ? 'broken'
    : findings.length > 0
      ? 'warning'
      : 'healthy'
  return { spec, verdict, findings }
}

export async function diagnoseAll(specs: ServerSpec[], options: WtfOptions): Promise<Diagnosis[]> {
  const results: Diagnosis[] = new Array(specs.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency, specs.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= specs.length) return
      results[i] = await diagnoseServer(specs[i]!, options)
    }
  })
  await Promise.all(workers)
  return results
}
