import { SUPPORTED_PROTOCOL_VERSIONS } from './client/index.js'
import { quoteLine, redactSecrets } from './redact.js'
import { VERSION } from './version.js'
import type { Diagnosis, Finding, ServerSpec, WtfOptions } from './types.js'

/**
 * Remote (streamable-HTTP and HTTP+SSE) diagnosis.
 *
 * The stdio path can watch a process die and read its last words. A remote
 * server gives you one HTTP response and nothing else, so everything has to be
 * squeezed out of it: the status line, three headers, and the first few
 * hundred bytes of the body. Hosts throw all of that away and print "failed to
 * connect", which is why nobody can tell a wrong path from an expired token.
 *
 * The classifiers are pure functions over a captured response so they can be
 * tested against a local server instead of the internet.
 */

const BODY_LIMIT = 4000

/** Everything the classifier is allowed to see. Deliberately small. */
export interface HttpProbe {
  url: string
  status: number
  statusText: string
  /** Lower-cased names, and only the ones a diagnosis can use. */
  headers: Record<string, string>
  body: string
  /** Whether the request carried an Authorization/api-key header. */
  authSent: boolean
  /** Set when a GET to the same URL returned an event stream. */
  sseOnGet?: boolean
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** `https://host/foo/sse` -> `https://host/foo/mcp`, and back. */
function swapSuffix(url: string, from: string, to: string): string {
  return url.replace(new RegExp(`${from}/?$`), to)
}

function configFileOf(spec: ServerSpec): string {
  const m = spec.sources[0]?.match(/\((.+)\)$/)
  return m?.[1] ?? 'your MCP config file'
}

// ---------------------------------------------------------------------------
// Connection-level failures: nothing came back at all.
// ---------------------------------------------------------------------------

/** Node buries the real reason under `TypeError: fetch failed`; dig it out. */
function drill(error: unknown): { codes: string[]; messages: string[] } {
  const codes: string[] = []
  const messages: string[] = []
  let cur: unknown = error
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
    if (typeof e.code === 'string') codes.push(e.code)
    if (typeof e.message === 'string') messages.push(e.message)
    // Happy-eyeballs failures arrive as an AggregateError of per-address errors.
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors as Array<{ code?: unknown; message?: unknown }>) {
        if (typeof sub.code === 'string') codes.push(sub.code)
        if (typeof sub.message === 'string') messages.push(sub.message)
      }
    }
    cur = e.cause
  }
  return { codes, messages }
}

