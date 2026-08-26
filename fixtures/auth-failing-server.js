#!/usr/bin/env node
// Starts, then discovers its API key is bad -- and says so on stderr.
console.error('Error: 401 Unauthorized - invalid api key provided')
process.exit(1)
