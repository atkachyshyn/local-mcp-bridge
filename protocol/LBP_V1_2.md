# LBP 1.2 — Local Bridge Protocol envelope

LBP is a small browser-chat transport convention for delegating local MCP work to a policy-controlled loopback bridge and returning the result in a later user turn.

LBP is **not** a replacement for MCP. MCP remains the protocol between the local bridge and the configured local tool servers.

## Critical semantic constraint

LBP is **turn-chained**, not synchronous same-run tool calling:

```text
assistant LBP task
-> local bridge / MCP execution
-> user LBP result
-> next assistant turn
```

Browser auto-continuation may submit the result turn automatically, but it cannot inject a local result into an assistant generation already in progress.

## v1.2 execution model: observation groups + exclusive mutations

LBP 1.2 keeps one top-level `operation` per task, but adds a constrained multi-call observation operation:

- `read_only` and locally authorized `verify` calls may be grouped in `mcp.observe`;
- `write` and `destructive` calls are **never** allowed inside an observation group;
- writes/destructive calls remain individual `mcp.call` operations;
- the daemon applies a per-server read/write barrier:
  - READ + VERIFY use the observation/shared side;
  - WRITE + DESTRUCTIVE use the exclusive side.

A normal development chain can therefore be:

```text
OBSERVE [read source, search tests, cargo test]
-> WRITE [apply_patch]
-> OBSERVE [read diff, cargo test, cargo clippy]
-> WRITE [next mutation]
```

“One write” means **one exclusive mutation at a time**, not one mutation for the whole user request.

In v0.9, calls inside a single `mcp.observe` are executed sequentially while holding the observation side of the barrier. The batching benefit is fewer browser/model round trips; it does not promise parallel MCP execution.

## Task envelope

```text
<LBP_TASK>
{
  "protocol": "lbp",
  "version": "1.2",
  "id": "inspect-planner-001",
  "title": "Inspect and verify planner behavior",
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

Required task fields:

- `protocol`: `"lbp"`
- `version`: `"1.2"`
- `id`: non-empty opaque idempotency key
- `operation`: exactly one top-level operation

Optional presentation fields:

- `title`
- `description`
- `action_label`

## Operation types

### `mcp.call`

One MCP tool call. Its effective classification is derived by the daemon.

```json
{
  "type": "mcp.call",
  "server": "workspace",
  "tool": "apply_patch",
  "arguments": {}
}
```

A `mcp.call` may be READ, VERIFY, WRITE or DESTRUCTIVE after daemon preflight.

### `mcp.list_tools`

```json
{
  "type": "mcp.list_tools",
  "server": "workspace"
}
```

This is READ ONLY.

### `mcp.observe`

A bounded group of independent observation calls to **one server**.

```json
{
  "type": "mcp.observe",
  "server": "workspace",
  "calls": [
    {"id": "a", "tool": "read_file", "arguments": {}},
    {"id": "b", "tool": "run_command", "arguments": {"command": "cargo test", "cwd": "/absolute/repo"}}
  ]
}
```

Rules:

- 1–8 calls;
- every call has a unique local `id` for result correlation;
- all calls target the operation's one MCP server;
- the daemon preflights **all** calls before dispatching any;
- every call must classify as `read_only` or `verify`;
- if any call is WRITE, DESTRUCTIVE, unknown, disallowed, outside roots, or otherwise fails policy, the entire group is rejected before tool dispatch;
- no dependencies, result references, variables, conditionals, `required`, retries, rollback language or DAG semantics;
- individual execution errors do not require rollback because the group has no mutation authority. Remaining independent calls may still execute and each receives its own status.

## Daemon-derived classifications

### READ ONLY

Derived from current MCP tool annotations such as `readOnlyHint=true`.

### VERIFY

VERIFY is **not model-authored** and is not synonymous with OS-level read-only behavior.

It exists for commands whose purpose is validation/observation, such as:

- `cargo test`
- `cargo check`
- `cargo clippy`
- `cargo fmt --check`

A base WRITE-classified MCP tool can become VERIFY only when local daemon policy explicitly enables verification and its arguments match a configured verification rule. In v0.9 the rule is argv-prefix based, requires an absolute configured working-directory argument (`cwd` by default) under an allowed root, and checks explicit path-like argv tokens against the same roots. Shell control/substitution/redirection characters fail closed rather than being interpreted as a verification-policy language.

Example local policy concept:

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

The model cannot send `"classification":"verify"` to grant itself this authority.

### WRITE

A non-read-only, non-destructive tool that does not match a local VERIFY rule.

### DESTRUCTIVE

Derived from the current MCP tool catalog/annotations and always subject to destructive policy.

## VERIFY is execution, not a sandbox

`cargo test` is useful because the assistant cares about its exit status/output, but running it can still:

- create `target/` and caches;
- run build scripts and test code;
- spawn processes;
- perform network access if the local environment permits it;
- touch resources beyond what a pure read operation would touch.

Therefore VERIFY is a separate class, not READ ONLY. Enabling VERIFY is an explicit local trust decision. The bridge does not claim OS sandboxing or process-side-effect containment.

## Approval behavior

Approval remains daemon/browser policy, not LBP text.

- `all`: approve every top-level operation, including an entire observation group;
- `session`: a lease covers the highest risk classification approved for that server/session;
- `mutations`: READ + VERIFY auto-run; WRITE + DESTRUCTIVE require mutation approval, subject to the destructive-always gate;
- `none`: no ordinary approval prompts; daemon policy remains authoritative; destructive-always may still force approval.

For `mcp.observe`, the group's classification is the highest class among its calls (`verify` if any VERIFY call is present, otherwise `read_only`).

## Result envelope

```text
<LBP_RESULT>
{
  "protocol": "lbp",
  "version": "1.2",
  "bridge_version": "0.9.0",
  "task_id": "inspect-planner-001",
  "status": "ok",
  "operation": {
    "type": "mcp.observe",
    "server": "workspace",
    "classification": "verify",
    "calls": [
      {"id": "source", "status": "ok", "classification": "read_only", "result": {}},
      {"id": "tests", "status": "ok", "classification": "verify", "result": {}}
    ]
  },
  "applied_mutations": []
}
</LBP_RESULT>
```

Top-level status remains intentionally small:

- `ok` — execution completed with normal results;
- `error` — execution failed without an ambiguous authoritative write state;
- `unknown` — the bridge cannot prove whether a WRITE/DESTRUCTIVE call landed; clients must not blindly retry.

`mcp.observe` does not use `unknown` for verification-command transport failures because VERIFY has no authoritative project-mutation status in LBP. Per-call statuses show which observation failed. The group top-level status is `error` when any item fails.

## What task text cannot authorize

Task text cannot authoritatively carry:

- `classification`, `mutating` or `required`;
- approval decisions or leases;
- trusted/session status;
- allowed roots/tools;
- verification rules;
- write/destructive authority;
- browser auto-continue mode;
- local credentials.

These remain local daemon/browser policy.

## Browser auto-continuation is out of protocol

Manual vs automatic result submission is a browser adapter setting, not an LBP field. The adapter must continue to fail closed on task/result mismatch, non-empty user drafts, provider streaming, composer changes, missing send controls, round-trip limits, and ambiguous write results.

## Legacy compatibility

v0.9 accepts LBP 1.1 single-operation tasks for migration and normalizes them to canonical LBP 1.2. Legacy `operations[]` is accepted only when it contains exactly one operation. The old unrestricted multi-operation workflow array is **not** restored.