export function classifyNetworkError(error: unknown, url: string, timedOut = false): Finding {
  const { codes, messages } = drill(error)
  const has = (...want: string[]) => want.some((w) => codes.includes(w))
  const host = hostOf(url)
  const secure = url.startsWith('https:')
  const detail = redactSecrets(
    [`fetch failed: ${messages[0] ?? String(error)}`, codes.length ? `code: ${codes.join(', ')}` : null]
      .filter(Boolean)
      .join('\n'),
  )

  if (has('ERR_INVALID_URL')) {
    return {
      code: 'config.url_invalid',
      severity: 'fatal',
      message: `"${url}" is not a URL Node can request.`,
      fix: 'A remote MCP server needs a full URL including the scheme: https://example.com/mcp, not example.com/mcp.',
      detail,
    }
  }
  if (has('ENOTFOUND', 'EAI_AGAIN')) {
    return {
      code: 'net.dns_failure',
      severity: 'fatal',
      message: `The host name "${host}" does not resolve -- DNS has never heard of it.`,
      fix: 'Check the spelling in the config first; a typo here fails exactly like a dead server. If the name is right, this host is internal (VPN or split-horizon DNS) and you are not on the network that can see it.',
      detail,
    }
  }
  if (has('ECONNREFUSED')) {
    return {
      code: 'net.connection_refused',
      severity: 'fatal',
      message: `Nothing is listening on ${host} -- the connection was refused.`,
      fix: 'The address resolves but the port is closed. If this is localhost, the server you meant to run is not running (or it is listening on a different port). If it is remote, a firewall is dropping you.',
      detail,
    }
  }
  if (timedOut || has('ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ABORT_ERR')) {
    return {
      code: 'net.timeout',
      severity: 'fatal',
      message: `${host} accepted nothing and answered nothing before the timeout.`,
      fix: 'A refused connection is instant; a silent one is a firewall, a VPN you are not on, or a proxy swallowing the request. Try the URL with curl from the same machine -- if curl also hangs, this is not an MCP problem.',
      detail,
    }
  }
  if (has('CERT_HAS_EXPIRED')) {
    return {
      code: 'tls.cert_expired',
      severity: 'fatal',
      message: `The TLS certificate for ${host} has expired ("certificate has expired").`,
      fix: 'The server operator has to renew it. Nothing on your side is wrong -- and do not reach for NODE_TLS_REJECT_UNAUTHORIZED=0, which turns off certificate checking for every connection the host makes.',
      detail,
    }
  }
  if (has('DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN')) {
    return {
      code: 'tls.self_signed',
      severity: 'fatal',
      message: `${host} presents a self-signed certificate, which Node refuses by default.`,
      fix: 'Usual for an internal or self-hosted server. The clean fix is to trust the issuing CA on this machine (NODE_EXTRA_CA_CERTS=/path/to/ca.pem in the host\'s environment). Use plain http:// on localhost instead of an untrusted https://.',
      detail,
    }
  }
  if (has('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT')) {
    return {
      code: 'tls.untrusted_issuer',
      severity: 'fatal',
      message: `The certificate chain for ${host} cannot be verified -- an issuer certificate is missing.`,
      fix: 'Either the server is not sending its intermediate certificate, or a corporate TLS-inspecting proxy is re-signing traffic with a CA this process does not trust. Point NODE_EXTRA_CA_CERTS at your company root CA.',
      detail,
    }
  }
  if (has('ERR_TLS_CERT_ALTNAME_INVALID')) {
    return {
      code: 'tls.hostname_mismatch',
      severity: 'fatal',
      message: `The certificate ${host} presents is for a different host name.`,
      fix: 'You are reaching the right IP through the wrong name -- an entry in /etc/hosts, an internal load balancer, or a URL that should use the public host name.',
      detail,
    }
  }
  if (has('EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG')) {
    return {
      code: 'tls.protocol_mismatch',
      severity: 'fatal',
      message: `The TLS handshake with ${host} failed -- what is listening there does not speak TLS.`,
      fix: secure
        ? `This is almost always https:// pointed at a plain-HTTP port. Try http://${host}${pathOf(url)}.`
        : 'The port is speaking a protocol this client cannot read.',
      detail,
    }
  }
  if (has('ECONNRESET')) {
    return {
      code: 'net.connection_reset',
      severity: 'fatal',
      message: `${host} accepted the connection and then killed it mid-request.`,
      fix: 'A proxy or load balancer dropped the request, or the server crashed while handling it. If this is behind a corporate proxy, the proxy is the first suspect.',
      detail,
    }
  }
  // Node's fetch refuses the WHATWG blocked ports outright, and reports it as
  // an unadorned "fetch failed" with no code at all.
  if (messages.some((m) => /bad port/i.test(m))) {
    let port = ''
    try {
      port = new URL(url).port
    } catch {
      /* Then the port is not the interesting part of the problem. */
    }
    return {
      code: 'net.blocked_port',
      severity: 'fatal',
      message: `Node refuses to open a connection to port ${port || 'that'} at all -- it is one of the legacy ports the URL standard blocks.`,
      fix: 'Ports like 7, 9, 25, 110 and 143 are blocked in browsers and in Node\'s fetch, so no client can reach an MCP server there. Almost always this is a typo in the port; if the server really does listen there, move it.',
      detail,
    }
  }

  return {
    code: 'net.unreachable',
    severity: 'fatal',
    message: `The request to ${url} failed before any response arrived ("fetch failed").`,
    fix: 'Nothing answered. Check the URL, then whether this machine can reach that host at all (curl, ping, VPN).',
    detail,
  }
}

// ---------------------------------------------------------------------------
// Response-level failures: something came back, but it was not MCP.
// ---------------------------------------------------------------------------

