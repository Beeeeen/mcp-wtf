import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import {
  analyzeLogFile,
  analyzeLogText,
  classifyLogLine,
  diagnoseLogs,
  findLogFiles,
  knownLogDirs,
  readTail,
  scanLogText,
  serverNameFromLogPath,
  serverTagOf,
  tail,
} from '../dist/logs.js'

const here = dirname(fileURLToPath(import.meta.url))
const stamp = (server, level, text) => `2025-08-20T10:12:03.412Z [${server}] [${level}] ${text}`

// ------------------------------------------------------------- line signatures

test('every log signature turns a host log line into a named diagnosis', () => {
  const cases = [
    ['spawn npx ENOENT', 'cmd.not_found'],
    ['docker: error during connect: open //./pipe/dockerDesktopLinuxEngine: not found', 'docker.not_running'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock.', 'docker.not_running'],
    [`Unexpected token 'I', "[INFO] boot"... is not valid JSON`, 'stdio.pollution'],
    ['Unexpected non-whitespace character after JSON at position 4', 'stdio.pollution'],
    ['MCP error -32000: Connection closed', 'transport.closed_unexpectedly'],
    ['Server transport closed unexpectedly, this is likely due to the process exiting early', 'transport.closed_unexpectedly'],
    ['Server disconnected. For troubleshooting guidance, please visit our debugging documentation', 'transport.closed'],
    ['Server exited with code 1', 'crash.on_start'],
    ['MCP error -32001: Request timed out', 'handshake.timeout'],
    // ...and the stderr signatures the live checks already use, because the
    // host copies the server's own stderr straight into these files.
    [`Error: Cannot find module 'left-pad'`, 'deps.module_missing'],
    [`ModuleNotFoundError: No module named 'mcp'`, 'deps.module_missing'],
    ['npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fnope', 'deps.package_not_found'],
    ['Error: listen EADDRINUSE: address already in use :::3000', 'net.port_in_use'],
    ['AuthenticationError: invalid api key', 'auth.rejected'],
  ]
  for (const [line, expected] of cases) {
    const finding = classifyLogLine(stamp('srv', 'error', line))
    assert.ok(finding, `no signature matched: ${line}`)
    assert.equal(finding.code, expected, `${line} -> ${finding.code}`)
    assert.ok(finding.fix, `${expected} needs a fix line`)
  }
})

test('an ordinary log line is not a diagnosis', () => {
  assert.equal(classifyLogLine(stamp('github', 'info', 'Server started and connected successfully')), null)
  assert.equal(classifyLogLine(stamp('github', 'info', 'Shutting down server...')), null)
})

test('mirrored protocol traffic is never read as evidence', () => {
  // Tool arguments and tool results are arbitrary text. Scanning them is how a
  // diagnostic tool starts inventing failures out of somebody's search query.
  const traffic = [
    stamp('github', 'info', 'Message from client: {"method":"tools/call","params":{"query":"spawn npx ENOENT"}}'),
    stamp('github', 'info', `Message from server: {"result":{"content":[{"text":"Error: Cannot find module 'x'"}]}}`),
    stamp('github', 'info', 'Message from server: {"result":{"content":[{"text":"401 unauthorized"}]}}'),
  ]
  for (const line of traffic) assert.equal(classifyLogLine(line), null, line)
  assert.deepEqual(analyzeLogText(traffic.join('\n')), [])
})

test('"is not valid JSON" in a host log is stdout pollution, not a server exception', () => {
  // The same words in the server's own stderr would be a SyntaxError; here
  // they are the host choking on what the server printed.
  const f = classifyLogLine(`[error] Unexpected token '[', "[INFO] hi"... is not valid JSON`)
  assert.equal(f.code, 'stdio.pollution')
  assert.match(f.message, /stdout/)
})

// ------------------------------------------------------------------- the tail

test('only the recent tail of a file is read', () => {
  const old = Array.from({ length: 400 }, (_, i) => stamp('x', 'info', `line ${i}`))
  const lines = tail([stamp('x', 'error', 'spawn uvx ENOENT'), ...old].join('\n'), 200)
  assert.equal(lines.length, 200)
  assert.equal(analyzeLogText([stamp('x', 'error', 'spawn uvx ENOENT'), ...old].join('\n'), 200).length, 0)
  assert.equal(analyzeLogText([...old, stamp('x', 'error', 'spawn uvx ENOENT')].join('\n'), 200).length, 1)
})

test('only the end of a large file is read off disk, and never a partial line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const file = join(dir, 'mcp-server-big.log')
  const filler = Array.from({ length: 4000 }, (_, i) => stamp('big', 'info', `padding line ${i} ${'x'.repeat(60)}`))
  writeFileSync(file, [...filler, stamp('big', 'error', 'spawn npx ENOENT')].join('\n'))

  const text = readTail(file, 4096)
  assert.ok(text.length <= 4096)
  // Whatever line the byte offset landed inside is dropped, not classified.
  for (const line of text.split('\n')) {
    if (line.trim()) assert.match(line, /^2025-08-20T/, `partial line survived: ${line.slice(0, 40)}`)
  }
  assert.equal(analyzeLogFile(file, 'H')[0].findings[0].code, 'cmd.not_found')
})

