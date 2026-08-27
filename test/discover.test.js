import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { discover, knownConfigPaths, parseJsonc, readConfigFile } from '../dist/discover.js'

const write = (name, body) => {
  const file = join(mkdtempSync(join(tmpdir(), 'wtf-cfg-')), name)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  return file
}

const names = (specs) => specs.map((s) => s.name).sort()

// ---------------------------------------------------------------- the paths

test('every supported host is searched on every OS', () => {
  for (const [platform, home] of [
    ['win32', 'C:\\Users\\x'],
    ['darwin', '/Users/x'],
    ['linux', '/home/x'],
  ]) {
    const paths = knownConfigPaths(platform, home, '/work').map((p) => p.path.replace(/\\/g, '/'))
    const hosts = knownConfigPaths(platform, home, '/work').map((p) => p.host)
    const all = paths.join('\n')

    for (const host of ['Claude Desktop', 'Claude Code', 'Cursor', 'Windsurf', 'VS Code', 'Cline', 'Roo Code', 'Gemini CLI', 'Zed']) {
      assert.ok(hosts.includes(host), `${platform}: ${host} is not searched`)
    }
    assert.match(all, /\.gemini\/settings\.json/, `${platform}: Gemini CLI`)
    assert.match(all, /globalStorage\/saoudrizwan\.claude-dev\/settings\/cline_mcp_settings\.json/, `${platform}: Cline`)
    assert.match(all, /globalStorage\/rooveterinaryinc\.roo-cline\/settings\/mcp_settings\.json/, `${platform}: Roo Code`)
    assert.match(all, platform === 'win32' ? /Zed\/settings\.json/ : /\.config\/zed\/settings\.json/, `${platform}: Zed`)
  }
})

test('the VS Code extensions look under the VS Code user directory, per OS', () => {
  const cline = (platform, home) =>
    knownConfigPaths(platform, home, '/work').find((p) => p.host === 'Cline').path.replace(/\\/g, '/')
  assert.match(cline('darwin', '/Users/x'), /^\/Users\/x\/Library\/Application Support\/Code\/User\/globalStorage\//)
  assert.match(cline('linux', '/home/x'), /^\/home\/x\/\.config\/Code\/User\/globalStorage\//)
  assert.match(cline('win32', 'C:/Users/x'), /Code\/User\/globalStorage\//)
})

// --------------------------------------------------------------- the shapes

test('Gemini CLI settings are read like any other mcpServers block', () => {
  const file = write('settings.json', {
    theme: 'Default',
    mcpServers: {
      memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      remote: { httpUrl: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer real-token' } },
    },
  })
  const specs = readConfigFile(file, 'Gemini CLI')
  assert.deepEqual(names(specs), ['memory', 'remote'])
  const remote = specs.find((s) => s.name === 'remote')
  assert.equal(remote.kind, 'http')
  assert.equal(remote.url, 'https://mcp.example.com/mcp')
})

test('Cline and Roo Code entries are found, and disabled ones stay out of the report', () => {
  const file = write('cline_mcp_settings.json', {
    mcpServers: {
      on: { command: 'node', args: ['a.js'] },
      off: { command: 'node', args: ['b.js'], disabled: true },
      also_off: { command: 'node', args: ['c.js'], enabled: false },
    },
  })
  assert.deepEqual(names(readConfigFile(file, 'Cline')), ['on'])
})

test('Zed context_servers with a nested command object are flattened', () => {
  const file = write('settings.json', {
    theme: 'One Dark',
    context_servers: {
      filesystem: {
        source: 'custom',
        command: { path: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { LOG: 'debug' } },
      },
      flat: { command: 'uvx', args: ['mcp-server-git'] },
      // An extension-provided server configures itself; there is nothing to launch.
      extension_only: { source: 'extension', settings: {} },
    },
  })
  const specs = readConfigFile(file, 'Zed')
  assert.deepEqual(names(specs), ['filesystem', 'flat'])
  const fs = specs.find((s) => s.name === 'filesystem')
  assert.equal(fs.kind, 'stdio')
  assert.equal(fs.command, 'npx')
  assert.deepEqual(fs.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
  assert.deepEqual(fs.env, { LOG: 'debug' })
  assert.equal(specs.find((s) => s.name === 'flat').command, 'uvx')
})

test('env values that are not strings are dropped rather than crashing a later check', () => {
  const file = write('c.json', { mcpServers: { odd: { command: 'node', args: ['a.js'], env: { PORT: 3000, OK: 'yes' } } } })
  assert.deepEqual(readConfigFile(file, 'H')[0].env, { OK: 'yes' })
})

// ----------------------------------------------------------------- the JSONC

test('comments and trailing commas are not a broken config', () => {
  // Zed ships a settings.json that is mostly comments, and VS Code's mcp.json
  // is JSONC by design. Calling either "not valid JSON" would be a confident,
  // wrong diagnosis.
  const file = write(
    'settings.json',
    `{
  // The MCP servers Zed knows about.
  "context_servers": {
    "git": {
      /* block comments too */
      "command": { "path": "uvx", "args": ["mcp-server-git"] },
    },
  },
}`,
  )
  const { specs, configErrors } = discover(file)
  assert.deepEqual(configErrors, [])
  assert.deepEqual(names(specs), ['git'])
})

test('parseJsonc leaves the contents of strings alone', () => {
  const parsed = parseJsonc('{"args": ["--url", "https://x.example//not-a-comment", "a, }b"], "n": 1}')
  assert.deepEqual(parsed.args, ['--url', 'https://x.example//not-a-comment', 'a, }b'])
  assert.equal(parsed.n, 1)
  assert.equal(parseJsonc('{"path": "C:\\\\tmp\\\\x // y"}').path, 'C:\\tmp\\x // y')
})

test('a file that is genuinely broken is still reported as broken', () => {
  const file = write('c.json', '{ "mcpServers": { "a": { "command": "node" }, }')
  const { configErrors } = discover(file)
  assert.equal(configErrors.length, 1)
  assert.match(configErrors[0].error, /JSON/)
})

// -------------------------------------------------------------- the identity

test('the same URL with different headers is two different servers', () => {
  const file = write('c.json', {
    mcpServers: {
      mine: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer aaa' } },
      theirs: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer bbb' } },
      anon: { url: 'https://mcp.example.com/mcp' },
    },
  })
  // Merging these would silently drop two of the three from the report -- and
  // "works with my token, not with yours" is the whole reason to run this.
  assert.equal(discover(file).specs.length, 3)
})
