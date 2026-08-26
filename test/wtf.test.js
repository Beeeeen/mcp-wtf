import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { discover } from '../dist/discover.js'
import { diagnoseServer, staticChecks, resolveCommand } from '../dist/diagnose.js'
import { renderTerminal } from '../dist/report/terminal.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => join(here, '..', 'fixtures', name)
const OPTS = { timeoutMs: 6000, concurrency: 4 }

const spec = (file, name = 'fx', extra = {}) => ({
  name,
  kind: 'stdio',
  command: process.execPath,
  args: [fixture(file)],
  sources: [`TestHost (${join(tmpdir(), 'config.json')})`],
  ...extra,
})

const codes = (d) => d.findings.map((f) => f.code)

// ------------------------------------------------------------ static checks

test('resolveCommand finds node itself and rejects nonsense', () => {
  assert.ok(resolveCommand(process.execPath), 'the running node binary must resolve')
  assert.equal(resolveCommand('definitely-not-a-real-binary-xyz'), null)
})

test('a command with its arguments pasted into the string is called out with the exact fix', () => {
  const findings = staticChecks({
    name: 'pasted',
    kind: 'stdio',
    command: 'npx -y some-server',
    args: [],
    sources: ['Claude Desktop (/tmp/claude_desktop_config.json)'],
  })
  assert.equal(findings[0].code, 'config.command_has_args')
  assert.match(findings[0].fix, /"command": "npx"/)
  assert.match(findings[0].fix, /"args": \["-y","some-server"\]/)
})

test('placeholder API keys are fatal, with the config file named', () => {
  const findings = staticChecks({
    name: 'gh',
    kind: 'stdio',
    command: process.execPath,
    args: [],
    env: { GITHUB_TOKEN: 'YOUR_TOKEN_HERE', OK_VALUE: 'ghp_realvalue123' },
    sources: ['Claude Desktop (/home/u/claude_desktop_config.json)'],
  })
  const placeholder = findings.filter((f) => f.code === 'env.placeholder')
  assert.equal(placeholder.length, 1, 'only the placeholder value should be flagged')
  assert.match(placeholder[0].message, /GITHUB_TOKEN/)
  assert.match(placeholder[0].fix, /claude_desktop_config\.json/)
})

test('common placeholder shapes are all recognised', () => {
  for (const bad of ['<your-key>', 'xxx', 'TODO', 'changeme', 'YOUR API KEY', '${input:key}', '']) {
    const findings = staticChecks({
      name: 't', kind: 'stdio', command: process.execPath, args: [],
      env: { API_TOKEN: bad }, sources: ['H (/tmp/c.json)'],
    })
    assert.ok(
      findings.some((f) => f.code === 'env.placeholder' || f.code === 'env.empty_secret'),
      `"${bad}" should be flagged as a placeholder`,
    )
  }
})

// -------------------------------------------------------------- live checks

test('a healthy server is healthy', async () => {
  const d = await diagnoseServer(spec('healthy-server.js'), OPTS)
  assert.equal(d.verdict, 'healthy', JSON.stringify(d.findings))
  assert.equal(d.toolCount, 2)
  assert.equal(d.serverInfo.name, 'good-fixture')
})

test('a crash from missing dependencies is named, with the module', async () => {
  const d = await diagnoseServer(spec('crashing-server.js'), OPTS)
  assert.equal(d.verdict, 'broken')
  assert.ok(codes(d).includes('deps.module_missing'), codes(d).join(','))
  const f = d.findings.find((x) => x.code === 'deps.module_missing')
  assert.match(f.message, /left-pad/)
})

test('rejected credentials are recognised from stderr', async () => {
  const d = await diagnoseServer(spec('auth-failing-server.js'), OPTS)
  assert.equal(d.verdict, 'broken')
  assert.ok(codes(d).includes('auth.rejected'), codes(d).join(','))
})

test('stdout pollution on a working server is a warning that quotes the noise', async () => {
  const d = await diagnoseServer(spec('polluting-server.js'), OPTS)
  assert.equal(d.verdict, 'warning')
  const f = d.findings.find((x) => x.code === 'stdio.pollution')
  assert.ok(f, codes(d).join(','))
  assert.match(f.detail, /server booting/)
  assert.match(f.fix, /stderr/)
})

