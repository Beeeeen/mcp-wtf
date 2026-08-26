#!/usr/bin/env node
// Logs to stdout before speaking MCP -- the classic "disconnects randomly".
import { createInterface } from 'node:readline'
console.log('[INFO] server booting...')
console.log('[INFO] loaded 3 plugins')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, method } = msg
  if (id === undefined || id === null) return
  if (method === 'initialize') {
    return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'polluter', version: '1.0.0' },
    } }) + '\n')
  }
  if (method === 'tools/list') {
    return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [
      { name: 'noop', description: 'Does nothing, successfully.', inputSchema: { type: 'object', properties: {} } },
    ] } }) + '\n')
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } }) + '\n')
})
