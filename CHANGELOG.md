# Changelog

All notable changes to mcp-wtf. This project follows [semantic versioning](https://semver.org/).

## 0.2.0

The first release that answers "why won't it connect" for servers that are not a local process.

### Remote servers (HTTP, streamable HTTP, SSE)

`--url`, and any `url` / `serverUrl` / `httpUrl` entry in a config, now gets a real MCP `initialize` over the wire, and the response is classified rather than reduced to "failed to connect":

- **Connection level** — DNS resolution failure, connection refused, connect timeout, connection reset, `certificate has expired`, self-signed and untrusted-issuer chains, hostname mismatch, `https://` pointed at a plain-HTTP port, and an unusable URL caught before a socket is opened.
- **Response level** — `401` (with and without credentials), `401` advertising OAuth protected-resource metadata (the client must run the OAuth flow; a token in a config cannot substitute), `403`, `404` (with `/mcp` and `/sse` suffix hints), `405`/`406` (streamable HTTP vs HTTP+SSE confusion, confirmed by a `GET` that returns an event stream), `3xx` redirects reported with their `Location`, `429`, `5xx`, HTML pages, non-JSON bodies, JSON-RPC errors, and JSON that is not MCP.
- A healthy endpoint reports the server's name and version, and says so: the problem is client-side.

### Log-file mode

`--logs` reads the host's own MCP log files — auto-discovered under `%APPDATA%\Claude\logs`, `~/Library/Logs/Claude` or `~/.config/Claude/logs` — and runs the failure signatures over the last 200 lines of each.

- Findings are attributed to the server each line names, so the interleaved shared `mcp.log` is usable, and rotated files fold back into one entry per server.
- Repeated identical findings are collapsed; mirrored JSON-RPC traffic is never read as evidence; a symptom ("and then it disconnected") is dropped once something explains it, and is only a warning on its own, because quitting the host writes the same line.
- New signatures: Docker daemon not running, `spawn … ENOENT` as the host phrases it, host-side JSON parse failures (which mean stdout pollution, not a server exception), unexpected transport close, and `ModuleNotFoundError` for Python servers.

### More hosts

Configs are now also read from **Gemini CLI** (`~/.gemini/settings.json`, including `httpUrl`), **Cline**, **Roo Code** (both in the VS Code `globalStorage`), and **Zed** (`context_servers`, including the `{path, args, env}` command form) — on all three OS layouts.

Config files are parsed as JSONC: comments and trailing commas are what these files actually contain, and calling them "not valid JSON" was a confident, wrong diagnosis.

### Also

- Secrets are redacted from every string borrowed from a log file or an HTTP response, and `--json` no longer prints `env` and `headers` values for credential-shaped keys.
- `info` findings no longer downgrade a healthy verdict to a warning.
- An `env` value that is not a string is dropped instead of breaking a later check.
- The same remote URL configured with different headers is no longer merged into one server.

## 0.1.0

Initial release. Finds every stdio MCP server configured in Claude Desktop, Claude Code, Cursor, Windsurf and VS Code, launches each one the way the host would, and explains what went wrong: unparseable configs, arguments baked into `command`, commands missing from `PATH`, placeholder API keys, missing modules and packages, ports in use, rejected credentials, stdout pollution, and handshakes that never complete.
