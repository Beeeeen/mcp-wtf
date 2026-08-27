import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { diagnoseServer, staticChecks } from '../dist/diagnose.js'
import { classifyHttpProbe, classifyNetworkError, oauthMetadataUrl, readRpcBody } from '../dist/remote.js'
import { redactSpecSecrets } from '../dist/redact.js'
import { renderTerminal } from '../dist/report/terminal.js'

const OPTS = { timeoutMs: 6000, concurrency: 4 }

// Everything HTTP is tested against a server started here: real sockets, real
// status lines, no network. A diagnosis that only works against a mock is not
// a diagnosis.
let base = ''
let server

const INITIALIZE_RESULT = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: {} },
  serverInfo: { name: 'remote-fixture', version: '2.1.0' },
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

before(async () => {
  server = createServer(async (req, res) => {
    const path = req.url.split('?')[0]
    const rpc = req.method === 'POST' ? await readBody(req) : {}

    switch (path) {
      case '/mcp':
        if (rpc.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'a' }] } })
        if (rpc.id === undefined) return res.writeHead(202).end()
        return json(res, 200, { jsonrpc: '2.0', id: rpc.id, result: INITIALIZE_RESULT }, { 'mcp-session-id': 'sess-1' })

      case '/mcp-stream': {
        // A streamable-HTTP server may answer the POST with an SSE stream.
        if (rpc.id === undefined) return res.writeHead(202).end()
        const payload = rpc.method === 'tools/list' ? { tools: [] } : INITIALIZE_RESULT
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: payload })}\n\n`)
      }

      case '/needs-auth':
        return json(
          res,
          401,
          { error: 'unauthorized', sent: req.headers.authorization ?? null },
          { 'www-authenticate': 'Bearer realm="mcp", error="invalid_token"' },
        )

      case '/oauth':
        return json(res, 401, { error: 'unauthorized' }, {
          'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        })

      case '/forbidden':
        return json(res, 403, { error: 'forbidden' })

      case '/nope':
        return json(res, 404, { error: 'not found' })

      case '/sse':
        // The legacy transport: GET opens a stream, POST is not allowed.
        if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'text/event-stream' }).end()
        return res.writeHead(405, { 'content-type': 'text/plain' }).end('Method Not Allowed')

      case '/picky':
        return res.writeHead(406, { 'content-type': 'text/plain' }).end('Not Acceptable')

      case '/moved':
        return res.writeHead(302, { location: `${base}/mcp` }).end()

      case '/page':
        return res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<!doctype html><html><head><title>Acme Docs</title></head><body>hi</body></html>')

      case '/boom':
        return res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad Gateway')

      case '/busy':
        return json(res, 429, { error: 'slow down' }, { 'retry-after': '30' })

      case '/plain':
        return res.writeHead(200, { 'content-type': 'text/plain' }).end('pong')

      case '/rpc-error':
        return json(res, 200, { jsonrpc: '2.0', id: rpc.id ?? 1, error: { code: -32600, message: 'Invalid Request' } })

      case '/not-mcp':
        return json(res, 200, { jsonrpc: '2.0', id: rpc.id ?? 1, result: { status: 'ok' } })

      default:
        return json(res, 404, { error: 'unknown fixture path' })
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
})

const remote = (path, extra = {}) => ({
  name: 'remote',
  kind: 'http',
  url: `${base}${path}`,
  headers: {},
  sources: [`TestHost (${join(tmpdir(), 'config.json')})`],
  ...extra,
})

const codes = (d) => d.findings.map((f) => f.code)

// -------------------------------------------------------- the happy endpoint

test('a working remote endpoint reports the server and blames the client', async () => {
  const d = await diagnoseServer(remote('/mcp'), OPTS)
  assert.equal(d.verdict, 'healthy', JSON.stringify(d.findings))
  assert.equal(d.serverInfo.name, 'remote-fixture')
  assert.equal(d.serverInfo.version, '2.1.0')
  assert.equal(d.toolCount, 1)
  const note = d.findings.find((f) => f.code === 'remote.reachable')
  assert.ok(note, codes(d).join(','))
  assert.match(note.message, /remote-fixture v2\.1\.0/)
  assert.match(note.fix, /client side/)
})

test('an SSE-framed handshake response is read like any other', async () => {
  const d = await diagnoseServer(remote('/mcp-stream'), OPTS)
  assert.equal(d.serverInfo.name, 'remote-fixture')
  assert.ok(codes(d).includes('remote.reachable'), codes(d).join(','))
  // Zero tools is still worth saying out loud on a remote server.
  assert.ok(codes(d).includes('tools.none'), codes(d).join(','))
})

// ------------------------------------------------------------------- 4xx/5xx

test('401 with a plain challenge asks for the credential it never got', async () => {
  const d = await diagnoseServer(remote('/needs-auth'), OPTS)
  assert.equal(d.verdict, 'broken')
  const f = d.findings.find((x) => x.code === 'auth.unauthorized')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /401 Unauthorized/)
  assert.match(f.fix, /Authorization/)
  assert.match(f.detail, /www-authenticate/)
})

test('401 that advertises protected-resource metadata says the client must do OAuth', async () => {
  const d = await diagnoseServer(remote('/oauth'), OPTS)
  const f = d.findings.find((x) => x.code === 'auth.oauth_required')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /oauth-protected-resource/)
  assert.match(f.fix, /OAuth flow/)
})

test('403 separates "wrong token" from "not allowed"', async () => {
  const d = await diagnoseServer(remote('/forbidden'), OPTS)
  assert.ok(codes(d).includes('auth.forbidden'), codes(d).join(','))
  assert.match(d.findings[0].message, /403 Forbidden/)
})

test('404 suggests the /mcp and /sse suffixes', async () => {
  const d = await diagnoseServer(remote('/nope'), OPTS)
  const f = d.findings.find((x) => x.code === 'http.not_found')
  assert.ok(f, codes(d).join(','))
  assert.match(f.fix, /\/mcp/)
  assert.match(f.fix, /\/sse/)
})

test('405 on an endpoint whose GET streams events is named as the SSE transport', async () => {
  const d = await diagnoseServer(remote('/sse'), OPTS)
  const f = d.findings.find((x) => x.code === 'http.wrong_endpoint')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /405 Method Not Allowed/)
  assert.match(f.fix, /text\/event-stream/)
  assert.match(f.fix, /"type": "sse"/)
})

test('406 is the same wrong-endpoint diagnosis, and says both types were offered', async () => {
  const d = await diagnoseServer(remote('/picky'), OPTS)
  const f = d.findings.find((x) => x.code === 'http.wrong_endpoint')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /406 Not Acceptable/)
  assert.match(f.message, /text\/event-stream/)
})

test('a redirect is reported with its destination, not followed', async () => {
  const d = await diagnoseServer(remote('/moved'), OPTS)
  const f = d.findings.find((x) => x.code === 'http.redirect')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /\/mcp/)
  assert.match(f.fix, /do not follow redirects/)
})

test('an HTML page is called a web page, with the "Unexpected token <" hint', async () => {
  const d = await diagnoseServer(remote('/page'), OPTS)
  const f = d.findings.find((x) => x.code === 'http.html_response')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /Acme Docs/)
  assert.match(f.fix, /Unexpected token < in JSON/)
})

test('5xx is blamed on the server, not on the config', async () => {
  const d = await diagnoseServer(remote('/boom'), OPTS)
  const f = d.findings.find((x) => x.code === 'http.server_error')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /502/)
})

test('429 repeats the Retry-After the server gave', async () => {
  const d = await diagnoseServer(remote('/busy'), OPTS)
  const f = d.findings.find((x) => x.code === 'http.rate_limited')
  assert.ok(f, codes(d).join(','))
  assert.match(f.fix, /30s/)
})

test('a 200 that is not JSON-RPC is not an MCP server', async () => {
  const d = await diagnoseServer(remote('/plain'), OPTS)
  assert.ok(codes(d).includes('http.not_json'), codes(d).join(','))
})

test('a JSON-RPC error to initialize is reported verbatim', async () => {
  const d = await diagnoseServer(remote('/rpc-error'), OPTS)
  const f = d.findings.find((x) => x.code === 'handshake.rejected')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /-32600 Invalid Request/)
})

test('JSON without a protocolVersion is JSON, not MCP', async () => {
  const d = await diagnoseServer(remote('/not-mcp'), OPTS)
  assert.ok(codes(d).includes('handshake.not_mcp'), codes(d).join(','))
})

// -------------------------------------------------------- connection failures

test('a closed port is a refused connection, diagnosed as such', async () => {
  // Bind, learn the port, release it: the only way to be certain nothing is
  // listening there.
  const scout = createServer()
  await new Promise((resolve) => scout.listen(0, '127.0.0.1', resolve))
  const port = scout.address().port
  await new Promise((resolve) => scout.close(resolve))

  const d = await diagnoseServer(
    { name: 'dead', kind: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {}, sources: ['H (/tmp/c.json)'] },
    OPTS,
  )
  assert.equal(d.verdict, 'broken')
  assert.ok(codes(d).includes('net.connection_refused'), codes(d).join(','))
})

test('every connection-level failure maps to its own plain-language finding', () => {
  const cases = [
    ['ENOTFOUND', 'net.dns_failure'],
    ['EAI_AGAIN', 'net.dns_failure'],
    ['ECONNREFUSED', 'net.connection_refused'],
    ['ETIMEDOUT', 'net.timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'net.timeout'],
    ['CERT_HAS_EXPIRED', 'tls.cert_expired'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls.self_signed'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls.self_signed'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls.untrusted_issuer'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls.hostname_mismatch'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls.protocol_mismatch'],
    ['ECONNRESET', 'net.connection_reset'],
    ['ERR_INVALID_URL', 'config.url_invalid'],
    ['SOMETHING_NEW', 'net.unreachable'],
  ]
  for (const [code, expected] of cases) {
    // This is the shape Node's fetch actually produces: a TypeError with the
    // real error buried in `cause`.
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('boom'), { code }) })
    const finding = classifyNetworkError(err, 'https://mcp.example.com/mcp')
    assert.equal(finding.code, expected, `${code} -> ${finding.code}`)
    assert.equal(finding.severity, 'fatal')
    assert.ok(finding.fix, `${code} needs a fix line`)
  }
})

test('an expired certificate says "certificate has expired" and refuses to suggest disabling TLS checks', () => {
  const err = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'CERT_HAS_EXPIRED' }) })
  const f = classifyNetworkError(err, 'https://mcp.example.com/mcp')
  assert.match(f.message, /certificate has expired/)
  assert.match(f.fix, /NODE_TLS_REJECT_UNAUTHORIZED=0/)
  assert.match(f.fix, /do not reach for/i)
})

test('happy-eyeballs AggregateErrors are drilled into as well', () => {
  const err = new TypeError('fetch failed', {
    cause: Object.assign(new AggregateError([Object.assign(new Error('nope'), { code: 'ECONNREFUSED' })], 'all failed'), {}),
  })
  assert.equal(classifyNetworkError(err, 'http://127.0.0.1:1/mcp').code, 'net.connection_refused')
})

test('a blocked legacy port is named instead of failing opaquely', async () => {
  // Node's fetch refuses ports 7, 9, 25... before opening a socket, and says
  // only "fetch failed" with no error code to go on.
  const d = await diagnoseServer(
    { name: 'p', kind: 'http', url: 'http://127.0.0.1:9/mcp', headers: {}, sources: ['H (/tmp/c.json)'] },
    OPTS,
  )
  const f = d.findings.find((x) => x.code === 'net.blocked_port')
  assert.ok(f, codes(d).join(','))
  assert.match(f.message, /port 9/)
})

test('a timeout with no error code is still a timeout', () => {
  const f = classifyNetworkError(new Error('The operation was aborted'), 'https://slow.example.com/mcp', true)
  assert.equal(f.code, 'net.timeout')
})

// ------------------------------------------------------------------- parsers

test('oauthMetadataUrl reads both the parameter and a bare well-known URL', () => {
  assert.equal(
    oauthMetadataUrl('Bearer resource_metadata="https://a.example/.well-known/oauth-protected-resource"'),
    'https://a.example/.well-known/oauth-protected-resource',
  )
  assert.equal(
    oauthMetadataUrl('Bearer resource_metadata=https://b.example/.well-known/oauth-protected-resource, realm="x"'),
    'https://b.example/.well-known/oauth-protected-resource',
  )
  assert.equal(
    oauthMetadataUrl('Bearer realm="see https://c.example/.well-known/oauth-protected-resource"'),
    'https://c.example/.well-known/oauth-protected-resource',
  )
  assert.equal(oauthMetadataUrl('Bearer realm="mcp"'), null)
  assert.equal(oauthMetadataUrl(undefined), null)
})

test('readRpcBody handles plain JSON, SSE frames and rubbish', () => {
  assert.equal(readRpcBody('{"id":1,"result":{}}', 'application/json').id, 1)
  assert.equal(readRpcBody('event: message\ndata: {"id":7,"result":{}}\n\n', 'text/event-stream').id, 7)
  assert.equal(readRpcBody('<html>', 'text/html'), null)
  assert.equal(readRpcBody('', 'application/json'), null)
})

test('a bare host name is rejected before a socket is opened', () => {
  const findings = staticChecks({ name: 'r', kind: 'http', url: 'mcp.example.com/mcp', headers: {}, sources: ['H (/tmp/c.json)'] })
  assert.equal(findings[0].code, 'config.url_invalid')
  assert.match(findings[0].fix, /https:\/\//)
})

test('a placeholder Authorization header is caught without contacting anything', () => {
  const findings = staticChecks({
    name: 'r',
    kind: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer YOUR_TOKEN_HERE' },
    sources: ['Cursor (/home/u/.cursor/mcp.json)'],
  })
  assert.equal(findings[0].code, 'header.placeholder')
  assert.match(findings[0].message, /Authorization/)
  assert.ok(!findings[0].message.includes('YOUR_TOKEN_HERE'), 'the value must not be echoed')
})

test('classifyHttpProbe is pure enough to grade a response nobody fetched', () => {
  const f = classifyHttpProbe({
    url: 'https://x.example/sse',
    status: 405,
    statusText: 'Method Not Allowed',
    headers: {},
    body: '',
    authSent: false,
  })
  assert.equal(f.code, 'http.wrong_endpoint')
  assert.match(f.fix, /\/mcp/)
})

// ------------------------------------------------------------------ privacy

test('a real token in a header never reaches the report, even when the server echoes it', async () => {
  const token = 'ghp_aB3xY7zQ9mN2pL5kR8tW1vC4dF6gH0jK'
  const d = await diagnoseServer(remote('/needs-auth', { headers: { Authorization: `Bearer ${token}` } }), OPTS)
  const rendered = renderTerminal({
    diagnoses: [d], configsSearched: [], configErrors: [], healthy: 0, broken: 1, warnings: 0, durationMs: 1,
  })
  // The fixture answers 401 with the credential it was sent echoed in the body.
  assert.ok(!JSON.stringify(d.findings).includes(token), 'the token leaked into the findings')
  assert.ok(!rendered.includes(token), 'the token leaked into the terminal report')
  assert.ok(!JSON.stringify(redactSpecSecrets(d)).includes(token), 'the token leaked through the spec')
  // ...and knowing a credential *was* sent still changes the advice.
  assert.match(d.findings[0].message, /rejected the credentials it was sent/)
})

test('--json never carries the env block or the headers through verbatim', () => {
  const masked = redactSpecSecrets({
    spec: {
      env: { GITHUB_TOKEN: 'ghp_realvalue0000000000000000000000', LOG_LEVEL: 'debug', EMPTY_KEY: '' },
      headers: { Authorization: 'Bearer abc123', 'X-Trace': 'on' },
    },
  })
  assert.equal(masked.spec.env.GITHUB_TOKEN, '<redacted>')
  assert.equal(masked.spec.headers.Authorization, '<redacted>')
  // Harmless settings stay readable -- they are often the diagnosis.
  assert.equal(masked.spec.env.LOG_LEVEL, 'debug')
  assert.equal(masked.spec.headers['X-Trace'], 'on')
  // "It is set to nothing" is information, not a secret.
  assert.equal(masked.spec.env.EMPTY_KEY, '')
})
