# Local MCP Bridge

Local MCP Bridge connects a browser-based AI chat to explicitly configured **local MCP servers** through an authenticated loopback daemon and a browser extension.

It is designed for development workflows where the browser model remains the reasoning surface while local tools stay behind local, deny-by-default policy.

> **Status: experimental v0.9.1.** The implementation has regression coverage and security hardening, but v0.9 has not yet completed an independent security review. Do not treat it as a security sandbox. Review the policy model before enabling write, destructive, or VERIFY authority.

## What problem it solves

Browser-chat MCP connector lifecycles can be unavailable or unreliable for local development servers. Local MCP Bridge keeps MCP as the local tool protocol, but moves the browser-to-local hop into a small local transport:

```text
Browser chat
   |
   | LBP task/result envelopes
   v
Browser extension / provider adapter
   |
   | authenticated loopback HTTP
   v
Local MCP Bridge daemon
   |
   | policy-controlled MCP Streamable HTTP
   v
Configured local MCP servers
```

The bridge does **not** provide native same-generation tool execution. Local results return as the next user turn. Auto-continue can submit those turns automatically, but they remain real conversation turns.

## v0.9.1 corrections

v0.9.1 keeps LBP 1.2 and the v0.9 execution model, but fixes policy and browser UX issues found during live self-hosting:

- `allowed_tools: ["*"]` means any tool currently present in the live MCP `tools/list` catalog; every other policy gate still applies.
- A narrowly matched daemon-owned VERIFY rule may reclassify a generic command tool that its MCP server conservatively marks WRITE **or DESTRUCTIVE**.
- LBP envelope parsing requires line-isolated markers and is designed for fenced `text` code blocks.
- Hidden protocol payloads never gate task discovery or execution.
- Round-trip counting anchors to the latest genuine user prompt and self-heals from actual LBP result turns.
- Task status has exactly one selected surface: right-side panel, inline in chat, or off.
- Raw LBP task/result JSON is hidden by default and is available only as technical/debug information.
- The right-side panel shows sequential task history/status for the current chain.
- Approval dialogs show a human summary first; raw arguments are collapsed under **Technical details**.
- The panel includes **Prime chat**, which inserts a real user-turn bootstrap explaining LBP 1.2. Browser extensions cannot secretly modify ChatGPT's hidden system context, so a real conversation turn is the reliable bootstrap mechanism.

## v0.9 execution model

v0.9 uses an RW-mutex-like model:

```text
OBSERVE [READ / VERIFY / READ]
            |
            v
       exclusive barrier
            |
WRITE or DESTRUCTIVE
            |
            v
OBSERVE [READ / VERIFY]
```

### `mcp.observe`

A bounded observation group may contain 1–8 independent calls to one MCP server.

- every call is preflighted before any call is dispatched;
- every call must derive as `read_only` or locally authorized `verify`;
- if any member is WRITE, DESTRUCTIVE, disallowed, or outside policy, the entire group is rejected before dispatch;
- calls execute sequentially in v0.9 while the group holds the shared observation side of the server barrier;
- there are no dependencies, result references, variables, conditions, retries, rollback semantics, or workflow DAG behavior.

### `mcp.call`

WRITE and DESTRUCTIVE operations remain individual calls. They take the exclusive side of the per-server barrier and retain approval, journal, replay, and ambiguous-write protections.

The old unrestricted multi-operation `operations[]` workflow is **not** restored. A legacy one-element array is accepted only for migration.

## VERIFY is not READ

Commands such as `cargo test`, `cargo check`, linters, and build verification are useful observation steps, but they can still create artifacts, execute build scripts/tests, spawn processes, or access the network.

v0.9 therefore uses a separate risk class:

```text
READ < VERIFY < WRITE < DESTRUCTIVE
```

VERIFY authority is owned by local daemon policy. The model cannot declare an operation VERIFY.

A WRITE-classified MCP command tool becomes VERIFY only when all configured conditions match, including:

- `allow_verify: true`;
- the MCP tool is locally allowed;
- a daemon-owned verification rule matches the command argv prefix;
- the call provides an absolute working directory inside an allowed root;
- explicit path-like argv values remain inside allowed roots;
- shell control/substitution/redirection characters fail closed for VERIFY matching.

Example policy rule:

```json
{
  "allow_verify": true,
  "verification_rules": [
    {
      "tool": "run_command",
      "argument": "command",
      "cwd_argument": "cwd",
      "argv_prefixes": [
        ["cargo", "test"],
        ["cargo", "check"],
        ["cargo", "clippy"],
        ["cargo", "fmt", "--check"]
      ]
    }
  ]
}
```

This is **policy-controlled execution, not sandboxing**. Only enable VERIFY commands and repositories you trust locally.

## Approval modes

Approval is local browser/daemon policy, never model-authored.

| Mode | READ | VERIFY | WRITE | DESTRUCTIVE |
|---|---:|---:|---:|---:|
| `all` | approve | approve | approve | approve |
| `session` | lease by risk | lease by risk | lease by risk | lease by risk* |
| `mutations` | automatic | automatic | approve | approve |
| `none` | automatic | automatic | automatic if policy permits | automatic if policy permits* |

`always_approve_destructive` defaults to `true` and can force destructive approval regardless of the ordinary mode.

The recommended development default is `mutations`.

## Browser status and continuation

