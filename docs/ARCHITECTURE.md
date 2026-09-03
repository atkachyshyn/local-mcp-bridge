# Local MCP Bridge v0.9 architecture

## Purpose

Use an ordinary browser-chat conversation as a cloud reasoning surface while local execution remains standard MCP and locally governed.

```text
assistant output
    |
    | LBP 1.2 task
    v
provider adapter
    |
    | bearer-authenticated loopback HTTP
    v
Local MCP Bridge daemon
    |-- registry + security / VERIFY policy
    |-- per-server RW execution barrier
    |-- approval policy / ephemeral leases
    |-- task journal
    `-- MCP Streamable HTTP client
              |
              +-- filesystem/workspace MCP
              +-- domain-specific MCP
              `-- other configured loopback MCP

MCP result
    |
    | LBP result
    v
provider adapter
    |
    +-- manual: composer only
    `-- auto-continue: composer + normal provider Send
              |
              v
          next user turn
```

## The key provider boundary: turn chaining, not in-flight injection

The browser extension is not inside the provider's native model execution loop. It cannot pause an assistant generation, inject a local tool result into that same run, and resume it as a native tool call would.

Instead:

```text
human user turn
assistant turn containing one LBP task
bridge executes the locally authorized operation
bridge-generated user turn containing one LBP result
assistant continues reasoning
...
```

Auto-continue only automates those bridge-generated result turns. Collapsing protocol payloads does not make them disappear from context.

## v0.9 operation model

v0.8 intentionally used exactly one MCP call per LBP task. That was strong for mutation clarity but inefficient for source inspection and verification because every independent read consumed another model/browser round trip.

v0.9 keeps the safety property for mutations while adding one constrained batching primitive.

### `mcp.observe`

A top-level `mcp.observe` contains 1–8 independent calls to one server.

Before any call is dispatched, the daemon preflights the complete group. Every item must derive to one of:

- `read_only`
- `verify`

If any item derives to WRITE or DESTRUCTIVE, or fails tool/root/policy checks, the **whole group is rejected before dispatch**.

No item can depend on a prior result. The protocol has no variables, conditions, retries, `required`, rollback or DAG semantics.

In v0.9, calls inside a group execute sequentially. The efficiency win is the single assistant/result round trip, not promised parallel MCP transport.

### `mcp.call`

WRITE and DESTRUCTIVE work remains an individual `mcp.call`, with independent approval, idempotency journal and ambiguous-write handling.

### Per-server RW barrier

The daemon maintains a writer-preferring read/write barrier per configured MCP server:

```text
shared side:    READ + VERIFY
exclusive side: WRITE + DESTRUCTIVE
```

An entire `mcp.observe` group holds the shared/observation side while it runs, preventing an exclusive mutation from interleaving between source inspection and verification items in that group.

This is a policy/state barrier. The underlying MCP client may serialize transport requests internally; v0.9 does not promise read-call parallelism.

## Classification and trust boundary

The model proposes intent. It does not classify its own authority.

The model cannot set:

- `classification`;
- `mutating` / `required`;
- allowed tools or roots;
- VERIFY rules;
- write/destructive authority;
- approval mode;
- session lease or approval token;
- browser auto-continue mode or round-trip cap.

### READ ONLY

Derived from current MCP tool annotations (`readOnlyHint=true`).

### VERIFY

VERIFY is a local daemon policy override for a base WRITE-classified tool whose concrete arguments match an explicitly configured verification rule.

Example intended use:

```text
run_command("cargo test ...")
run_command("cargo check ...")
run_command("cargo clippy ...")
run_command("cargo fmt --check ...")
```

A verification rule identifies:

- MCP tool name;
- command argument name;
- working-directory argument name (`cwd` by default);
- allowed argv prefixes.

The call must provide an absolute working directory inside configured roots. Explicit path-like argv tokens are resolved against that directory and must remain inside configured roots.

The daemon tokenizes the command itself. Shell control/substitution/redirection characters fail closed for VERIFY matching. A model-authored `classification: "verify"` is rejected.

VERIFY is intentionally distinct from READ ONLY. Test/build code can create caches/artifacts, spawn processes and otherwise have environmental side effects. The bridge does not claim OS sandboxing.

### WRITE / DESTRUCTIVE

WRITE is any non-read-only tool that did not match VERIFY policy. DESTRUCTIVE derives from current MCP annotations and remains subject to `allow_destructive` plus the optional always-approve gate.

Risk order for session leases:

```text
read_only < verify < write < destructive
```

## Execution authorization

For every top-level task, the daemon:

1. normalizes canonical LBP 1.2 input;
2. resolves an enabled loopback server from daemon-owned config;
3. fetches/uses the current MCP tool catalog;
4. rejects unknown or non-allowlisted tools;
5. derives base classification from MCP annotations;
6. optionally derives VERIFY from daemon-owned policy and concrete arguments;
7. enforces write/destructive authority;
8. walks arguments by value and checks absolute/`~` paths against configured roots; recognized path keys make relative paths fail closed;
9. for `mcp.observe`, verifies every item is READ/VERIFY before any dispatch;
10. derives approval requirements from local policy;
11. validates local one-time approval token/session lease when required;
12. journals the normalized top-level task;
13. executes it behind the per-server RW barrier;
14. journals the result.

The MCP server still performs its own authoritative domain/tool validation.

## Approval modes

Per server:

- `all`: every top-level operation requires local approval;
- `session`: local UI may grant a 2-hour lease for a server/tab/conversation up to the approved risk level;
- `mutations`: READ + VERIFY automatic; WRITE + DESTRUCTIVE require approval;
- `none`: no ordinary prompt, but all daemon/MCP policy checks still apply.

`always_approve_destructive=true` overrides automatic/session behavior for destructive calls.

For an observation group, approval risk is its highest item classification: READ if all items are read-only; VERIFY if any item is VERIFY.

## Result semantics

Top-level task status remains:

- `ok`
- `error`
- `unknown`

`unknown` is reserved for ambiguous WRITE/DESTRUCTIVE execution state. READ/VERIFY failures return `error` because LBP does not treat them as authoritative project mutations.

`mcp.observe` returns per-item statuses. If any item fails, the group returns top-level `error`; successful independent observations may still be present. No rollback is needed because the group has no mutation authority.

`applied_mutations` records only WRITE/DESTRUCTIVE operations. VERIFY never appears there.

## Idempotency vs approval

`task.id` remains the top-level idempotency key and journals are stored under `sha256(task.id)`.

Reusing the same id with identical normalized content replays the stored result. Reusing it with different content is rejected.

One-time approval tokens are short-lived, single-use, and bound to:

- normalized task digest;
- browser tab/conversation session;
- current server policy fingerprint;
- daemon-derived top-level classification.

Bad task/session attempts do not consume a legitimate token. Policy/classification changes intentionally invalidate it.

Ambiguous WRITE/DESTRUCTIVE operations are never blindly retried.

## Browser continuation state

Auto-continue remains adapter behavior, not LBP authority.

A browser tab tracks a bounded chain anchored to the latest ordinary human user message. Bridge-generated `LBP_RESULT` turns do not create a new human anchor.

A local result may be auto-submitted only if the adapter can prove all of the previous v0.8 safety conditions: correct active task/result correlation, empty composer before insertion, exact one-result content after normalization, provider idle, known form-scoped Send control, unchanged composer and remaining round-trip budget.

A later ordinary user message countermand makes older assistant tasks review-only after reload/history scan. Streaming assistant messages are never parsed for execution.

## Persistent status UI

v0.9 adds a browser-only status chip/panel independent of task cards.

State examples:

- connected / idle;
- checking local policy;
- running READ/VERIFY/WRITE;
- approval required;
- continuing automatically with `N/max` chain count;
- paused due user draft/provider state/round-trip cap;
- daemon offline;
- local error / ambiguous write state.

The panel can stop the current auto-chain and open settings. It does not grant execution authority or mutate LBP task content.

A low-frequency `/health` check runs while the ChatGPT tab is visible so the chip can distinguish connected/offline. This is UI health telemetry, not daemon-initiated task polling.

## Prompt-injection/security posture

Auto-continue and observation batching reduce repetitive clicks/turns but do not change the authority boundary.

The effective boundary is still the intersection of:

```text
configured server
∩ allowed_tools
∩ allowed roots
∩ local VERIFY rules
∩ write/destructive authority
∩ observation-group restrictions
∩ local approval policy/leases
∩ MCP server's own validation
```

Using broad command VERIFY rules, broad roots, or `approval_mode=none` intentionally increases autonomy and corresponding prompt-injection exposure. The UI should make those choices explicit rather than imply they are sandboxed.

## Provider adapter boundary

ChatGPT-specific browser logic remains isolated to `extension/adapters/chatgpt.js`.

Generic `content.js` owns:

- LBP task lifecycle;
- daemon preflight/approval/run calls;
- derived task UI;
- persistent status chip;
- result correlation;
- bounded continuation state;
- payload collapsing.

The daemon has no ChatGPT-specific knowledge.

## Non-goals retained

- no unrestricted multi-operation workflow language;
- no dependencies/conditions/result references between grouped calls;
- no bridge-native shell/filesystem executor;
- no remote/non-loopback MCP endpoints;
- no model-created policy or leases;
- no automatic retry of ambiguous mutations;
- no same-run/native-tool semantic claim;
- no provider-private backend automation;
- no daemon-initiated/background task polling or watchers.
