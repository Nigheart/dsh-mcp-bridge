![dsh-mcp-bridge](assets/banner.gif)

# dsh-mcp-bridge

[English](README.md) | [简体中文](README.zh.md)

Expose a running [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) instance over the
[Model Context Protocol](https://modelcontextprotocol.io), so an external agent — Codex, or any MCP client —
can drive that instance's own sessions.

A DSH session behaves like a subagent from the caller's point of view: it keeps its own context across calls,
works in the workspace you name, and returns a final answer. The bridge also lets the caller answer the
questions that DSH agent asks, so a delegated task never deadlocks waiting for a human who is not there.

## Why

Driving a DSH instance through its web GUI from another agent costs a screenshot or DOM round trip per step.
This bridge replaces that with a small structured API: one tool call in, one result out.

## Architecture

```
MCP client (stdio)
 └── bin/dsh-mcp.mjs          MCP server; polls the bridge, holds questions for the caller
      └── HTTP 127.0.0.1:<port>/dsh-bridge
           └── lib/index.js    host Cordis plugin mounted inside the running DSH process
                └── ctx.sessionController → DSH agent
```

Two halves, and the split matters:

- **`lib/index.js`** is a DSH host plugin. It runs in the same process as the Web GUI, so it can read and
  write the sessions that instance already has. It registers an HTTP route and does the DSH work.
- **`bin/dsh-mcp.mjs`** is a standalone MCP server that speaks stdio to your agent and HTTP to the plugin.
  It exists because DSH's own process owns stdout, so the plugin cannot serve stdio itself.

Waiting and polling happen in the MCP server, where they cost nothing; your model spends one tool call and
receives the finished result.

## Requirements

- DSH with a Web profile (`dsh web` or the desktop app).
- Node.js 18 or newer on the same machine as DSH.
- An MCP client that can spawn a stdio server.

## Install the plugin

Install straight from this repository — the package is not published to npm:

```bash
dsh plugin --profile web add github:Nigheart/dsh-mcp-bridge
```

Then restart DSH. On startup the log should show:

```
[dsh-mcp-bridge] mounted /dsh-bridge (tokenRequired=false)
```

Verify it independently:

```bash
curl -s http://127.0.0.1:3080/dsh-bridge/ping
# {"ok":true,"data":{"bridge":"dsh-mcp-bridge","version":"0.3.0","tokenRequired":false}}
```

If your instance listens on a port other than 3080, use that port here and set `DSH_BRIDGE_URL` for the MCP
server (below).

### Manual install

If you prefer to wire it up by hand, add the package to the profile's `package.json` and list it as a bundle:

```json
{
  "dependencies": { "dsh-mcp-bridge": "github:Nigheart/dsh-mcp-bridge" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-mcp-bridge"] } }
}
```

The package ships its own `cordis.patch.yml`, which inserts one loader row. That row declares
`inject: [webServer, sessionController]` — keep it. Without `inject` the plugin can be activated before those
services exist, find nothing to bind to, and mount no route at all.

## Configure your MCP client

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.dsh]
command = "node"
args = ["/absolute/path/to/dsh-mcp-bridge/bin/dsh-mcp.mjs"]
startup_timeout_sec = 60

# Only needed when DSH is not on the default port, or when a token is set.
[mcp_servers.dsh.env]
DSH_BRIDGE_URL = "http://127.0.0.1:8080/dsh-bridge"
```

The server sends its own usage notes in the MCP handshake (`initialize.instructions`), so the client learns
the workflow without any extra prompting.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `DSH_BRIDGE_URL` | `http://127.0.0.1:3080/dsh-bridge` | Where the plugin listens. |
| `DSH_BRIDGE_TOKEN` | *(unset)* | Sent as `x-dsh-bridge-token`; must match the plugin's value. |
| `DSH_BRIDGE_TIMEOUT_MS` | `600000` | Default wait for one delegated turn. |
| `DSH_BRIDGE_POLL_MS` | `2000` | Progress poll interval. |

## Tools

| Tool | Purpose |
|---|---|
| `dsh_list_sessions` | List sessions of the running instance, optionally filtered to one workspace. |
| `dsh_delegate` | Create a session in a workspace, or continue one by `sessionId`, send an instruction, and wait for that turn to finish. |
| `dsh_answer` | Answer a question the DSH agent asked, so it can resume. |
| `dsh_approval` | Choose how a session resolves **future** approval requests: `gui`, `auto-approve`, or `deny`. |
| `dsh_cancel` | Cancel the active turn — the way out of an approval nobody can answer. |
| `dsh_poll` | Read a session's status and latest output; use after a wait that returned `waiting` or `timeout`. |

