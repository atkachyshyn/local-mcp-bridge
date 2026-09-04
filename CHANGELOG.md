# Changelog

## 0.9.2 — 2026-09-03

Orchestration stabilization. No new capability: the MCP transport, policy and
execution core is preserved, and the transitional browser/daemon split is
replaced with one daemon-authoritative conversation state machine.

**DOM is evidence of provider turns, never execution authority.** The daemon is
the only source of truth for workflow state, task currentness, checkpoint scope,
stale/replay eligibility and approval-window identity.

### Security

- **Rotate your bearer token.** `extension/config.js` was tracked in Git despite
  the docs saying it was ignored, and there was no `.gitignore` at all. The file
  is now untracked and ignored; run `./rotate-token.sh` to invalidate the
  disclosed credential. Deleting the file from history does not.
- Task journals are keyed by `SHA256(conversation_id + NUL + task_id)`. They were
  keyed by task id alone, so a model-chosen id like `task1` could collide across
  conversations — and because replay resolved before policy evaluation, a
  collision returned another conversation's stored result with no approval, no
  policy check, and no requirement that the server still existed.
- Replay now re-evaluates policy before returning a stored result.
- Conversation identity is SHA-256 over the provider's own conversation id, with
  per-tab provisional identities before one exists. It was 32-bit FNV-1a over the
  pathname, which collapsed every new chat in every tab into one bucket — and
  since `enabled` lives in that bucket, enabling once enabled every future new
  chat everywhere.
- Approval leases are keyed on the conversation, not on a browser-supplied
  session id. `chain_id` has been removed from the wire entirely; the daemon
  derives the approval window as `chain_id + ".w" + window`, so the browser can
  no longer pin an old window to keep a lease alive.
- Approvals are bound to the tool catalog as well as to server policy, so a
  server that relabels a tool between grant and use invalidates the lease.
- Path-shaped relative values in unrecognized argument keys now fail closed.
  Only absolute values were checked, so `../../../.ssh/id_rsa` in an argument
  named `filename` escaped root containment entirely.
- A write/destructive tool carrying a free-form payload argument (`patch`,
  `content`, `old`, `new`, …) is refused unless the operator lists it in the new
  per-server `freeform_write_tools`. Configured roots cannot constrain what is
  inside such a payload, and for a patch tool that payload is the write target.

### Mutation semantics (LBP 1.3)

- Once a WRITE/DESTRUCTIVE call is dispatched, any outcome that is not an
  unambiguous success is `unknown`, never `error`. Previously only raw transport
  failures reached `unknown`: `isError: true`, a malformed response, a JSON-RPC
  error, an HTTP error and an oversize response all reported as retryable.
- A mutating `tools/call` is never transparently retried after a session 404.
  READ/VERIFY session recovery is unchanged.
- A `mcp.mutate` batch that applied at least one call and then failed reports
  task status `unknown`, because whole-batch retry after partial application is
  unsafe.
- Pre-dispatch failures remain ordinary `error`, and READ/VERIFY failures remain
  `error`, so the common path is unaffected.

### Orchestration

- Enabling establishes a baseline by observation: after enable, no chain exists
  until a genuine local send is armed and the provider then produces a turn.
  Scrolling, virtualization and rediscovery can never arm one, so a historical
  task cannot execute.
- The full task is normalized and persisted once, at registration, and preview,
  approval and execution address it by an opaque handle. Task bodies are no
  longer resupplied by the browser between phases.
- Registration is idempotent on `(assistant_turn_id, digest)` in any phase, so a
  reload that rediscovers its own task re-attaches instead of being refused.
- Journals distinguish `registered` from `executing` as an explicit status, never
  by file existence, making crash recovery deterministic: registered-and-never-
  dispatched is safe to execute, dispatched-without-result is ambiguous.