/** OAuth 2.0 protected-resource metadata, as advertised on a 401. */
export function oauthMetadataUrl(wwwAuthenticate: string | undefined): string | null {
  if (!wwwAuthenticate) return null
  const explicit = wwwAuthenticate.match(/resource_metadata\s*=\s*"?([^",\s]+)"?/i)
  if (explicit?.[1]) return explicit[1]
  const wellKnown = wwwAuthenticate.match(/([^\s",]*\/\.well-known\/oauth-(?:protected-resource|authorization-server)[^\s",]*)/i)
  return wellKnown?.[1] ?? null
}

function isHtml(probe: HttpProbe): boolean {
  if ((probe.headers['content-type'] ?? '').includes('text/html')) return true
  return /^\s*<(?:!doctype|html|head|body)\b/i.test(probe.body)
}

function htmlTitle(body: string): string | null {
  return body.match(/<title[^>]*>([^<]{1,120})</i)?.[1]?.trim() ?? null
}

function responseLine(probe: HttpProbe): string {
  const bits = [`HTTP ${probe.status} ${probe.statusText}`.trim()]
  if (probe.headers['content-type']) bits.push(`content-type: ${probe.headers['content-type']}`)
  return bits.join('  |  ')
}

function withBody(probe: HttpProbe, extra?: string): string {
  const lines = [responseLine(probe)]
  if (extra) lines.push(extra)
  const snippet = quoteLine(probe.body, 220)
  if (snippet) lines.push(`> ${snippet}`)
  return lines.join('\n')
}

