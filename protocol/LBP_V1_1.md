> **Superseded by LBP 1.2 in bridge v0.9. Kept for migration/history.**

# LBP 1.1 — Local Bridge Protocol envelope

LBP is a small browser-chat transport convention for delegating **one** local MCP operation from an assistant message to a local bridge and returning the result in a later user message.

LBP is not a replacement for MCP. MCP remains the protocol between the local bridge and local tool servers.

## Why this exists

Ordinary browser-chat conversations do not provide a dependable provider-independent localhost MCP channel. LBP provides a model-visible envelope that a browser adapter can detect and hand to a local daemon.

The local daemon owns authority and policy. LBP carries requested intent only.

## Critical semantic constraint

LBP is **turn-chained**, not synchronous same-run tool calling.

A browser adapter cannot inject a local result into an assistant generation already in progress. Therefore the sequence is:

```text
assistant LBP task
-> local MCP call
-> user LBP result
-> next assistant turn
```

An adapter may automate submission of the result turn, but it must not describe this as native in-flight tool continuation.

## Task envelope

Use an isolated fenced text block when possible:

```text
<LBP_TASK>
{
  "protocol": "lbp",
  "version": "1.1",
  "id": "workspace-read-001",
  "title": "Read planner implementation",
  "description": "Inspect the relevant source before proposing a change.",
  "operation": {
    "type": "mcp.call",
    "server": "workspace",
    "tool": "read_file",
    "arguments": {
      "path": "/absolute/project/path/src/main.rs",
      "offset": 0,
      "length": 12000
    }
  }
}
</LBP_TASK>
```

Required task fields:

- `protocol`: `"lbp"`
- `version`: `"1.1"`
- `id`: non-empty opaque idempotency key chosen by the model/client
- `operation`: exactly one operation

Optional presentation fields:

- `title`
- `description`
- `action_label`

Supported operation types:

### `mcp.call`

```json
{
  "type": "mcp.call",
  "server": "workspace",
  "tool": "read_file",
  "arguments": {}
}
```

### `mcp.list_tools`

```json
{
  "type": "mcp.list_tools",
  "server": "workspace"
}
```

## What a task must not carry

A task does not carry authoritative fields for:

- `mutating`
- approval decisions
- trusted/session status
- allowed roots/tools
- write/destructive policy
- browser auto-continue mode
- round-trip limits
- local credentials

Those are local bridge/browser policy and must not become model-controlled through the envelope.

## Result envelope

The bridge returns a real later user message containing:

```text
<LBP_RESULT>
{
  "protocol": "lbp",
  "version": "1.1",
  "bridge_version": "0.8.0",
  "task_id": "workspace-read-001",
  "title": "Read planner implementation",
  "status": "ok",
  "completed_at": 1780000000,
  "operation": {
    "status": "ok",
    "server": "workspace",
    "tool": "read_file",
    "result": {}
  },
  "applied_mutations": []
}
</LBP_RESULT>
```

`task_id` is the correlation key. Browser adapters should correlate a returned result only with the currently pending task carrying the same id.

## Status semantics

Task result status is intentionally small:

- `ok` — the bridge believes the operation completed and received a normal result.
- `error` — the bridge believes the operation failed without an ambiguous local write state.
- `unknown` — the bridge cannot prove whether a mutating operation landed; clients must not blindly retry.

## Browser auto-continuation is out of protocol

Whether a result is:

- inserted into a composer for manual sending, or
- automatically submitted as the next user turn

is an adapter/user preference, not an LBP field.

This keeps the protocol model-independent and prevents the model from granting itself autonomous continuation.

An auto-continuing adapter should fail closed and pause when it cannot prove that:

- the result matches the pending task id;
- the composer was empty before insertion;
- the composer still contains exactly one inserted `LBP_RESULT` and no unrelated content (allowing harmless provider whitespace normalization);
- the provider is idle and a known send control is safely available;
- its local round-trip limit has not been reached.

## Single-operation rule

LBP 1.1 allows exactly one operation per task/assistant message.

The protocol intentionally does not include:

- `operations[]`
- `required`
- DAG dependencies
- rollback semantics
- conditionals
- retry workflows

Multiple local calls are expressed as multiple assistant/result turns. With browser auto-continuation, those turns can happen without manual Send clicks while remaining independently journaled and policy-checked.

## Legacy input normalization

The current POC may accept legacy `<LBP_TASK_V1>` / `<ATLAS_TASK_V1>` markers and `mcp_call` / `mcp_list_tools` aliases for migration. New output should use the canonical forms in this document.

## Security boundary

LBP text is untrusted model output. It is a request, not authorization.

The local daemon must independently derive and enforce actual MCP server availability, tool catalog membership, tool allowlists, read/write/destructive classification, path roots, write authority, approval requirements and approval tokens/leases.