- Execution status and delivery status are separate. A task that completed
  locally but failed to reach the provider is no longer recorded as an execution
  failure, and `Re-deliver result` replays the stored result without re-entering
  MCP.
- The checkpoint window advances only on acknowledged provider submission — a new
  user turn whose content matches the daemon's stored canonical result. A click
  is not proof, and a repeated acknowledgement cannot advance the window twice.
- A denied or abandoned task releases its window slot. Previously a task that
  registered and never reported terminal status wedged the chain permanently:
  registration refused for capacity, continuation refused for having no pending
  checkpoint.
- Conversation state carries a `revision`; every mutating call is a
  compare-and-swap, and one tab holds a renewable owner lease. Two tabs on one
  conversation can no longer both drive the state machine.
- A user message that merely contains an `<LBP_RESULT>` envelope alongside other
  text is a genuine human turn, not a bridge turn. It previously counted as a
  bridge turn, so a human countermand did not rotate the chain or reset approval
  scope.
- Two LBP tasks in separate code blocks of one assistant message are rejected as
  a multi-task response.
- Optional LBP 1.3 plan metadata is persisted by the daemon as immutable
  conversation state after registration. The daemon validates unique plan item
  ids, plan id/revision references, next-item order, terminal item reuse and
  superseded-chain references.
- Optional LBP 1.3 outputs metadata is persisted as a structured registry and
  marked `pending`, `produced`, `failed` or `unknown` from task execution status.
- The sidebar is ordered by daemon sequence or daemon-persisted plan order, never
  DOM order, and is organized as connection pill, Progress, Outputs, Context and
  a compact footer.

### Protocol

- Runtime support is frozen to LBP 1.3 plus backward-compatible 1.2. LBP 1.1 is
  rejected rather than coerced, and the `<LBP_TASK_V1>` / `<ATLAS_TASK_V1>`
  envelopes are removed. Adds normative `protocol/LBP_V1_3.md`, including the
  final plan, outputs and read-only context model.

### Browser modules

- `content.js` is bootstrap and wiring only. Orchestration moves to
  `coordinator.js` (a serialized event pump holding no durable state) and
  rendering to `presentation.js` (a pure projection of daemon state).
- `chain_state.js` is deleted, along with the sessionStorage chain, the workflow
  flag, the browser execution ledger and DOM chain reconstruction.

### Sidebar wording pinned to the approved reference

- The sidebar is pinned to `docs/sidebar-reference.html`, which is now the source
  of truth for its wording. A finished step reads `Completed · 14:02:11` (it
  showed the delivery status instead), and the running step reads
  `<detail> · In progress` (it read `Running locally · <detail>`).
- `recent_tasks` entries now carry `updated_at` so a finished step can show when
  it finished.
- New `sidebar_reference_test.js` renders the real `presentation.js` in jsdom and
  asserts the visible text exactly, including that the retired wording
  (`Current round trip`, `Round trip N of M`, `Auto-advance`, `Run again`) never
  reappears. Run `npm install --no-save jsdom` to enable it; it skips cleanly
  without it.

### Tests

- All three suites are green: 61 daemon checks, 42 browser checks and 12
  sidebar-reference checks. Both behavioural suites were red before this release.
  Coverage spans the conversation state machine, journaling and recovery,
  mutation ambiguity, approval windows, plan/output metadata, provider
  assumptions, and the rendered sidebar's wording.

## 0.9.1 — 2026-09-02

Focused live-self-hosting compatibility and UX release; LBP remains **1.2**.

- Adds `allowed_tools: ["*"]` as live-catalog eligibility only.
- Allows a narrow daemon-owned VERIFY rule to reclassify a generic command tool from base WRITE or DESTRUCTIVE to VERIFY.
- Hardens task/result parsing around line-isolated envelope markers and fenced-code-block transport.
- Fixes hidden payloads accidentally becoming an execution gate.
- Fixes per-prompt checkpoint progress accounting and reconstructs progress from real LBP result turns.
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