/** Pull the JSON-RPC reply out of a body that may be JSON or an SSE stream. */
export function readRpcBody(body: string, contentType: string): Record<string, unknown> | null {
  const text = contentType.includes('text/event-stream')
    ? body
        .split(/\n\n/)
        .map((frame) =>
          frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join(''),
        )
        .filter(Boolean)
        .find((data) => data.includes('"id"')) ?? ''
    : body
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function serverInfoOf(rpc: Record<string, unknown> | null): Diagnosis['serverInfo'] {
  const result = (rpc?.['result'] ?? null) as Record<string, unknown> | null
  if (!result || typeof result['protocolVersion'] !== 'string') return null
  return (result['serverInfo'] as Diagnosis['serverInfo']) ?? {}
}

/**
 * Grade one captured response. Returns null when the endpoint answered a
 * correct MCP handshake -- the only outcome that is not a diagnosis.
 */
export function classifyHttpProbe(probe: HttpProbe, cfg = 'your MCP config file'): Finding | null {
  const { status, url } = probe
  const path = pathOf(url)

  if (status >= 300 && status < 400) {
    const location = probe.headers['location']
    return {
      code: 'http.redirect',
      severity: 'fatal',
      message: location
        ? `The endpoint answers ${status} and redirects to ${location}.`
        : `The endpoint answers ${status} but sent no Location header to follow.`,
      fix: location
        ? `Most MCP clients do not follow redirects on the handshake POST, so this reads as "failed to connect". Put the final URL in ${cfg}: ${location}. http:// to https:// and a missing or extra trailing slash are the usual causes.`
        : 'A redirect with no destination is a misconfigured proxy in front of the server.',
      detail: withBody(probe),
    }
  }

  if (status === 401) {
    const header = probe.headers['www-authenticate']
    const metadata = oauthMetadataUrl(header)
    if (metadata) {
      return {
        code: 'auth.oauth_required',
        severity: 'fatal',
        message: `The endpoint returned 401 Unauthorized and points at OAuth protected-resource metadata (${metadata}).`,
        fix: `This server wants a full OAuth flow, not a token pasted into a config: the client must fetch that metadata, register, open a browser for consent, and use the access token it gets back. Hosts that implement remote OAuth (Claude Desktop, Claude Code, VS Code) do it for you -- add the server there and let it sign you in. No "headers" entry in ${cfg} will work until you hold a token from that flow.`,
        detail: withBody(probe, `www-authenticate: ${redactSecrets(header ?? '')}`),
      }
    }
    return {
      code: 'auth.unauthorized',
      severity: 'fatal',
      message: probe.authSent
        ? 'The endpoint returned 401 Unauthorized -- it is alive and it rejected the credentials it was sent.'
        : 'The endpoint returned 401 Unauthorized -- it needs credentials and the handshake carried none.',
      fix: probe.authSent
        ? `The token in the "headers" block for this server in ${cfg} is wrong, expired, or belongs to another account. Note that 401 comes from the server, not from MCP: the transport is working perfectly.`
        : `Add the credential to this server in ${cfg}: "headers": { "Authorization": "Bearer <token>" }. On the command line: mcp-wtf --url ${url} --header "Authorization: Bearer <token>".`,
      detail: withBody(probe, header ? `www-authenticate: ${redactSecrets(header)}` : undefined),
    }
  }

  if (status === 403) {
    return {
      code: 'auth.forbidden',
      severity: 'fatal',
      message: 'The endpoint returned 403 Forbidden -- the credentials were understood, and this account is still not allowed in.',
      fix: 'The token is valid but lacks the scope, plan or seat the server requires -- or something between you and it (IP allowlist, corporate proxy, Cloudflare) is refusing the request rather than the server itself.',
      detail: withBody(probe),
    }
  }

  // A web site answers 404 and 405 with a rendered page. Saying so turns
  // "wrong path" into "wrong kind of address entirely".
  const pageHint = isHtml(probe)
    ? ` The response body is an HTML page${htmlTitle(probe.body) ? ` ("${htmlTitle(probe.body)}")` : ''}, so this address belongs to a web site rather than to an MCP endpoint.`
    : ''

  if (status === 404) {
    const suffixHint = /\/sse\/?$/.test(path)
      ? `This URL ends in /sse. If the server has moved to streamable HTTP, the path is usually ${swapSuffix(url, '/sse', '/mcp')}.`
      : /\/mcp\/?$/.test(path)
        ? `This URL ends in /mcp, so the path shape is right -- either the server was removed, or it is the older HTTP+SSE kind and lives at ${swapSuffix(url, '/mcp', '/sse')}.`
        : `Remote MCP servers almost never live at the site root. Try ${url.replace(/\/$/, '')}/mcp (streamable HTTP) or ${url.replace(/\/$/, '')}/sse (the older HTTP+SSE transport).`
    return {
      code: 'http.not_found',
      severity: 'fatal',
      message: `The endpoint returned 404 Not Found -- there is a web server on ${hostOf(url)}, but nothing is served at ${path}.`,
      fix: `${suffixHint}${pageHint} If the URL came from a blog post rather than the server's own docs, assume it is stale.`,
      detail: withBody(probe),
    }
  }

  if (status === 405 || status === 406) {
    const sseFix = probe.sseOnGet
      ? `A GET to this same URL returns text/event-stream, so this is the older HTTP+SSE transport. Configure it as an SSE server ("type": "sse" in ${cfg}) instead of streamable HTTP, or ask the operator for the streamable-HTTP path.`
      : /\/sse\/?$/.test(path)
        ? `The path ends in /sse, so this is almost certainly an HTTP+SSE endpoint being spoken to as streamable HTTP. Set "type": "sse" for this server in ${cfg}, or point at ${swapSuffix(url, '/sse', '/mcp')}.`
        : `You are pointing one kind of MCP client at the other kind of endpoint. Try the same URL with /mcp (streamable HTTP) or /sse (HTTP+SSE), and check the "type" set for this server in ${cfg}.${pageHint}`
    return {
      code: 'http.wrong_endpoint',
      severity: 'fatal',
      message:
        status === 405
          ? 'The endpoint returned 405 Method Not Allowed to the handshake POST -- something is there, but it does not accept the POST that streamable HTTP is made of.'
          : 'The endpoint returned 406 Not Acceptable to the handshake POST, even though it was offered both application/json and text/event-stream.',
      fix: sseFix,
      detail: withBody(probe),
    }
  }

  if (status === 429) {
    return {
      code: 'http.rate_limited',
      severity: 'fatal',
      message: 'The endpoint returned 429 Too Many Requests before the handshake could finish.',
      fix: `Wait${probe.headers['retry-after'] ? ` ${probe.headers['retry-after']}s (the server said so)` : ''} and try again. If it is immediate and permanent, the account behind this token is over its quota.`,
      detail: withBody(probe),
    }
  }

  if (status >= 500) {
    return {
      code: 'http.server_error',
      severity: 'fatal',
      message: `The endpoint returned ${status} ${probe.statusText} -- the server is reachable and failing on its own side.`,
      fix: 'Nothing in your config can fix a 5xx. A 502 or 504 means the proxy in front of the MCP server cannot reach it; a 500 means the server threw. Retry, then check the provider status page.',
      detail: withBody(probe),
    }
  }

  if (isHtml(probe)) {
    const title = htmlTitle(probe.body)
    return {
      code: 'http.html_response',
      severity: 'fatal',
      message: `The URL answered with an HTML page${title ? ` ("${title}")` : ''}, not with MCP.`,
      fix: 'You have the address of a web page -- a docs site, a dashboard, or a login screen -- rather than an MCP endpoint. This is what makes clients report "Unexpected token < in JSON at position 0": they are parsing "<!doctype html>" as a JSON-RPC reply. Get the endpoint URL from the server\'s own documentation; it usually ends in /mcp or /sse.',
      detail: withBody(probe),
    }
  }

  if (status >= 400) {
    return {
      code: 'http.bad_request',
      severity: 'fatal',
      message: `The endpoint rejected the MCP handshake with ${status} ${probe.statusText}.`,
      fix: `The request reached a real server and it did not like it. Streamable-HTTP servers answer 400 when they want a session id that only an accepted initialize can give them -- which usually means the URL belongs to a different transport. Check the "type" for this server in ${cfg}.`,
      detail: withBody(probe),
    }
  }

  const rpc = readRpcBody(probe.body, probe.headers['content-type'] ?? '')
  if (!rpc) {
    return {
      code: 'http.not_json',
      severity: 'fatal',
      message: `The endpoint answered ${status} with ${probe.headers['content-type'] || 'no content-type'}, but the body is not a JSON-RPC message.`,
      fix: 'Something is listening and it is not an MCP server. If the body below looks like an API or a health check, the URL belongs to the wrong service.',
      detail: withBody(probe),
    }
  }
  const error = rpc['error'] as { code?: number; message?: string } | undefined
  if (error) {
    return {
      code: 'handshake.rejected',
      severity: 'fatal',
      message: `The server answered the handshake with a JSON-RPC error: ${error.code} ${error.message ?? ''}`.trim(),
      fix: 'The transport works -- the server understood the request and refused it. A -32600 here usually means a protocol-version mismatch between this client and an old server.',
      detail: withBody(probe),
    }
  }
  if (!serverInfoOf(rpc)) {
    return {
      code: 'handshake.not_mcp',
      severity: 'fatal',
      message: 'The endpoint answered with JSON, but not with an MCP initialize result (no protocolVersion in it).',
      fix: 'Something here speaks JSON and does not speak MCP -- a REST API, a proxy, or a health endpoint. Check the URL against the server\'s documentation.',
      detail: withBody(probe),
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The probe itself.
// ---------------------------------------------------------------------------

const INTERESTING_HEADERS = ['content-type', 'location', 'www-authenticate', 'retry-after', 'mcp-session-id']

interface RawResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number,
): Promise<RawResponse> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'manual', // A silently-followed redirect hides the diagnosis.
      signal: ac.signal,
    })
    const picked: Record<string, string> = {}
    for (const name of INTERESTING_HEADERS) {
      const value = res.headers.get(name)
      if (value) picked[name] = value
    }
    // The timeout has to cover the body too: an SSE response is a stream that
    // a server under no obligation to close would otherwise hold open forever.
    const body = (await res.text()).slice(0, BODY_LIMIT)
    return { status: res.status, statusText: res.statusText, headers: picked, body }
  } finally {
    clearTimeout(timer)
  }
}

