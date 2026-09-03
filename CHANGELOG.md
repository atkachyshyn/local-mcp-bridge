# Changelog

## 0.9.1 — 2026-09-02

Focused live-self-hosting compatibility and UX release; LBP remains **1.2**.

- Adds `allowed_tools: ["*"]` as live-catalog eligibility only.
- Allows a narrow daemon-owned VERIFY rule to reclassify a generic command tool from base WRITE or DESTRUCTIVE to VERIFY.
- Hardens task/result parsing around line-isolated envelope markers and fenced-code-block transport.
- Fixes hidden payloads accidentally becoming an execution gate.
- Fixes per-prompt round-trip accounting and reconstructs progress from real LBP result turns.
- Replaces duplicate task/status surfaces with one configurable surface: right-side panel, inline, or off.
- Adds sequential current-chain task status to the right-side panel.
- Hides raw protocol payloads by default; technical payload visibility is explicit.
- Simplifies approval UI by keeping raw MCP arguments behind a Technical details disclosure.
- Adds a Prime chat action for inserting the LBP usage bootstrap as a real user turn.
- Updates daemon/extension version to 0.9.1 and expands regression coverage.

## 0.9.0 — 2026-09-02

v0.9 evolves the v0.8 security-corrected bridge without restoring the old unrestricted `operations[]` workflow language.

## Protocol: LBP 1.2

- Keeps exactly one top-level LBP operation per assistant task/message.
- Adds `mcp.observe`, a bounded same-server group of 1–8 independent MCP calls.
- Every `mcp.observe` call has a unique local `id` for result correlation.
- `mcp.observe` accepts only daemon-classified `read_only` or `verify` calls.
- The daemon preflights the whole group before dispatch; a write/destructive/disallowed/path-invalid member rejects the group before any member executes.
- No dependencies, result references, variables, conditions, retries, `required`, rollback semantics, or DAG/workflow behavior are introduced.
- LBP 1.1 and legacy `operations[]` are migration-only compatibility paths. `operations[]` must contain exactly one operation.

## Execution model: observation vs exclusive mutation

- Adds a writer-preferring per-MCP-server RW execution barrier.
- `read_only` and `verify` operations run on the shared observation side.
- `write` and `destructive` operations run exclusively.
- An entire `mcp.observe` group holds the observation side for its duration so a bridge-managed write cannot interleave between its reads/verifications.
- v0.9 executes calls inside one observation group sequentially. The RW barrier is a consistency/authority barrier, not a promise of parallel MCP transport execution.

## VERIFY classification

- Adds the daemon-derived `verify` class between `read_only` and `write`.
- Intended for locally approved validation commands such as `cargo test`, `cargo check`, `cargo clippy`, and `cargo fmt --check`.
- VERIFY is deny-by-default: `allow_verify=false` unless the user enables it.
- The model cannot declare VERIFY. Only local daemon `verification_rules` may downgrade a base WRITE-classified MCP tool to VERIFY.
- Rules match a configured MCP tool/argument plus explicit argv prefixes.
- Shell control/substitution/redirection characters fail closed for string commands.
- VERIFY requires an absolute configured `cwd` under an allowed root.
- Explicit path-like argv values are also checked against allowed roots.
- VERIFY is deliberately **not a sandbox**. Test/build code may create artifacts, spawn processes, access networks, or otherwise have side effects permitted by the underlying MCP server/process environment.

## Approval behavior

- Default `mutations` mode now auto-runs READ and VERIFY.
- WRITE and DESTRUCTIVE remain individually approval-gated in `mutations` mode.
- `always_approve_destructive=true` remains the default and overrides permissive modes for destructive operations.
- `all`, `session`, and `none` modes remain available.
- Session risk ordering is now `read_only < verify < write < destructive`.
- Approval tokens remain bound to normalized task content, browser session, policy fingerprint, and daemon-derived classification.

## Browser UX

- Adds a persistent bottom-right LBP status chip/panel independent of task-local cards.
- Shows daemon connected/offline, checking, running, approval-required, continuing, paused, error, current operation/group, and auto-chain round count.
- Provides Stop chain and Settings controls.
- A low-frequency health check runs only as browser UI health reporting; it does not execute MCP work or turn LBP into background task polling.
- The status UI adds no model authority and cannot bypass daemon policy/approval.

## Configuration

New per-server fields:

```json
{
  "allow_verify": false,
  "verification_rules": []
}
```

Example opt-in:

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

Existing registries are migrated by adding these fields with deny-by-default values.

## Regression coverage added

- READ + VERIFY observation group succeeds without mutation approval in `mutations` mode.
- VERIFY can execute while general `write=false`.
- Forged model-authored `classification:"verify"` is rejected.
- Shell-control VERIFY escape attempts fall back to WRITE and are denied when writes are disabled.
- Missing/relative/out-of-root VERIFY working directories fail closed.
- Explicit out-of-root command-line paths fail root policy.
- Any WRITE in `mcp.observe` rejects the entire group before dispatch, including when general write permission is enabled.
- Concurrent observation/write smoke test verifies an exclusive write does not interleave inside an observation group.
- Legacy one-element `operations[]` remains accepted; multi-element legacy arrays remain rejected.

## Intentionally deferred

- Parallel dispatch within `mcp.observe`.
- Cross-server observation groups.
- Streaming per-item observation progress to the browser status chip.
- A process/container sandbox for VERIFY.
- Arbitrary workflow/dependency semantics.
