# LBP 1.3 — Local Bridge Protocol envelope

Normative for Local MCP Bridge v0.9.2.

LBP 1.3 is LBP 1.2 plus one operation type, `mcp.mutate`, and a stricter
statement of failure semantics for dispatched mutations. Everything in
[`LBP_V1_2.md`](./LBP_V1_2.md) that is not restated here still applies.

`LBP_V1_1.md` is retained as a historical document only. **LBP 1.1 is not a
runtime target in v0.9.2.** Both the daemon and the extension validator reject
`"version": "1.1"` rather than coercing it, so the two validators can never
disagree about what is executable.

## Supported versions

| Version | Operations |
|---|---|
| `1.2` | `mcp.call`, `mcp.list_tools`, `mcp.observe` |
| `1.3` | all 1.2 operations plus `mcp.mutate` |

`version` defaults to `"1.2"` when absent. Any other value is rejected.

## Critical semantic constraint

Unchanged from 1.2, and it is the reason this protocol exists:

**One assistant message carries exactly one LBP task.** The whole assistant
response is evaluated as a single unit — two tasks in two separate code blocks
of the same message is still two tasks, and the message is rejected.

The assistant never executes anything. It emits a task; the local daemon decides
whether that task is permitted, executes it, and the extension returns the result
as the next real user turn.

## Task envelope

````
<LBP_TASK>
{
  "protocol": "lbp",
  "version": "1.3",
  "id": "task-004",
  "title": "Apply the reviewed patch",
  "operation": { ... }
}
</LBP_TASK>
````

| Field | Required | Notes |
|---|---|---|
| `protocol` | yes | must be `"lbp"` |
| `version` | no | `"1.2"` or `"1.3"`; defaults to `"1.2"` |
| `id` | yes | non-empty string, <= 256 characters, unique within the conversation |
| `operation` | yes | exactly one operation object |
| `title` | no | <= 200 characters |
| `description` | no | <= 1200 characters |
| `action_label` | no | <= 80 characters |
| `plan` | no | LBP 1.3 only; registers an immutable workflow plan |
| `plan_id` | no | references the registered plan |
| `plan_revision` | no | references the registered plan revision |
| `plan_item_id` | no | identifies the intended step in the registered plan |
| `outputs` | no | descriptive durable-output metadata; no authority effect |

A single-element `operations[]` array remains accepted as a canonical 1.2
spelling of `operation`. Arrays of length != 1 are rejected. The unrestricted
multi-operation workflow array is not restored.

## Optional plan model

LBP 1.3 may carry a small plan on the first task in a chain. There is no separate
`<LBP_PLAN>` block.

````
<LBP_TASK>
{
  "protocol": "lbp",
  "version": "1.3",
  "id": "audit-001",
  "plan": {
    "id": "stabilize-v092",
    "revision": 1,
    "title": "Stabilize Local MCP Bridge v0.9.2",
    "items": [
      {"id": "p1", "phase": "plan", "title": "Audit current implementation"},
      {"id": "p2", "phase": "execute", "title": "Update sidebar presentation"},
      {"id": "p3", "phase": "verify", "title": "Run regression suite"}
    ],
    "context": {
      "resources": [{"kind": "workspace", "label": "local-mcp-bridge"}],
      "constraints": ["LBP 1.3", "LBP 1.2 compatibility", "Checkpoint = 12"]
    }
  },
  "plan_item_id": "p1",
  "operation": { "type": "mcp.list_tools", "server": "workspace" }
}
</LBP_TASK>
````

Later tasks may reference the plan:

```json
{
  "protocol": "lbp",
  "version": "1.3",
  "id": "sidebar-002",
  "plan_id": "stabilize-v092",
  "plan_revision": 1,
  "plan_item_id": "p2",
  "operation": { "...": "..." }
}
```

One plan item represents one intended LBP step. Plan length and checkpoint
window size are independent: a 20-item plan still checkpoints according to the
daemon's configured window, normally every 12 executed tasks.

Daemon rules:

- plan item IDs must be unique;
- a task's referenced item must exist;
- plan ID and revision must match when provided;
- the next executable item must match the daemon-persisted plan order;
- completed, errored, unknown or skipped items cannot execute again;
- a plan is immutable once registered for a chain;
- a plan is display/state metadata only and grants no authority.

Plan item status is one of:

```text
pending | current | completed | error | unknown | skipped
```

Every plan item still goes through normal task registration, preflight,
classification, approval, execution and result delivery.

## Structured outputs

LBP 1.3 tasks may declare useful durable products:

```json
"outputs": [
  {
    "id": "daemon-file",
    "label": "daemon.py",
    "kind": "file_modified",
    "ref": "/absolute/repo/daemon.py"
  }
]
```

Outputs are descriptive metadata. They do not affect classification, authority,
approval, path security or currentness. The daemon records declared outputs as
`pending` on registration, then marks them `produced`, `failed` or `unknown`
when the task reaches terminal execution status. The bridge does not infer
arbitrary outputs from raw MCP responses in v0.9.2.

## Context projection

The sidebar Context section is daemon-owned in v0.9.2. It is derived from
`plan.context`, enabled MCP server identity, conversation configuration and
explicit user-added context sources. Adding a source to Context does not grant
MCP authority; folder sources must remain inside currently configured MCP roots.
It is not chat history, hidden model context, token usage or a log of files read.

### Task identity is conversation-scoped

Task IDs are scoped to the conversation that produced them. The daemon keys its
execution journal by `SHA256(conversation_id + NUL + task_id)`, so the same
`task-001` in two different chats is two different tasks and can never replay
one another's result.

