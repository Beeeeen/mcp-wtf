# mcp-wtf

**Your MCP server won't connect. Find out why in 10 seconds.**

[![CI](https://github.com/Beeeeen/mcp-wtf/actions/workflows/ci.yml/badge.svg)](https://github.com/Beeeeen/mcp-wtf/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-wtf.svg)](https://www.npmjs.com/package/mcp-wtf)
[![license](https://img.shields.io/npm/l/mcp-wtf.svg)](./LICENSE)

```bash
npx mcp-wtf
```

The host says *"MCP server failed to connect"*, or *"disconnected"*, or nothing at all — the server just isn't there. There are **17,000 GitHub issues** with that exact complaint, because the host throws away the one thing that would explain it: the server's dying words.

mcp-wtf finds every MCP server configured in Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Gemini CLI and Zed, actually launches each one the way the host would — or opens a real connection to it, if it is a remote server — keeps everything the host discards, and tells you exactly what is wrong, with the fix:

```
  mcp-wtf  5 of 7 MCP servers are broken -- here is exactly why
  2 configs searched

  DEAD  github  Claude Desktop
        x env.GITHUB_PERSONAL_ACCESS_TOKEN is still the placeholder "YOUR_TOKEN_HERE".
          fix: Put the real value into the "env" block of this server in
               claude_desktop_config.json.

  DEAD  crashy  Claude Code
        x The server crashed because a module is missing: left-pad.
          fix: Its dependencies are not installed. If this is your own server, run
               npm install in its directory.
          Error: Cannot find module 'left-pad'

  DEAD  pasted-cmd  Cursor
        x The command is "npx -y @modelcontextprotocol/server-memory" -- arguments
          are baked into the command string.
          fix: Split it: {"command": "npx", "args": ["-y","@modelcontextprotocol/server-memory"]}

  DEAD  py-tools  Claude Desktop
        x Command not found: "uvx". This produces the classic "spawn uvx ENOENT" error.
          fix: uv is not on the PATH this process sees. Use the absolute path to uvx
               (run `which uvx` / `where uvx`), or install uv system-wide.

  DEAD  linear  Cursor
        x The endpoint returned 401 Unauthorized and points at OAuth protected-resource
          metadata (https://mcp.linear.app/.well-known/oauth-protected-resource).
          fix: This server wants a full OAuth flow, not a token pasted into a config.

  WARN  noisy  Claude Desktop, 1 tool, 1ms
        ! The handshake succeeded, but the server wrote 2 non-JSON lines to stdout.
          Some hosts survive this; others disconnect at random.
          fix: Logs belong on stderr. This is the most common cause of
               "works sometimes, disconnects randomly".
          > [INFO] server booting...

   OK   filesystem  Claude Desktop, 14 tools, 240ms

  ----------------------------------------------------------------
  5 broken  |  1 with warnings  |  1 healthy   4.1s
```

No install, no config, no account, zero dependencies.

---

## What it catches

**Config problems** — the config file itself isn't valid JSON (every server in it is invisible until fixed, and no host tells you); arguments pasted into the `command` string; a `cwd` that doesn't exist; duplicate entries across hosts.

**The classic PATH trap** — `spawn npx ENOENT`. GUI-launched apps on macOS and Windows get a much shorter `PATH` than your terminal, so `npx`, `uvx` and `docker` work in your shell and fail inside the host. mcp-wtf resolves the command exactly the way the OS launcher will (including `PATHEXT` on Windows) and tells you what to paste instead.

**Placeholder credentials** — `YOUR_TOKEN_HERE`, `<your-key>`, `xxx`, `changeme`, `${input:...}`, or an empty `*_TOKEN`. Copied from a README, never replaced, and the server fails with an error the host never shows you.

**Startup crashes, decoded** — missing node modules (`Cannot find module`), packages that don't exist on npm or PyPI, ports already in use from a zombie session, rejected API keys, referenced paths that don't exist, unhandled exceptions. Each stderr signature maps to a plain-language diagnosis, and the raw stderr is quoted underneath.

**stdout pollution** — the server logs to stdout, which *is* the protocol channel on stdio transport. This is the answer to "it works sometimes and then randomly disconnects", and no client library will ever show it to you, because they all silently discard bytes they can't parse. mcp-wtf keeps them.

**Not-actually-MCP** — the command starts an HTTP server, or the wrong entrypoint, or something that waits forever on input. Diagnosed instead of hanging.

**Remote servers** — DNS that doesn't resolve, refused connections, expired certificates, `401 Unauthorized`, OAuth-protected resources, 404 paths, an SSE URL given to a streamable-HTTP client, redirects nobody follows, and web pages pretending to be endpoints. See below.

**What already went wrong** — the failures sitting in your host's log files, classified, with the line quoted. See below.

## Remote servers

```bash
npx mcp-wtf --url https://mcp.example.com/mcp
npx mcp-wtf --url https://mcp.example.com/mcp --header "Authorization: Bearer $TOKEN"
```

A remote server gives a client exactly one HTTP response and nothing else, so the host's *"failed to connect"* covers a dozen unrelated causes. mcp-wtf performs a real MCP `initialize` over the wire and reads the status line, the headers and the body:

```
  DEAD  https://mcp.example.com/sse  command line
        x The endpoint returned 405 Method Not Allowed to the handshake POST -- something
          is there, but it does not accept the POST that streamable HTTP is made of.
          fix: A GET to this same URL returns text/event-stream, so this is the older
               HTTP+SSE transport. Configure it as an SSE server ("type": "sse") rather
               than streamable HTTP, or ask the operator for the streamable-HTTP path.
          HTTP 405 Method Not Allowed  |  content-type: text/plain
```

It separates, by name: **DNS resolution failure**, **connection refused**, **connect timeout**, **`certificate has expired`**, self-signed and untrusted-issuer certificates, hostname mismatch, `https://` pointed at a plain-HTTP port, **`401 Unauthorized`** with and without credentials, **OAuth protected-resource metadata** (`/.well-known/oauth-protected-resource` — the client has to run the OAuth flow; no token pasted into a config will do), **403 Forbidden**, **404** (wrong path — try a `/mcp` or `/sse` suffix), **405/406** (right server, wrong transport kind), **3xx redirects** (reported with the `Location`, because most MCP clients do not follow them on the handshake POST), **429**, **5xx**, **HTML pages**, JSON that isn't JSON-RPC, and JSON-RPC that isn't MCP.

And when the endpoint is fine, it says so — with the server's name and version — because that is also an answer: the problem is on the client side.

Header values are never printed. A `--header` you pass, and a token a 401 body echoes back at you, are both redacted before anything is written out.

## Log-file mode

```bash
npx mcp-wtf --logs                       # find the host's logs and read them
npx mcp-wtf --logs ~/Library/Logs/Claude/mcp-server-github.log
```

Relaunching a server explains why it is broken *now*. It cannot explain why it dropped out at 4pm yesterday, and it cannot help when the failure only happens inside the host — a different `PATH`, a different working directory, a token the GUI has and your terminal does not. The host wrote all of that down and then never showed it to anyone.

mcp-wtf reads the last 200 lines of every MCP log it can find (`%APPDATA%\Claude\logs` on Windows, `~/Library/Logs/Claude` on macOS, `~/.config/Claude/logs` on Linux), runs the same signatures over them, attributes every line to the server it names — including the interleaved shared `mcp.log` — and folds rotated files back into one entry per server:

```
  mcp-wtf  2 of 8 servers failed in the logs -- here is what the host wrote down
  11 log files read

  DEAD  postgres  Claude Desktop log
        x The server is launched through Docker, and the Docker daemon was not running.
          fix: Start Docker Desktop before the host, or the server dies on every launch.
          > docker: error during connect: open //./pipe/dockerDesktopLinuxEngine: The
            system cannot find the file specified.

  DEAD  mermaid  Claude Desktop log
        x The host failed to parse what the server sent on stdout -- the server is
          printing non-JSON onto the protocol channel.
          fix: Logs belong on stderr. On stdio transport stdout IS the protocol.
          > [error] [mermaid] Unexpected token 'S', "STDIO MCP "... is not valid JSON
```

Repeated identical findings are collapsed, the mirrored JSON-RPC traffic is skipped (tool arguments are not evidence), and *"and then it disconnected"* is dropped as soon as something explains why. Quoted lines are redacted: anything token-shaped, anything after `Authorization:`, `api_key=` and friends.

## Usage

```bash
npx mcp-wtf                      # diagnose everything configured on this machine
npx mcp-wtf --server github      # just one server
npx mcp-wtf --config ./mcp.json  # one specific config file
npx mcp-wtf -- node build/index.js       # a server not configured anywhere yet
npx mcp-wtf --url http://localhost:3000/mcp
npx mcp-wtf --url https://mcp.example.com/mcp --header "Authorization: Bearer $TOKEN"
npx mcp-wtf --logs               # classify what already failed, from the host's logs
```

`--json` for scripts. Exit codes: `0` all healthy, `1` something is broken, `2` could not run.

## Where it looks

| Host | Config |
| --- | --- |
| Claude Desktop | `claude_desktop_config.json` |
| Claude Code | `~/.claude.json`, `./.mcp.json` |
| Cursor | `~/.cursor/mcp.json`, `./.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `mcp.json` (user and workspace) |
| Cline | `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Roo Code | `globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` |
| Gemini CLI | `~/.gemini/settings.json`, `./.gemini/settings.json` |
| Zed | `settings.json` (`context_servers`, including the `{path, args, env}` command form) |

All three OS layouts, and the JSONC these files are actually written in — comments and trailing commas are not a broken config, whatever `JSON.parse` thinks.

## The errors this explains

If you searched for one of these and landed here, that is the point:

`MCP server failed to connect` · `Server disconnected` · `MCP error -32000: Connection closed` ·
`Server transport closed unexpectedly, this is likely due to the process exiting early` ·
`spawn npx ENOENT` · `spawn uvx ENOENT` · `spawn docker ENOENT` ·
`Error: Cannot find module` · `ERR_MODULE_NOT_FOUND` · `ModuleNotFoundError: No module named` ·
`Unexpected token < in JSON at position 0` · `Unexpected token 'I', "[INFO]..." is not valid JSON` ·
`Unexpected non-whitespace character after JSON` ·
`401 Unauthorized MCP` · `403 Forbidden` · `WWW-Authenticate` · `oauth-protected-resource` ·
`405 Method Not Allowed` · `406 Not Acceptable` · `404 Not Found` ·
`fetch failed` · `ECONNREFUSED` · `ENOTFOUND` · `ETIMEDOUT` ·
`certificate has expired` · `self signed certificate in certificate chain` ·
`unable to verify the first certificate` · `ERR_TLS_CERT_ALTNAME_INVALID` ·
`EADDRINUSE: address already in use` ·
`docker: error during connect` · `Cannot connect to the Docker daemon` ·
`MCP error -32001: Request timed out` · `it works in my terminal but not in Claude`

## Safety

- mcp-wtf launches your servers exactly as configured, performs the MCP handshake, lists their tools, and shuts them down. **It never invokes a tool.**
- Env values from your configs are passed to the servers they belong to and are **never printed** — reports name the offending *key*, never the value. The same goes for `headers` on a remote server, in `--json` output too.
- Log lines and HTTP response bodies are quoted back at you **redacted**: values after `Authorization:` / `api_key=` / `*_TOKEN=`, and anything shaped like a token (`ghp_…`, `sk-…`, `xox…`, JWTs, long hex and base64 runs). A report is safe to paste into a bug report without reading it first.
- Nothing is uploaded anywhere. The only network traffic is to the MCP endpoints you asked it to check.

## See also

The rest of the toolchain, built on the same zero-dependency MCP client:

- [**context-xray**](https://github.com/Beeeeen/context-xray) — what your MCP servers *cost*: the context-window tokens they add to every request.
- [**mcp-probe**](https://github.com/Beeeeen/mcp-probe) — whether your MCP server *behaves*: conformance and robustness tests for CI.

mcp-wtf answers "why won't it connect", context-xray answers "what is it costing me", mcp-probe answers "will it break my users".

## License

MIT
