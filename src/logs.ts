import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { classifyStderr } from './diagnose.js'
import { quoteLine } from './redact.js'
import type { Diagnosis, Finding, ServerSpec } from './types.js'

/**
 * Log-file mode.
 *
 * Relaunching a server answers "why won't it connect" for the server that is
 * broken now. It cannot answer "why did it drop out at 4pm yesterday", and it
 * cannot help at all when the failure only happens inside the host -- a
 * different PATH, a different working directory, a token the GUI has and the
 * terminal does not. The host wrote all of that down and then never showed it
 * to anyone. This reads those files and runs the same classifier over them.
 */

/** How much of each file is recent enough to be worth reading. */
export const TAIL_LINES = 200

/** Where the hosts keep MCP logs, per OS. */
export function knownLogDirs(platform = process.platform, home = homedir()): Array<{ dir: string; host: string }> {
  if (platform === 'win32') {
    const appdata = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return [{ dir: join(appdata, 'Claude', 'logs'), host: 'Claude Desktop log' }]
  }
  if (platform === 'darwin') {
    return [{ dir: join(home, 'Library', 'Logs', 'Claude'), host: 'Claude Desktop log' }]
  }
  return [{ dir: join(home, '.config', 'Claude', 'logs'), host: 'Claude Desktop log' }]
}

/**
 * `mcp-server-github.log` -> `github`; the shared `mcp.log` has no one server.
 * Rotated files (`mcp-server-github1.log`, `mcp.log.2`) belong to the same
 * server as the file they were rotated out of.
 */
export function serverNameFromLogPath(path: string): string {
  const file = basename(path)
  const named = file.match(/^mcp-server-(.+?)\d*\.log(?:\.\d+)?$/i)
  if (named?.[1]) return named[1]
  return /^mcp\d*\.log/i.test(file) ? '(host log)' : file.replace(/\.log(\.\d+)?$/i, '')
}