Re-using an ID **within** one conversation with different content is rejected.
Re-using it with identical content resolves to the existing registration.

## `mcp.mutate` (new in 1.3)

An ordered, bounded batch of daemon-classified WRITE/DESTRUCTIVE calls against a
single server, executed under that server's exclusive read/write barrier.

````
<LBP_TASK>
{
  "protocol": "lbp",
  "version": "1.3",
  "id": "task-004",
  "title": "Apply reviewed edits",
  "operation": {
    "type": "mcp.mutate",
    "server": "workspace",
    "description": "Apply the two reviewed hunks",
    "calls": [
      { "id": "a", "tool": "apply_patch", "arguments": { "path": "/repo/src/a.rs", "patch": "..." } },
      { "id": "b", "tool": "apply_patch", "arguments": { "path": "/repo/src/b.rs", "patch": "..." } }
    ]
  }
}
</LBP_TASK>
````

Rules:

- 1..8 calls; every call needs a unique non-empty `id` (<= 128 characters).
- Every call must derive to WRITE or DESTRUCTIVE. A read-only call in a
  `mcp.mutate` batch is a rejection, not a silent downgrade — use `mcp.observe`.
- All calls are preflighted **before any dispatch**. If any call fails tool,
  root, write, destructive or path policy, the whole batch is rejected and
  nothing is dispatched.
- The batch holds the server's exclusive barrier for its entire duration.
- Execution is **ordered** and stops at the first non-`ok` call. Remaining calls
  report `status: "skipped"`, `execution_state: "not_attempted"`.
- Earlier successful calls are **not rolled back**. The bridge has no transaction
  semantics and does not pretend to.

`mcp.observe` remains the mirror-image operation for READ/VERIFY work: 1..8
calls, shared barrier, all preflighted before dispatch.

## Failure semantics for dispatched mutations

This is the normative part of 1.3 that most changes behaviour relative to 1.2.

**Once a WRITE or DESTRUCTIVE tool call has been dispatched, any outcome that is
not an unambiguous successful MCP response is `unknown`, never `error`.**

`unknown` means: the bridge cannot prove whether the mutation was applied. It is
not a softer `error`; it is a stronger one. It stops automatic continuation
immediately and requires explicit human acknowledgement before that task's
journal can be cleared.

| Outcome after dispatch | `status` |
|---|---|
| MCP result with `isError` absent/false | `ok` |
| MCP result with `isError: true` | `unknown` |
| malformed / unparseable response | `unknown` |
| JSON-RPC error object | `unknown` |
| HTTP error status from the MCP server | `unknown` |
| response exceeding the size bound | `unknown` |
| timeout / disconnect / connection reset | `unknown` |
| MCP session lost mid-call | `unknown`, and **not** retried |

Failures that occur **before** dispatch remain ordinary `error`: policy denial,
preflight rejection, unknown tool, path-policy denial, and a connection refused
before the request was written. The common failure path is therefore unchanged.

READ and VERIFY classifications are unaffected: their failures remain `error`,
and their MCP sessions may still be transparently re-initialised and retried
after a session loss, because re-reading is safe.

For a `mcp.mutate` batch, if any call was applied and any later call failed or
was skipped, the **task** status is `unknown` even when the individual failure
was an ordinary error. Whole-batch retry after a partial application is unsafe,
and the task status is what the assistant reads.

## Result delivery

````
LBP result · task=task-004 · delivery=d-7fa291

<LBP_RESULT>
{
  "protocol": "lbp",
  "version": "1.3",
  "bridge_version": "0.9.2",
  "task_id": "task-004",
  "status": "ok",
  "operation": { ... },
  "applied_mutations": [ ... ]
}
</LBP_RESULT>
````

`status` is one of `ok`, `error`, `unknown`.

The first line is transport metadata. It must remain ordinary visible message
text and must not be hidden, folded or manipulated.

The full `<LBP_RESULT>` follows the marker. Providers may convert a sufficiently
large submitted body into a generated text-file attachment, so acknowledgement
must not require the complete result JSON to be recoverable from rendered DOM.

Before Send, the browser snapshots visible user `data-message-id` values. After
Send, delivery is acknowledged only when a new user `data-message-id` appears and
that message's visible semantic text contains the expected `delivery=<id>`.

The daemon binds `conversation_id`, `task_id`, `delivery_id` and `result_digest`
when it stores the result. Matching only `task_id` or merely seeing any new user
message is not sufficient.

### Execution status vs delivery status

A locally completed operation and a submitted ChatGPT turn are different events.
The daemon tracks them separately:

- `execution_status`: `registered | running | completed | error | unknown`
- `delivery_status`: `none | inserted | submitted | failed | withheld`

A task that executed cleanly but whose result never reached the provider is
`completed` / `failed`, not an execution failure.

## What task text cannot authorize

Unchanged from 1.2 and enforced by both validators. A task may **not** carry
`mutating`, `required`, or `classification` on an operation or call. The daemon
derives classification from the live tool catalog and its own policy. A task
carrying any of those fields is rejected outright rather than sanitised.

Task text also cannot select or influence: the approval window, the chain
identity, whether an approval lease applies, whether a task is current, or
whether a result may replay. Those are daemon-owned.

## Bounds

| Bound | Value |
|---|---|
| `mcp.observe` calls | 1..8 |
| `mcp.mutate` calls | 1..8 |
| task `id` | <= 256 characters |
| call `id` | <= 128 characters |
| `title` | <= 200 characters |
| `description` | <= 1200 characters |
| `action_label` | <= 80 characters |

Both the daemon and `extension/protocol.js` enforce these, and the release suite
asserts the two agree.
