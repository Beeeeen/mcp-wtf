#!/usr/bin/env node
/**
 * A minimal, well-behaved MCP server. Hand-rolled so the test suite has no
 * dependency on the official SDK, and so we can be certain the behaviour under
 * test is exactly what is written here.
 *
 * Every rule mcp-probe enforces is followed: JSON only on stdout, real
 * descriptions, honest capabilities, -32601 for unknown methods, and argument
 * validation before any work happens.
 */
import { createInterface } from 'node:readline'

const TOOLS = [
  {
    name: 'add',
    description: 'Add two numbers and return their sum. Use when the user asks for arithmetic on two explicit values.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'The first addend.' },
        b: { type: 'number', description: 'The second addend.' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'echo',
    description: 'Return the supplied text verbatim. Useful for checking that the connection is healthy end to end.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to send back unchanged.' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
]

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function callTool(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) return fail(id, -32602, `Unknown tool: ${name}`)

  for (const key of tool.inputSchema.required ?? []) {
    if (!(key in args)) return fail(id, -32602, `Missing required argument: ${key}`)
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = tool.inputSchema.properties[key]?.type
    if (!expected) return fail(id, -32602, `Unexpected argument: ${key}`)
    const actual = typeof value
    if (expected === 'number' && actual !== 'number') return fail(id, -32602, `Argument "${key}" must be a number`)
    if (expected === 'string' && actual !== 'string') return fail(id, -32602, `Argument "${key}" must be a string`)
  }

  if (name === 'add') return ok(id, { content: [{ type: 'text', text: String(args.a + args.b) }] })
  return ok(id, { content: [{ type: 'text', text: args.text }] })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    // A parse failure is reported, never fatal.
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  }

  const { id, method, params } = msg
  if (id === undefined || id === null) return // notification; nothing to answer

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'good-fixture', version: '1.0.0' },
      })
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, { tools: TOOLS })
    case 'tools/call':
      return callTool(id, params)
    default:
      return fail(id, -32601, `Method not found: ${method}`)
  }
})
