# LBP 1.3.1 — Result body transport extension

LBP 1.3.1 is a narrow, backward-compatible extension of LBP 1.3. It does not change task semantics, mutation semantics, approval semantics, execution status, delivery status, task authority, or provider-turn correlation. Its only protocol change is the representation of result payloads so large results can be delivered as files without first passing a large JSON body through the provider composer.

LBP 1.3 remains valid and unchanged.

## Compatibility

LBP 1.3.1 task semantics are identical to LBP 1.3. A task using version `1.3.1` is normalized and executed under the same task rules as `1.3`.

An implementation may continue accepting LBP 1.3 tasks while emitting LBP 1.3.1 results once 1.3.1 result delivery is enabled locally. A 1.3 result must remain interpreted exactly according to LBP 1.3 and must never be reinterpreted as though it contained the 1.3.1 `body` union.

## Result delivery

The visible transport marker remains mandatory ordinary message text:

```text
LBP result · task=task-004 · delivery=d-7fa291
```

Delivery acknowledgement remains based on the expected new provider user turn plus the daemon-bound `delivery_id`, `task_id`, `conversation_id`, and `result_digest`. Attachment presence or filename alone is never sufficient acknowledgement.

An LBP 1.3.1 result has the common outer envelope:

```json
{
  "protocol": "lbp",
  "version": "1.3.1",
  "bridge_version": "0.9.3",
  "task_id": "task-004",
  "title": "Example task",
  "status": "ok",
  "completed_at": 1788577000,
  "body": {}
}
```

`status` remains one of `ok`, `error`, `unknown` with exactly the same meaning as in LBP 1.3.

The complete result payload that LBP 1.3 carried directly as `operation`, `applied_mutations`, and `outputs` now lives under one required `body` representation.

## Inline body

For a result small enough for safe provider delivery:

```json
{
  "protocol": "lbp",
  "version": "1.3.1",
  "bridge_version": "0.9.3",
  "task_id": "task-004",
  "title": "Example task",
  "status": "ok",
  "completed_at": 1788577000,
  "body": {
    "type": "inline",
    "content": {
      "operation": {
        "type": "mcp.observe",
        "server": "workspace",
        "classification": "read_only",
        "calls": []
      },
      "applied_mutations": [],
      "outputs": []
    }
  }
}
```

`body.content` contains the complete result payload that would have occupied the top-level `operation`, `applied_mutations`, and `outputs` fields in LBP 1.3. It must not be a shortened preview when `body.type` is `inline`.

## File body

For a result too large for safe inline provider delivery:

```json
{
  "protocol": "lbp",
  "version": "1.3.1",
  "bridge_version": "0.9.3",
  "task_id": "task-004",
  "title": "Example task",
  "status": "ok",
  "completed_at": 1788577000,
  "body": {
    "type": "file",
    "name": "lbp-result-task-004.json",
    "media_type": "application/json",
    "bytes": 184203,
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

The attached file contains the complete JSON result body that would otherwise appear as `body.content`:

```json
{
  "operation": {},
  "applied_mutations": [],
  "outputs": []
}
```

For `body.type = "file"`:

- `name` is a provider-facing attachment name only. It is metadata, not a local filesystem path and conveys no filesystem authority.
- `media_type` identifies the attachment representation. The initial normative representation is `application/json`.
- `bytes` is the exact attachment size in bytes and must be an integer greater than or equal to zero.
- `sha256` is the lowercase hexadecimal SHA-256 digest of the exact attached bytes and must contain exactly 64 hexadecimal characters.
- the attachment content must be the complete result body, not a preview or independently summarized variant.

## Representation authority

The daemon chooses `inline` or `file` using local transport limits and the serialized result size. Task text cannot request, select, suppress, enlarge, or otherwise influence the representation.

Choosing `file` is a transport decision only. It does not change task status, execution status, delivery status, approval state, mutation authority, result meaning, or idempotency.

Provider adapters must attach a file body directly using the provider's supported attachment mechanism. They must not first insert the complete large result into the provider composer and depend on the provider to convert it into an attachment.

The normal visible delivery marker remains required for both representations. A provider adapter may also add concise visible metadata such as attachment name, byte count, or digest, but that text is transport presentation and is not the authoritative result body.

## Execution status vs delivery status

Unchanged from LBP 1.3:

- `execution_status`: `registered | running | completed | error | unknown`
- `delivery_status`: `none | inserted | submitted | failed | withheld`

A locally completed operation whose file or inline result has not reached the provider remains a completed execution with a separate delivery state.

## What task text cannot authorize

Unchanged from LBP 1.3. Task text cannot authoritatively carry or influence `mutating`, `required`, `classification`, approval decisions or leases, trusted/session status, allowed roots/tools, verification rules, write/destructive authority, browser continuation mode, local credentials, result delivery representation, result attachment name, result byte limit, or result storage location.