/** Every MCP log in a directory, newest first. Missing directories are silent. */
export function findLogFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((f) => /^mcp(-server-.+?)?\d*\.log(\.\d+)?$/i.test(f))
    .map((f) => join(dir, f))
    .filter((p) => {
      try {
        return statSync(p).isFile()
      } catch {
        return false
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

export function discoverLogFiles(platform = process.platform, home = homedir()): Array<{ path: string; host: string }> {
  const out: Array<{ path: string; host: string }> = []
  for (const { dir, host } of knownLogDirs(platform, home)) {
    if (!existsSync(dir)) continue
    for (const path of findLogFiles(dir)) out.push({ path, host })
  }
  return out
}

export function tail(text: string, lines = TAIL_LINES): string[] {
  const all = text.split(/\r?\n/).filter((l) => l.trim())
  return all.slice(-lines)
}

/**
 * Enough of the end of a file to hold TAIL_LINES lines. These files reach tens
 * of megabytes -- a host that has been running for months writes every
 * JSON-RPC message it sees into them -- and reading all of that to look at the
 * last two hundred lines would make a tool that promises ten seconds slow.
 */
const TAIL_BYTES = 256 * 1024

export function readTail(path: string, maxBytes = TAIL_BYTES): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.allocUnsafe(size - start)
    if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    // A byte offset lands mid-line, and mid-character; that first fragment is
    // not a line and must not be classified as one.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Signatures that only ever appear in a host's log, never in a server's own
// stderr. They run first, because the host's phrasing for a failure is not the
// server's -- "Unexpected token ... is not valid JSON" in a host log is the
// host choking on polluted stdout, not the server throwing a SyntaxError.
// ---------------------------------------------------------------------------

const LOG_SIGNATURES: Array<[RegExp, (m: RegExpMatchArray) => Finding]> = [
  [
    /docker: error during connect|Cannot connect to the Docker daemon|Is the docker daemon running/i,
    () => ({
      code: 'docker.not_running',
      severity: 'fatal',
      message: 'The server is launched through Docker, and the Docker daemon was not running.',
      fix: 'Start Docker Desktop before the host, or the server dies on every launch. A host that starts with the machine will always lose this race -- consider a non-Docker build of the server.',
    }),
  ],
  [
    /spawn (\S+) ENOENT/i,
    (m) => ({
      code: 'cmd.not_found',
      severity: 'fatal',
      message: `The host could not start "${m[1]}" -- it is not on the PATH the host runs with.`,
      fix: 'Classic GUI-versus-terminal PATH split: it works in your shell and does not exist as far as the host is concerned. Put the absolute path to the binary in the config (`which npx` / `where npx`).',
    }),
  ],
  [
    /(?:Unexpected token .{0,40}is not valid JSON|Unexpected non-whitespace character after JSON|Expected property name or '\}' in JSON|Unexpected end of JSON input)/i,
    () => ({
      code: 'stdio.pollution',
      severity: 'fatal',
      message: 'The host failed to parse what the server sent on stdout -- the server is printing non-JSON onto the protocol channel.',
      fix: 'Something in the server logs to stdout. On stdio transport stdout IS the protocol, so those bytes corrupt the stream and the host disconnects. Logs belong on stderr; look for a LOG_LEVEL or QUIET env var if it is not your server.',
    }),
  ],
  [
    /Server (?:process )?exited with code (\d+)/i,
    (m) => ({
      code: 'crash.on_start',
      severity: 'fatal',
      message: `The host recorded the server exiting with code ${m[1]} instead of staying up.`,
      fix: 'Run the exact command from the config in a terminal and watch what it prints. Whatever kills it there is what killed it here.',
    }),
  ],
  [
    /MCP error -32000|transport closed unexpectedly|process exiting early/i,
    () => ({
      code: 'transport.closed_unexpectedly',
      severity: 'fatal',
      message: 'The server process went away without shutting down -- the host logged the transport closing unexpectedly.',
      fix: 'Something killed it: a crash, an out-of-memory kill, or stdout pollution that corrupted the stream. The lines just above this one in the same file are where the reason is, if the server printed one at all.',
    }),
  ],
  [
    /Server disconnected|Server transport closed|Client transport closed/i,
    () => ({
      code: 'transport.closed',
      severity: 'warn',
      message: 'The host recorded this server disconnecting.',
      fix: 'On its own this proves nothing: the same line is written every time you quit the app. It only matters when it lands seconds after startup -- check the timestamp against when you last used the host.',
    }),
  ],
  [
    /MCP error -32001|Request timed out|initialization timed out|Timed out waiting for/i,
    () => ({
      code: 'handshake.timeout',
      severity: 'fatal',
      message: 'The host gave up waiting for the server to answer.',
      fix: 'The process starts but never completes the handshake. Usual causes: it is an HTTP server being launched as a stdio one, the entrypoint is the wrong file, or a cold `npx` download outruns the host\'s startup timeout.',
    }),
  ],
]

/**
 * Hosts mirror every JSON-RPC message into the log. Those lines carry tool
 * arguments and tool results -- arbitrary text that will happily contain the
 * word "unauthorized" or someone's `Cannot find module` stack trace. Reading
 * them as evidence is how a diagnostic tool starts inventing failures.
 */
const MIRRORED_TRAFFIC = /Message from (?:client|server): *[{[]/i

/**
 * Classify one line. Log-specific signatures first, then the same stderr
 * signatures the live checks use -- a server's stderr is copied into these
 * files verbatim, so everything mcp-wtf already knows how to read applies.
 */
export function classifyLogLine(line: string): Finding | null {
  if (MIRRORED_TRAFFIC.test(line)) return null
  for (const [pattern, build] of LOG_SIGNATURES) {
    const m = line.match(pattern)
    if (m) return build(m)
  }
  return classifyStderr([line], 'your MCP config file', '')
}

/**
 * Symptoms rather than causes. Every failure ends with the transport closing,
 * so reporting that next to the reason it closed is noise -- and reporting it
 * alone is close to useless, which is why it is only a warning.
 */
const SYMPTOM_ONLY = new Set(['transport.closed', 'transport.closed_unexpectedly'])

const LOG_LEVEL = /^(info|error|warn|warning|debug|trace)$/i

/**
 * Which server a line is about. Hosts bracket the server name into every line
 * they write -- `[github] [info] ...` in a per-server file, `[info] [github]
 * ...` in the shared one -- which is what makes the shared mcp.log usable.
 */
export function serverTagOf(line: string): string | null {
  for (const m of line.matchAll(/\[([^\]]{1,64})\]/g)) {
    const tag = m[1]!.trim()
    if (tag && !LOG_LEVEL.test(tag)) return tag
  }
  return null
}

/** Findings for one log file's recent tail, grouped by the server they name. */
export function scanLogText(text: string, lines = TAIL_LINES, max = 6): Map<string | null, Finding[]> {
  const byServer = new Map<string | null, Map<string, Finding>>()
  for (const line of tail(text, lines)) {
    const finding = classifyLogLine(line)
    if (!finding) continue
    const server = serverTagOf(line)
    let seen = byServer.get(server)
    if (!seen) byServer.set(server, (seen = new Map()))
    // The same failure is logged on every reconnect attempt; one is enough,
    // and the first occurrence is the one with the useful context around it.
    const key = `${finding.code}|${finding.message}`
    if (seen.has(key) || seen.size >= max) continue
    seen.set(key, { ...finding, detail: `> ${quoteLine(line)}` })
  }

  const out = new Map<string | null, Finding[]>()
  for (const [server, seen] of byServer) out.set(server, preferCauses([...seen.values()]))
  return out
}

/** Drop "and then it disconnected" once something explains why it disconnected. */
function preferCauses(findings: Finding[]): Finding[] {
  const causes = findings.filter((f) => !SYMPTOM_ONLY.has(f.code))
  return causes.length > 0 ? causes : findings
}

/** The flat form: every finding in a file, in the order they were logged. */
export function analyzeLogText(text: string, lines = TAIL_LINES, max = 6): Finding[] {
  return [...scanLogText(text, lines, max).values()].flat()
}

function verdictOf(findings: Finding[]): Diagnosis['verdict'] {
  if (findings.some((f) => f.severity === 'fatal')) return 'broken'
  return findings.some((f) => f.severity === 'warn') ? 'warning' : 'healthy'
}

/**
 * One diagnosis per server named in the file. Usually that is one server --
 * but the shared mcp.log carries every server interleaved, and attributing its
 * lines is the difference between a useful report and a pile of log excerpts.
 */
export function analyzeLogFile(path: string, host: string, lines = TAIL_LINES): Diagnosis[] {
  const source = `${host} (${path})`
  const fileServer = serverNameFromLogPath(path)
  const shared = fileServer === '(host log)'

  let text: string
  try {
    text = readTail(path)
  } catch (e) {
    const finding: Finding = { code: 'log.unreadable', severity: 'warn', message: `Could not read ${path}: ${(e as Error).message}` }
    return [{ spec: { name: fileServer, kind: 'log', sources: [source] }, verdict: 'warning', findings: [finding] }]
  }

  const grouped = new Map<string, Finding[]>()
  for (const [tag, findings] of scanLogText(text, lines)) {
    // Only the shared log gets to rename its findings; a per-server file is
    // authoritative about whose it is, whatever the lines inside claim.
    const name = shared ? (tag ?? fileServer) : fileServer
    grouped.set(name, [...(grouped.get(name) ?? []), ...findings])
  }
  if (grouped.size === 0) grouped.set(fileServer, [])

  return [...grouped].map(([name, findings]) => ({
    spec: { name, kind: 'log' as const, sources: [source] },
    verdict: verdictOf(findings),
    findings,
  }))
}

/**
 * Diagnose a set of log files: explicit paths, or every one we can find. One
 * server can own several files (rotation) and appear in the shared log too, so
 * the results are merged back into one entry per server.
 */
export function diagnoseLogs(explicit: string[] = [], lines = TAIL_LINES): { diagnoses: Diagnosis[]; scanned: string[] } {
  const files = explicit.length > 0 ? explicit.map((path) => ({ path, host: 'log file' })) : discoverLogFiles()
  const byName = new Map<string, Diagnosis>()

  for (const { path, host } of files) {
    for (const found of analyzeLogFile(path, host, lines)) {
      const existing = byName.get(found.spec.name)
      if (!existing) {
        byName.set(found.spec.name, found)
        continue
      }
      existing.spec.sources.push(...found.spec.sources)
      for (const finding of found.findings) {
        const duplicate = existing.findings.some((f) => f.code === finding.code && f.message === finding.message)
        if (!duplicate) existing.findings.push(finding)
      }
    }
  }

  // One file's symptom can be another file's explained failure, so the causes
  // only win once everything about a server is in one place.
  for (const diagnosis of byName.values()) {
    diagnosis.findings = preferCauses(diagnosis.findings)
    diagnosis.verdict = verdictOf(diagnosis.findings)
  }
  return { diagnoses: [...byName.values()], scanned: files.map((f) => f.path) }
}