test('a file smaller than the read window is read whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const file = join(dir, 'mcp-server-small.log')
  writeFileSync(file, stamp('small', 'error', 'spawn npx ENOENT'))
  assert.match(readTail(file), /^2025-08-20T/)
})

test('blank lines and \\r\\n line endings do not confuse the tail', () => {
  const text = ['', stamp('x', 'error', 'spawn npx ENOENT'), '', ''].join('\r\n')
  assert.equal(analyzeLogText(text)[0].code, 'cmd.not_found')
})

// ---------------------------------------------------------------- aggregation

test('the same failure logged on every retry is reported once', () => {
  const text = Array.from({ length: 12 }, () => stamp('github', 'error', 'spawn npx ENOENT')).join('\n')
  const findings = analyzeLogText(text)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].code, 'cmd.not_found')
  assert.match(findings[0].detail, /spawn npx ENOENT/)
})

test('different failures in one file are all kept, and each quotes its own line', () => {
  const text = [
    stamp('github', 'info', 'Initializing server...'),
    stamp('github', 'error', `Error: Cannot find module 'left-pad'`),
    stamp('github', 'error', 'Error: listen EADDRINUSE: address already in use :::3000'),
  ].join('\n')
  const findings = analyzeLogText(text)
  assert.deepEqual(
    findings.map((f) => f.code),
    ['deps.module_missing', 'net.port_in_use'],
  )
  assert.match(findings[0].detail, /left-pad/)
  assert.match(findings[1].detail, /EADDRINUSE/)
})

test('"and then it disconnected" is dropped once something explains why', () => {
  const withCause = [
    stamp('github', 'error', `Error: Cannot find module 'left-pad'`),
    stamp('github', 'error', 'MCP error -32000: Connection closed'),
    stamp('github', 'error', 'Server disconnected. For troubleshooting guidance, see the docs'),
  ].join('\n')
  assert.deepEqual(analyzeLogText(withCause).map((f) => f.code), ['deps.module_missing'])

  // With nothing else to go on, the symptom is all there is -- and it is only
  // a warning, because quitting the app writes the same line.
  const alone = stamp('github', 'info', 'Server transport closed')
  const [only] = analyzeLogText(alone)
  assert.equal(only.code, 'transport.closed')
  assert.equal(only.severity, 'warn')
})

test('a quoted line never carries a credential out of the log', () => {
  const token = 'ghp_aB3xY7zQ9mN2pL5kR8tW1vC4dF6gH0jK'
  const text = stamp('api', 'error', `401 Unauthorized (Authorization: Bearer ${token})`)
  const [finding] = analyzeLogText(text)
  assert.equal(finding.code, 'auth.rejected')
  assert.ok(!finding.detail.includes(token), 'the token survived into the quoted line')
  assert.match(finding.detail, /<redacted>/)
})

test('long hex and base64 runs in a log line are redacted too', () => {
  const text = stamp('api', 'error', 'AuthenticationError: invalid api key 0123456789abcdef0123456789abcdef')
  const [finding] = analyzeLogText(text)
  assert.equal(finding.code, 'auth.rejected')
  assert.ok(!finding.detail.includes('0123456789abcdef0123456789abcdef'))
  assert.match(finding.detail, /<redacted>/)
})

