# Local MCP Bridge v0.9.2 architecture

## Purpose

Use an ordinary browser-chat conversation as a cloud reasoning surface while local execution remains standard MCP and locally governed.

```text
assistant output
    |
    | LBP 1.3 task
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

Auto-continue only automates those bridge-generated result turns. Protocol payloads stay visible in chat as normal provider-rendered text; the extension does not fold, hide, clone, restyle or otherwise mutate existing ChatGPT messages.

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
- browser auto-continue mode or checkpoint cap.

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

1. normalizes canonical LBP 1.2/1.3 input;
2. resolves an enabled loopback server from daemon-owned config;
3. fetches/uses the current MCP tool catalog;
4. rejects unknown or non-allowlisted tools;
5. derives base classification from MCP annotations;
6. optionally derives VERIFY from daemon-owned policy and concrete arguments;
7. enforces write/destructive authority;
8. walks arguments by value and checks absolute/`~` paths against configured roots; recognized path keys make relative paths fail closed, and traversal-shaped relative values (`../`, `./`, or any `..` segment) fail closed in unrecognized keys too;
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

### Protocol compatibility

Task parsing accepts LBP 1.2, 1.3 and 1.3.1. Version 1.3.1 inherits the 1.3 task
semantics, including `mcp.mutate`, plan metadata and outputs. LBP 1.1 is rejected
rather than coerced. Result emission deliberately remains the legacy LBP 1.3
shape until the 1.3.1 body/file transport is implemented end to end.

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

## Orchestration: the daemon owns conversation lifecycle

The governing rule of v0.9.2:

> **DOM is evidence of provider turns, never execution authority.** The daemon is
> the only source of truth for workflow state, task currentness, checkpoint
> scope, stale/replay eligibility and approval-window identity.

```text
ChatGPT DOM
    |  provider-turn evidence only
    v
provider adapter        latest turns, task count, composer, submission ack
    |
    v
browser coordinator     serialized event pump, NO durable state
    |
    v
background worker       conversation identity + authenticated loopback
    |
    v
daemon                  conversation state machine + journal + policy
```

The browser holds no chain, no workflow flag, no execution ledger and no
DOM-derived task numbering. Those all lived in `sessionStorage` before v0.9.2 and
competed with daemon state; the disagreement between them, under provider
virtualization, is what produced repeated stale-task failures.

### Conversation identity

| Shape | Meaning |
|---|---|
| `conv-<32 hex>` | canonical: SHA-256 of the provider's own conversation id (ChatGPT's `/c/<uuid>` path segment, a public route parameter — not a private API) |
| `prov-<32 hex>` | provisional: per **tab**, used before the provider has assigned a conversation id |

Provisional state migrates to a canonical identity exactly once, never over
existing canonical state, and navigation between two canonical conversations
copies nothing. Journals written under a provisional identity are re-keyed at
bind time so a task registered before the URL settled stays resolvable.

The previous identity was 32-bit FNV-1a over the pathname. Every new chat in
every tab hashed to one bucket, and because `enabled` lives in that bucket,
enabling once enabled every future new chat everywhere.

### Phases

```text
disabled -> idle -> awaiting_assistant -> task_registered -> executing
                         ^                                      |
                         |                              result_ready
                         |                                      |
                         +------ acknowledge_submission --------+