The extension injects a persistent status chip on supported ChatGPT pages. It can show:

```text
LBP ● Connected · v0.9.1
LBP ◌ Checking · workspace → observe ×3
LBP ◌ Running · workspace → run_command
LBP ⚠ Approval required · workspace → apply_patch
LBP ● Continuing · 3/12
LBP ⏸ Paused · user draft detected
LBP ✕ Daemon offline
```

The expanded panel exposes current detail, Manual/Auto mode, chain progress, **Stop chain**, and **Settings**. The chip is browser UX only; it grants no tool authority.

Auto-continue stops or pauses when the extension cannot prove a safe provider state, including a non-empty user draft, provider streaming, task/result mismatch, composer changes, missing Send controls, round-trip limits, or ambiguous mutation results.

## Security boundaries

The cloud model may propose:

- server id;
- tool name;
- arguments;
- human-readable intent;
- a bounded `mcp.observe` group.

It cannot grant itself authority.

Before dispatch, the daemon independently checks:

1. configured and enabled loopback MCP server;
2. current MCP `tools/list` membership;
3. daemon-owned `allowed_tools`;
4. base classification from MCP annotations;
5. optional daemon-owned VERIFY rule match;
6. write/destructive policy;
7. configured root containment;
8. READ/VERIFY-only constraints for observation groups;
9. approval mode and valid approval/session authorization when required.

The bridge has no bridge-native filesystem or shell executor. Tool execution is delegated only to explicitly configured local MCP servers.

The MCP server remains responsible for its own filesystem restrictions, command behavior, atomicity, hash guards, semantic validation, and other domain-specific safety checks.

See [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before enabling mutation authority.

## Requirements

- Python 3.11+ recommended;
- Chromium-based browser supporting Manifest V3 unpacked extensions;
- Node.js only for the browser smoke test;
- one or more local MCP Streamable HTTP servers bound to loopback.

The daemon uses only the Python standard library.

## Install

Clone the repository, then run:

```bash
./install.sh
./start.sh
```

`install.sh`:

- creates `~/.local-mcp-bridge` with `0700` permissions;
- creates/reuses a bearer token with `0600` permissions;
- creates a deny-by-default server registry when none exists;
- generates the ignored `extension/config.js` containing the local loopback token;
- migrates existing state from `~/.local-mcp-bridge-poc` or the older `~/.atlas-arms-poc` when present.

Then:

1. open `chrome://extensions`;
2. enable **Developer mode**;
3. choose **Load unpacked** and select this repository's `extension/` directory;
4. open the extension Settings page;
5. test/discover your local MCP server;
6. configure allowed roots and tools;
7. enable write, destructive, or VERIFY authority only when you intend to.

Fresh installs include only a generic `workspace` loopback server entry and grant it no tools, roots, WRITE, DESTRUCTIVE, or VERIFY authority.

## Example server policy

See [`examples/servers.example.json`](examples/servers.example.json).

A development configuration commonly allows read tools for the repository root, optionally allows a command tool with narrow VERIFY rules, enables writes only when needed, uses `approval_mode: "mutations"`, and leaves destructive operations behind explicit approval.

## LBP 1.2 example

```text
<LBP_TASK>
{
  "protocol": "lbp",
  "version": "1.2",
  "id": "inspect-001",
  "title": "Inspect planner and run focused tests",
  "operation": {
    "type": "mcp.observe",
    "server": "workspace",
    "calls": [
      {
        "id": "source",
        "tool": "read_file",
        "arguments": {"path": "/absolute/repo/src/planner.rs"}
      },
      {
        "id": "tests",
        "tool": "run_command",
        "arguments": {
          "command": "cargo test planner",
          "cwd": "/absolute/repo"
        }
      }
    ]
  }
}
</LBP_TASK>
```

Protocol details: [`protocol/LBP_V1_2.md`](protocol/LBP_V1_2.md).

## Validation

Run the full local validation set:

```bash
python3 smoke_test.py
node browser_smoke_test.js
python3 -m py_compile daemon.py smoke_test.py
node --check extension/protocol.js
node --check extension/adapters/chatgpt.js
node --check extension/content.js
node --check extension/background.js
node --check extension/options.js
sh -n install.sh start.sh
python3 -m json.tool extension/manifest.json >/dev/null
```

CI runs the same core checks on every push and pull request.

## Repository layout

```text
.
├── daemon.py
├── install.sh
├── start.sh
├── smoke_test.py
├── browser_smoke_test.js
├── extension/
├── protocol/
│   ├── LBP_V1_2.md
│   └── LBP_V1_1.md
├── docs/
│   ├── ARCHITECTURE.md
│   └── reviews/
├── examples/
├── SECURITY.md
├── CONTRIBUTING.md
├── CHANGELOG.md
└── LICENSE
```

Historical review prompts and dispositions are retained under [`docs/reviews/`](docs/reviews/) so the security/design evolution remains inspectable. The v0.9 independent review prompt is included there; the review itself is still pending.

## Scope intentionally excluded

v0.9 does not provide workflow DAGs, a bridge-native shell/filesystem executor, stdio MCP spawning, non-loopback MCP servers, remote/cross-device bridging, daemon-initiated task polling, model-created policy, credential delegation, automatic retries of ambiguous mutations, provider-private backend calls, or synchronous same-run browser tool execution.

## License

Apache License 2.0. See [LICENSE](LICENSE).
