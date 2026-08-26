#!/usr/bin/env node
// Dies on startup the way a server with unbuilt dependencies does.
console.error("node:internal/modules/cjs/loader:1228")
console.error("Error: Cannot find module 'left-pad'")
console.error("    at Function._resolveFilename (node:internal/modules/cjs/loader:1225:15)")
process.exit(1)