Any active phase may move to `stopped` after an explicit Stop or an ambiguous
mutation. Checkpoints are approval-window boundaries, not a lifecycle phase.
```

`enabled` and `workflow_attached` are persistent chat properties; `phase` is
execution lifecycle. They are deliberately not collapsed into one `active` flag.

### The execution baseline

Historical tasks must never execute, and "the turns currently rendered" is
exactly what virtualization destroys -- reading a baseline off the visible turns
would mean enabling while scrolled up recorded it at an old turn and made
everything after it eligible.

So the baseline is an **armed genuine send**. No chain exists until the
coordinator arms one (from a real send in *this* tab) and the provider then
produces that user turn. Scrolling, provider re-renders, task rediscovery and
another tab can none of them arm one, so none of them can create the chain that
authorises a run.

**The chain is the authorisation.** `enabled` is not: it only asks for the
workflow instructions to be attached to the next human turn. Enabling is
therefore non-destructive (it used to clear the active chain, so pressing it
mid-run threw the run away), but it is still a prerequisite: only an enabled
conversation may arm a genuine human send and create an executable chain.
`disable` is the real off switch: it stops the run and sets the phase to
`disabled`, which the execution barrier refuses.

### Task registration is the execution capability

`register_task` normalizes and persists the full task once and returns an opaque
handle. Preview, approval and execution address that handle; the browser never
resupplies a task body, so task content cannot change between phases.

Registration is idempotent on `(assistant_turn_id, digest)` in **any** phase — a
reload during `task_registered` re-attaches rather than being refused. The phase
gate applies to creating a registration, never to resolving one.

Execution additionally requires, checked daemon-side:

- the conversation is enabled and not stopped;
- the registration is the conversation's current registration;
- its `chain_id` matches the active chain;
- its `window` matches the active checkpoint window.

A browser bug, a reload, virtualization or a rediscovered historical task cannot
pass this barrier, because currentness is decided from daemon state and never
from anything the browser asserts.

### Journal

Keyed `SHA256(conversation_id + NUL + task_id)`. Lifecycle is an explicit status
field, never inferred from file existence:

| Status | Recovery meaning |
|---|---|
| `registered` | never dispatched — safe to execute |
| `executing` | dispatched, no result — ambiguous, never retried automatically |
| `completed` / `error` / `unknown` | result stored — replays without re-entering MCP |

Replay resolves **after** policy re-evaluation, so a stored result can never be
returned for an operation current policy would now refuse.

`recent_tasks` in conversation state is a bounded **display projection**. No
staleness, currentness or duplicate-id decision reads it; those resolve against
the journal, which is not truncated.

### Execution status vs delivery status

A local MCP operation and a ChatGPT submission are different events:

- `execution_status`: `registered | running | completed | error | unknown`
- `delivery_status`: `none | inserted | observed | submitted | failed | withheld`

A task that completed locally but whose result never reached the provider is
`completed` / `failed` — not an execution failure. `Re-deliver result` replays
the stored result into the composer and never re-enters MCP. There is no "Run
again": re-running work requires a newly authored task with a new id.

### Checkpoints and approval windows

`Approve until checkpoint` means **the current approval window**. The daemon
preserves an `approval_scope_id` across ordinary human follow-up turns and derives
`approval_window_id = approval_scope_id + ".w" + window`; the browser never sends
or chooses either value. A window rollover evicts the superseded window lease, so
the next window requires fresh approval when policy requires it.

There is no hard checkpoint phase and no Continue action. Every registered task
consumes exactly one checkpoint slot regardless of whether it completes, fails,
is denied, is abandoned, or becomes `unknown`; history is never refunded. When a
terminal task reaches the window boundary, the daemon rolls the window
automatically. For a delivered result, rollover occurs only after provider
confirmation. An abandoned pre-dispatch task that fills the window rolls it
immediately because there is no result delivery to await.

Result delivery is two-phase. `observe_submission` first records the matching new
provider user turn and its daemon-issued `delivery_id`. A later assistant turn is
evidence that the provider accepted that user turn; only then may
`acknowledge_submission` mark the delivery `submitted` and advance the checkpoint
boundary. A click is never proof of submission, a forged marker cannot satisfy
the daemon binding, and repeated acknowledgement cannot advance a window twice.

Changing checkpoint size changes the next boundary without rewriting history.
Growing the limit applies immediately. Shrinking below the already-consumed count
does not retroactively roll the window; `checkpoint_resize_pending` defers that
roll to the next terminal task boundary.

An `unknown` mutation stops the chain immediately. Manual acknowledgement resumes
without retrying or refunding that task; `unknown_recovery=auto_continue` performs
the same acknowledgement automatically only after the unknown result has been
provider-confirmed.

### Concurrency

Conversation state carries a `revision`. Every mutating call is a
compare-and-swap; a conflict returns current state for merge rather than
double-applying. One tab holds a short renewable owner lease and only that tab
may drive execution; others render read-only. Two tabs are two event pumps
against one state machine, and serializing inside a tab does not help.

### Bridge result turns

Automatically delivered results start with a small ordinary-text marker:

```text
LBP result · task=<task_id> · delivery=<delivery_id>
```

The current daemon emits the legacy LBP 1.3 result envelope inline after the
marker. Oversized browser transport is withheld defensively rather than forcing a
large payload through the composer. `protocol/LBP_V1_3_1.md` defines the planned
inline-or-file result body, but the daemon must not label a legacy-shaped result
1.3.1 until that transport is implemented end to end.

Before v0.9.2 the containment check was enough, so a human countermand that
included a result block did not rotate the chain and left the chain approval
alive.

The daemon binds `conversation_id`, `task_id`, `delivery_id` and `result_digest`
when it stores the canonical result. The browser can only acknowledge that
daemon-owned pending delivery by reporting a new provider user turn id and the
matching delivery id. A new user message without the marker is not enough.

## Persistent status UI

The status surface is a pure projection of daemon state. The task list is ordered
by the daemon's own `sequence`, never by DOM order — under virtualization DOM
order is wrong in exactly the situation where the user most needs it right.


v0.9 adds a browser-only status chip/panel independent of task cards.

State examples:

- connected / idle;
- checking local policy;
- running READ/VERIFY/WRITE;
- approval required;
- continuing automatically with `N/max` chain count;
- paused due user draft/provider state/checkpoint cap;
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

Generic browser code owns:

- the serialized scan/reconciliation pump;
- daemon preflight/approval/run calls;
- result correlation and delivery;
- observed-provider submission acknowledgement;
- the Progress sidebar as a daemon-state projection.

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
- no protocol-message folding or hiding;
- no daemon-initiated/background task polling or watchers.