/** A GET that answers text/event-stream is the old HTTP+SSE transport. */
async function looksLikeSseEndpoint(url: string, headers: Record<string, string>, timeoutMs: number): Promise<boolean> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.min(timeoutMs, 3000))
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...headers, accept: 'text/event-stream' },
      redirect: 'manual',
      signal: ac.signal,
    })
    const ctype = res.headers.get('content-type') ?? ''
    // Never read the stream; an SSE endpoint would keep us here indefinitely.
    await res.body?.cancel().catch(() => {})
    return res.ok && ctype.includes('text/event-stream')
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function initializePayload(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
      clientInfo: { name: 'mcp-wtf', version: VERSION },
    },
  }
}

const AUTH_HEADER = /^(authorization|x-api-key|api[-_]?key|proxy-authorization)$/i

export interface RemoteResult {
  findings: Finding[]
  serverInfo?: Diagnosis['serverInfo']
  toolCount?: number
  connectMs?: number
}

/**
 * Attempt one real MCP handshake over HTTP and grade whatever comes back. On
 * success it keeps the session and asks for the tool list, so the report can
 * say what the server actually offers.
 */
export async function probeRemote(spec: ServerSpec, options: WtfOptions): Promise<RemoteResult> {
  const url = spec.url!
  const cfg = configFileOf(spec)
  const extra = spec.headers ?? {}
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  }
  const authSent = Object.keys(extra).some((k) => AUTH_HEADER.test(k))

  const t0 = Date.now()
  let res: RawResponse
  try {
    res = await postJson(url, headers, initializePayload(), options.timeoutMs)
  } catch (e) {
    const timedOut = (e as Error).name === 'AbortError'
    return { findings: [classifyNetworkError(e, url, timedOut)] }
  }
  const connectMs = Date.now() - t0

  const probe: HttpProbe = { url, ...res, authSent }
  // A 404/405/406 is where the two remote transports get confused for each
  // other, and a GET settles it -- so pay for that extra round trip only there.
  if (probe.status === 404 || probe.status === 405 || probe.status === 406) {
    probe.sseOnGet = await looksLikeSseEndpoint(url, extra, options.timeoutMs)
  }

  const finding = classifyHttpProbe(probe, cfg)
  if (finding) return { findings: [finding] }

  const rpc = readRpcBody(probe.body, probe.headers['content-type'] ?? '')
  const serverInfo = serverInfoOf(rpc)
  const named = serverInfo?.name ? `${serverInfo.name}${serverInfo.version ? ` v${serverInfo.version}` : ''}` : 'the server'
  const findings: Finding[] = [
    {
      code: 'remote.reachable',
      severity: 'info',
      message: `The endpoint completed the MCP handshake in ${connectMs}ms (${named}). Nothing is wrong with this server.`,
      fix: `If your client still says it cannot connect, the problem is on the client side: the URL it has is not this one, it is sending different (or no) headers, it is configured with the wrong transport "type", or it is behind a proxy this shell is not. Compare the entry in ${cfg} with the URL you just tested.`,
    },
  ]

  const session = probe.headers['mcp-session-id']
  const sessionHeaders = session ? { ...headers, 'mcp-session-id': session } : headers
  let toolCount: number | undefined
  try {
    // The spec requires this notification before any other request.
    await postJson(url, sessionHeaders, { jsonrpc: '2.0', method: 'notifications/initialized' }, options.timeoutMs)
    const listed = await postJson(url, sessionHeaders, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, options.timeoutMs)
    const result = readRpcBody(listed.body, listed.headers['content-type'] ?? '')?.['result'] as
      | { tools?: unknown[] }
      | undefined
    if (Array.isArray(result?.tools)) toolCount = result.tools.length
  } catch {
    /* The handshake is the diagnosis; a failed tools/list is not one. */
  }

  if (toolCount === 0) {
    findings.push({
      code: 'tools.none',
      severity: 'warn',
      message: 'Connected fine, but the server exposes zero tools.',
      fix: 'Remote servers commonly hide their tools until the connection is authorised -- if you expected tools here, this connection is anonymous or under-scoped.',
    })
  }

  return { findings, serverInfo, toolCount, connectMs }
}
