import { test } from 'node:test'
import assert from 'node:assert/strict'

import { quoteLine, redactSecrets } from '../dist/redact.js'

// Log lines and HTTP bodies are written by someone else, so they are the one
// place a live credential can reach a report. These are the shapes that matter.

test('credentials are removed whatever shape they arrive in', () => {
  const cases = [
    ['Authorization: Bearer ghp_aB3xY7zQ9mN2pL5kR8tW1vC4dF6', 'ghp_aB3xY7zQ9mN2pL5kR8tW1vC4dF6'],
    ['authorization=Basic dXNlcjpwYXNzd29yZDEyMw==', 'dXNlcjpwYXNzd29yZDEyMw=='],
    ['x-api-key: 9f8e7d6c5b4a39281706', '9f8e7d6c5b4a39281706'],
    ['GET /v1/things?api_key=abc123def456 HTTP/1.1', 'abc123def456'],
    ['env GITHUB_TOKEN=ghp_0123456789abcdefghij failed', 'ghp_0123456789abcdefghij'],
    ['{"client_secret": "s3cr3t-value-here"}', 's3cr3t-value-here'],
    ['password=hunter2000 rejected', 'hunter2000'],
    ['sk-proj-Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0 was refused', 'sk-proj-Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0'],
    ['slack said no to xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
    ['token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123 expired', 'eyJhbGciOiJIUzI1NiJ9'],
    ['digest 0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
    ['key=Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUlM', 'Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUlM'],
  ]
  for (const [line, secret] of cases) {
    const out = redactSecrets(line)
    assert.ok(!out.includes(secret), `not redacted: ${line} -> ${out}`)
    assert.match(out, /<redacted>/, line)
  }
})

test('the scheme survives so the report can still say what kind of auth failed', () => {
  assert.equal(redactSecrets('Authorization: Bearer abc123def456'), 'Authorization: Bearer <redacted>')
  assert.match(redactSecrets('GITHUB_TOKEN=ghp_0123456789abcdefghij'), /^GITHUB_TOKEN=/)
})

test('ordinary text is left alone -- an over-eager redactor destroys the evidence', () => {
  const keep = [
    `Error: Cannot find module '@modelcontextprotocol/server-filesystem'`,
    'spawn npx ENOENT',
    '/home/user1/Documents/Projects/servers/filesystem/build/index.js',
    'C:\\Users\\ben\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
    'listen EADDRINUSE: address already in use :::3000',
    'Server started and connected successfully in 1240ms',
    'content-type: application/json; charset=utf-8',
  ]
  for (const line of keep) assert.equal(redactSecrets(line), line, `wrongly redacted: ${line}`)
})

test('quoteLine collapses whitespace and clips long lines', () => {
  assert.equal(quoteLine('  a\n  b\tc  '), 'a b c')
  const long = quoteLine('x'.repeat(400), 50)
  assert.equal(long.length, 53)
  assert.ok(long.endsWith('...'))
})