### Delegating work

```
dsh_delegate({ workspace: "/home/me/project", instruction: "Add the missing tests for parser.js" })
```

Omit `sessionId` to start a new DSH agent; pass the returned `sessionId` back to continue the **same** agent,
which still remembers the earlier work. `status` tells you what happened:

| `status` | Meaning |
|---|---|
| `completed` | The turn finished; `output` holds the agent's final answer. |
| `waiting` | Blocked on a human: either a question takeover is holding for you, or an open approval request. |
| `timeout` | Still running; call `dsh_poll` with the same `baselineSeq`. |

### Answering questions

By default a delegated session runs under **takeover**: when the DSH agent calls its question tool, the call is
suspended and handed to the caller instead of the GUI. `dsh_delegate` then returns immediately with the
question rather than waiting:

```json
{
  "status": "waiting",
  "waiting": {
    "kind": "user-question",
    "toolName": "ask_user_question",
    "intercepted": true,
    "detail": [{ "id": "choice", "question": "Which database?", "options": ["sqlite", "postgres"] }]
  }
}
```

Answer it with the ids from `detail`:

```
dsh_answer({ sessionId, answers: [{ id: "choice", selected: ["sqlite"] }] })
```

If nobody answers within about three minutes, the question falls back to the DSH GUI, so an unattended
delegation cannot hang forever. Pass `takeover: false` to `dsh_delegate` to leave questions with the GUI from
the start.

### Approvals

Some operations need a decision before DSH will run them — for example escalating a sandbox so a tool can write
outside the session workspace. The session then reports:

```json
{
  "status": "waiting",
  "waiting": {
    "kind": "approval",
    "detail": [{
      "id": "d0f853e3-...",
      "toolName": "pwsh",
      "callId": "call_00_...",
      "reason": "escalate sandbox to danger-full-access: ... outside the session workspace"
    }]
  }
}
```

`reason` is DSH's own explanation of what it wants and why, so the caller can judge whether granting it is
appropriate.

**An approval that is already pending has only two exits**: a person answers it in the DSH Web GUI, or the turn
is abandoned with `dsh_cancel`. Nothing below can rescue the request that is already open.

`dsh_approval({ sessionId, mode })` decides how **future** approvals in that session are handled. The policy
takes effect at the agent's next step, so it never applies retroactively:

- `"gui"` (the default) — leave them to the DSH Web GUI for a person to answer.
- `"deny"` — set the session's policy to `never`: every subsequent request resolves as rejected without
  prompting. For unattended work this beats waiting forever — a clean failure instead of a hang.
- `"auto-approve"` — this plugin answers the request itself with a one-shot grant. Whether that is even possible
  is deployment-dependent: the plugin has to sit **upstream** of the GUI's answerer. Registering the mode is
  therefore **not** proof that it works — check the bridge's `/dsh-bridge/diagnostics`
  (`approvalListener.listenerHits`); the endpoint reports `effective: false` with a warning when it cannot. On
  the deployment this was built against, `listenerHits` is 0, so only `deny` and `gui` take effect there.

A tool call that has simply not finished yet is **not** reported as `waiting`; such a session stays `running`
and carries an informational `pendingTool` field.

## Security

The bridge is a control surface: whoever can reach it can send instructions to, and read the history of, every
session in that DSH instance.

- It **serves loopback callers only** and answers `403` to anything else. This matters because the shipped Web
  profile binds `0.0.0.0`.
- Set `DSH_BRIDGE_TOKEN` on both sides to additionally require an `x-dsh-bridge-token` header.
- The route is registered directly on DSH's HTTP server, so it is **not** covered by the `/api` trusted-host
  fence. Its own checks above are the only gate.

## Limitations

- The MCP server and DSH must run on the same machine, because the bridge is loopback-only.
- One delegated turn is bounded by `DSH_BRIDGE_TIMEOUT_MS`; there is no streaming of partial output.
- `cancel` stops the active turn only — messages already queued in DSH keep running.
- The plugin reads a session's tail through `sessionController.page`, so a very large session reports its
  recent history rather than all of it.

## Development

The plugin can be developed without restarting DSH: load it as a dynamic Cordis plugin first, verify behaviour
against the live services, then install it as a bundle package. Do finish with one real restart — dynamic
plugins are activated only after the services they need already exist, so they cannot catch a startup-order
bug such as a missing `inject`.

## License

MIT