// ------------------------------------------------------------------ discovery

test('a log file name identifies the server it belongs to', () => {
  assert.equal(serverNameFromLogPath('/a/b/mcp-server-github.log'), 'github')
  assert.equal(serverNameFromLogPath('C:\\Users\\x\\mcp-server-my.server.log'), 'my.server')
  assert.equal(serverNameFromLogPath('/a/b/mcp.log'), '(host log)')
  assert.equal(serverNameFromLogPath('/a/b/mcp.log.1'), '(host log)')
  // Rotated files belong to the server they were rotated out of.
  assert.equal(serverNameFromLogPath('/a/b/mcp-server-github1.log'), 'github')
  assert.equal(serverNameFromLogPath('/a/b/mcp1.log'), '(host log)')
})

test('the server tag is read out of a line whichever side of the level it sits', () => {
  assert.equal(serverTagOf('2025-08-20T10:00:00Z [github] [info] hello'), 'github')
  assert.equal(serverTagOf('2025-08-20T10:00:00Z [info] [github] hello'), 'github')
  assert.equal(serverTagOf('2025-08-20T10:00:00Z [error] no server named here'), null)
  assert.equal(serverTagOf('docker: error during connect'), null)
})

test('the shared mcp.log is split back out per server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const file = join(dir, 'mcp.log')
  writeFileSync(
    file,
    [
      '2025-08-20T10:00:00Z [info] [github] spawn npx ENOENT',
      `2025-08-20T10:00:01Z [error] [memory] Error: Cannot find module 'left-pad'`,
      '2025-08-20T10:00:02Z [error] Server exited with code 1',
    ].join('\n'),
  )
  const found = analyzeLogFile(file, 'Claude Desktop log')
  assert.deepEqual(found.map((d) => d.spec.name).sort(), ['(host log)', 'github', 'memory'])
  assert.equal(found.find((d) => d.spec.name === 'github').findings[0].code, 'cmd.not_found')
  assert.equal(found.find((d) => d.spec.name === 'memory').findings[0].code, 'deps.module_missing')
})

test('known log directories follow the OS the way the config search does', () => {
  assert.match(knownLogDirs('darwin', '/Users/x')[0].dir, /Library[\\/]Logs[\\/]Claude$/)
  assert.match(knownLogDirs('linux', '/home/x')[0].dir, /\.config[\\/]Claude[\\/]logs$/)
  assert.match(knownLogDirs('win32', 'C:\\Users\\x')[0].dir, /Claude[\\/]logs$/)
})

test('only MCP logs are picked up out of a log directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  writeFileSync(join(dir, 'mcp-server-github.log'), stamp('github', 'error', 'spawn npx ENOENT'))
  writeFileSync(join(dir, 'mcp.log'), stamp('main', 'info', 'started'))
  writeFileSync(join(dir, 'main.log'), 'not an MCP log')
  writeFileSync(join(dir, 'notes.txt'), 'nope')
  const found = findLogFiles(dir).map((p) => p.split(/[\\/]/).pop()).sort()
  assert.deepEqual(found, ['mcp-server-github.log', 'mcp.log'])
})

test('a missing log directory is silent, not an error', () => {
  assert.deepEqual(findLogFiles(join(tmpdir(), 'definitely-not-there-xyz')), [])
})

// ----------------------------------------------------------------- whole file

test('a log file becomes a diagnosis attributed to its server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const file = join(dir, 'mcp-server-github.log')
  writeFileSync(file, [stamp('github', 'info', 'Starting'), stamp('github', 'error', 'spawn npx ENOENT')].join('\n'))
  const [d] = analyzeLogFile(file, 'Claude Desktop log')
  assert.equal(d.spec.name, 'github')
  assert.equal(d.spec.kind, 'log')
  assert.equal(d.verdict, 'broken')
  assert.equal(d.findings[0].code, 'cmd.not_found')
  assert.match(d.spec.sources[0], /Claude Desktop log/)
})