test('a process that runs but never speaks MCP times out with useful guidance', async () => {
  const d = await diagnoseServer(spec('hanging-server.js'), { ...OPTS, timeoutMs: 1500 })
  assert.equal(d.verdict, 'broken')
  const f = d.findings.find((x) => x.code === 'handshake.timeout')
  assert.ok(f, codes(d).join(','))
  assert.match(f.fix, /not speaking MCP/)
})

test('a missing command is diagnosed without waiting for a spawn error', async () => {
  const d = await diagnoseServer(
    { name: 'ghost', kind: 'stdio', command: 'no-such-binary-abc', args: [], sources: ['H (/tmp/c.json)'] },
    OPTS,
  )
  assert.equal(d.verdict, 'broken')
  assert.ok(codes(d).includes('cmd.not_found'), codes(d).join(','))
})

test('diagnosis is deterministic across repeated runs', async () => {
  for (let i = 0; i < 3; i++) {
    const d = await diagnoseServer(spec('crashing-server.js'), OPTS)
    assert.deepEqual(codes(d), ['deps.module_missing'], `run ${i}: ${codes(d).join(',')}`)
  }
})

// ------------------------------------------------------------------ privacy

test('env secret values never appear in the report', async () => {
  const secret = 'ghp_SUPERSECRETVALUE12345'
  const d = await diagnoseServer(spec('healthy-server.js', 'fx', { env: { GITHUB_TOKEN: secret } }), OPTS)
  const rendered = renderTerminal({
    diagnoses: [d], configsSearched: [], configErrors: [],
    healthy: 1, broken: 0, warnings: 0, durationMs: 10,
  })
  assert.ok(!rendered.includes(secret), 'a real secret value leaked into the terminal report')
  assert.ok(!JSON.stringify(d.findings).includes(secret), 'a real secret value leaked into the findings')
})

// -------------------------------------------------------------------- CLI

test('an unparseable config file is itself the diagnosis', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-'))
  const cfg = join(dir, 'claude_desktop_config.json')
  writeFileSync(cfg, '{ "mcpServers": { "a": { "command": "node" }, }') // trailing comma + unclosed
  const { configErrors } = discover(cfg)
  assert.equal(configErrors.length, 1)
  assert.equal(configErrors[0].path, cfg)
})

test('CLI --json reports verdicts and exits 1 when something is broken', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-'))
  const cfg = join(dir, 'c.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        ok: { command: process.execPath, args: [fixture('healthy-server.js')] },
        dead: { command: process.execPath, args: [fixture('crashing-server.js')] },
      },
    }),
  )
  try {
    execFileSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), '--config', cfg, '--json'], { encoding: 'utf8' })
    assert.fail('a broken server must produce a non-zero exit')
  } catch (e) {
    assert.equal(e.status, 1)
    const report = JSON.parse(e.stdout)
    assert.equal(report.healthy, 1)
    assert.equal(report.broken, 1)
  }
})

test('the same command with a different env is a different server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dedupe-'))
  const cfg = join(dir, 'c.json')
  writeFileSync(
    cfg,
    JSON.stringify({
      mcpServers: {
        'with-token': { command: 'node', args: ['s.js'], env: { TOKEN: 'real-value' } },
        'no-token': { command: 'node', args: ['s.js'] },
      },
    }),
  )
  const { specs } = discover(cfg)
  // Same command and args, different env: merging these would silently drop
  // one server from the report -- the bug the dogfood CI job caught.
  assert.equal(specs.length, 2, specs.map((s) => s.name).join(','))
})

test('CLI exits 0 when everything is healthy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wtf-'))
  const cfg = join(dir, 'c.json')
  writeFileSync(cfg, JSON.stringify({ mcpServers: { ok: { command: process.execPath, args: [fixture('healthy-server.js')] } } }))
  const stdout = execFileSync(process.execPath, [join(here, '..', 'dist', 'cli.js'), '--config', cfg], { encoding: 'utf8' })
  assert.match(stdout, /all 1 MCP server/)
})
