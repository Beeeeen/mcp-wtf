/**
 * Everything quoted back from a log file or an HTTP response passes through
 * here first.
 *
 * Config env values are easy: mcp-wtf names the key and never the value. Logs
 * and HTTP responses are not, because they were written by someone else --
 * hosts cheerfully log `Authorization: Bearer ...`, and a 401 body often
 * echoes the token that failed. The promise is that a report can be pasted
 * into a GitHub issue without reading it first, so this is applied to every
 * borrowed string, not only the ones that look risky.
 */

/** Header-shaped credentials. The scheme word is kept; the value is not. */
const HEADER_VALUE =
  /((?:proxy-)?authorization|x-api-key|api[-_]?key|cookie)(["']?\s*[:=]\s*["']?)((?:bearer|basic|token)\s+)?([^\s"',;]+)/gi

/** `GITHUB_TOKEN=ghp_...`, `api_key=...`, `"password": "..."`. */
const KEYED_VALUE =
  /([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|credentials?|password|passwd|secret|token)s?)(["']?\s*[:=]\s*["']?)([^\s"',;&)\]}]{6,})/gi

/** Shapes that are a credential wherever they turn up, with no key to name them. */
const TOKEN_SHAPES: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, // JWT
  /\b[A-Fa-f0-9]{32,}\b/g, // hex digests and hex-encoded keys
]

/** Long opaque runs: a token if it mixes cases and digits, a word if it does not. */
const OPAQUE_RUN = /[A-Za-z0-9+_=-]{40,}/g

const REDACTED = '<redacted>'

export function redactSecrets(text: string): string {
  let out = text.replace(HEADER_VALUE, (_m, key, sep, scheme) => `${key}${sep}${scheme ?? ''}${REDACTED}`)
  out = out.replace(KEYED_VALUE, (_m, key, sep) => `${key}${sep}${REDACTED}`)
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED)
  out = out.replace(OPAQUE_RUN, (run) =>
    /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run) ? REDACTED : run,
  )
  return out
}

/** Redact, collapse whitespace and clip -- the form used for quoted evidence. */
export function quoteLine(line: string, max = 200): string {
  const clean = redactSecrets(line).replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

/** Keys whose value is a credential by definition, whatever it looks like. */
const CREDENTIAL_KEY = /(token|key|secret|password|credential|auth|cookie)/i

/**
 * `--json` prints the spec it diagnosed, and a spec carries the env block and
 * the headers -- the two places a live credential actually lives. Mask them on
 * the way out so a report stays safe to paste, while leaving harmless settings
 * (LOG_LEVEL, a workspace path) readable, since those are often the diagnosis.
 */
function maskValues(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!record) return record
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    out[key] = CREDENTIAL_KEY.test(key) && value !== '' ? REDACTED : redactSecrets(value)
  }
  return out
}

export function redactSpecSecrets<T extends { spec: { env?: Record<string, string>; headers?: Record<string, string> } }>(
  diagnosis: T,
): T {
  return {
    ...diagnosis,
    spec: { ...diagnosis.spec, env: maskValues(diagnosis.spec.env), headers: maskValues(diagnosis.spec.headers) },
  }
}