test('a per-server file keeps its own name whatever the lines inside claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const file = join(dir, 'mcp-server-github.log')
  writeFileSync(file, stamp('some-other-tag', 'error', 'spawn npx ENOENT'))
  const found = analyzeLogFile(file, 'Claude Desktop log')
  assert.equal(found.length, 1)
  assert.equal(found[0].spec.name, 'github')
})

test('a clean log file is clean, not broken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const file = join(dir, 'mcp-server-fine.log')
  writeFileSync(file, stamp('fine', 'info', 'Server started and connected successfully'))
  const [d] = analyzeLogFile(file, 'Claude Desktop log')
  assert.equal(d.verdict, 'healthy')
  assert.deepEqual(d.findings, [])
})

test('diagnoseLogs reads exactly the files it was given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const a = join(dir, 'mcp-server-a.log')
  const b = join(dir, 'mcp-server-b.log')
  writeFileSync(a, stamp('a', 'error', 'spawn uvx ENOENT'))
  writeFileSync(b, stamp('b', 'info', 'all good'))
  const { diagnoses, scanned } = diagnoseLogs([a, b])
  assert.deepEqual(scanned, [a, b])
  assert.deepEqual(diagnoses.map((d) => d.spec.name), ['a', 'b'])
  assert.deepEqual(diagnoses.map((d) => d.verdict), ['broken', 'healthy'])
})

test('one server split across rotated files is one entry in the report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const current = join(dir, 'mcp-server-github.log')
  const rotated = join(dir, 'mcp-server-github1.log')
  writeFileSync(current, stamp('github', 'info', 'Server transport closed'))
  writeFileSync(rotated, stamp('github', 'error', 'docker: error during connect: daemon not running'))
  const { diagnoses } = diagnoseLogs([current, rotated])
  assert.equal(diagnoses.length, 1)
  assert.equal(diagnoses[0].spec.name, 'github')
  assert.equal(diagnoses[0].spec.sources.length, 2)
  // The cause found in the older file outranks the symptom in the newer one.
  assert.deepEqual(diagnoses[0].findings.map((f) => f.code), ['docker.not_running'])
  assert.equal(diagnoses[0].verdict, 'broken')
})

test('scanLogText groups by the server each line names', () => {
  const grouped = scanLogText(
    ['[info] [a] spawn npx ENOENT', `[error] [b] Error: Cannot find module 'x'`].join('\n'),
  )
  assert.deepEqual([...grouped.keys()], ['a', 'b'])
  assert.equal(grouped.get('a')[0].code, 'cmd.not_found')
})

// ------------------------------------------------------------------------ CLI

test('CLI --logs classifies a log file and exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  const file = join(dir, 'mcp-server-github.log')
  writeFileSync(file, [stamp('github', 'error', `Error: Cannot find module 'left-pad'`)].join('\n'))
  try {
    execFileSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), '--logs', file, '--json'], { encoding: 'utf8' })
    assert.fail('a failing log must produce a non-zero exit')
  } catch (e) {
    assert.equal(e.status, 1)
    const report = JSON.parse(e.stdout)
    assert.equal(report.mode, 'logs')
    assert.deepEqual(report.logsScanned, [file])
    assert.equal(report.diagnoses[0].spec.name, 'github')
    assert.equal(report.diagnoses[0].findings[0].code, 'deps.module_missing')
  }
})

test('CLI --logs on a file that does not exist says so instead of finding nothing', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'wtf-logs-')), 'nope.log')
  try {
    execFileSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), '--logs', missing], { encoding: 'utf8', stdio: 'pipe' })
    assert.fail('a missing log file must not exit 0')
  } catch (e) {
    assert.equal(e.status, 2)
    assert.match(e.stderr, /no such log file/)
  }
})

test('CLI --logs reports a clean log as clean and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-logs-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'mcp-server-quiet.log')
  writeFileSync(file, stamp('quiet', 'info', 'Server started and connected successfully'))
  const stdout = execFileSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), '--logs', file], { encoding: 'utf8' })
  assert.match(stdout, /no known failures in the last 1 log file/)
  assert.match(stdout, /1 clean/)
})
