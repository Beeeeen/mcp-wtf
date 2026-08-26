# mcp-wtf

**Your MCP server won't connect. Find out why in 10 seconds.**

[![CI](https://github.com/Beeeeen/mcp-wtf/actions/workflows/ci.yml/badge.svg)](https://github.com/Beeeeen/mcp-wtf/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-wtf.svg)](https://www.npmjs.com/package/mcp-wtf)
[![license](https://img.shields.io/npm/l/mcp-wtf.svg)](./LICENSE)

```bash
npx mcp-wtf
```

The host says *"MCP server failed to connect"*, or *"disconnected"*, or nothing at all — the server just isn't there. There are **17,000 GitHub issues** with that exact complaint, because the host throws away the one thing that would explain it: the server's dying words.

mcp-wtf finds every MCP server configured in Claude Desktop, Claude Code, Cursor, Windsurf and VS Code, actually launches each one the way the host would, keeps everything the host discards, and tells you exactly what is wrong — with the fix:

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

## Usage

```bash
npx mcp-wtf                      # diagnose everything configured on this machine
npx mcp-wtf --server github      # just one server
npx mcp-wtf --config ./mcp.json  # one specific config file
npx mcp-wtf -- node build/index.js       # a server not configured anywhere yet
npx mcp-wtf --url http://localhost:3000/mcp
```

`--json` for scripts. Exit codes: `0` all healthy, `1` something is broken, `2` could not run.

## Safety

- mcp-wtf launches your servers exactly as configured, performs the MCP handshake, lists their tools, and shuts them down. **It never invokes a tool.**
- Env values from your configs are passed to the servers they belong to and are **never printed** — reports name the offending *key*, never the value.

## See also

The rest of the toolchain, built on the same zero-dependency MCP client:

- [**context-xray**](https://github.com/Beeeeen/context-xray) — what your MCP servers *cost*: the context-window tokens they add to every request.
- [**mcp-probe**](https://github.com/Beeeeen/mcp-probe) — whether your MCP server *behaves*: conformance and robustness tests for CI.

mcp-wtf answers "why won't it connect", context-xray answers "what is it costing me", mcp-probe answers "will it break my users".

## License

MIT
