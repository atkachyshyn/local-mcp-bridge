> Historical artifact: names and file references below reflect the repository layout at the time of that review.

# Independent peer-review disposition through v0.8

The independent v0.4 review concluded `PROCEED WITH BLOCKERS`, not redesign. Its central finding was correct: the architecture was sound, but authority and approval were too weakly enforced for real source mutation.

## Original blockers closed in v0.5

- bridge-native shell/filesystem executor deleted;
- daemon-owned deny-by-default tool/root/write/destructive policy;
- mutation class derived from MCP annotations;
- full-argument extension approval UI;
- hardened token/journal permissions;
- MCP protocol/SSE/session fixes;
- task-id journal collision/recovery fixes;
- host/sender/fail-closed DOM checks;
- single-operation LBP 1.1.

## v0.6: approval became policy rather than ceremony

Per-server `approval_mode` added:

- approve every operation;
- session-scoped approval leases;
- automatic reads + approval on mutations;
- policy-only automatic execution.

Destructive operations can remain independently always-gated.

A local approval is enforced by the daemon with short-lived single-use tokens. The model cannot forge an approval by adding fields to LBP.

Session leases are local-UI-created, browser-session scoped, per-server, risk-tier bounded, policy-fingerprint bound, time-limited and memory-only. A read lease does not authorize a later write.

Provider DOM/composer behavior was extracted to `extension/adapters/chatgpt.js`, while rendered LBP payloads became visually collapsible without inventing an undocumented hidden provider channel.

## v0.7: closing the chat-bounded interaction gap

A further independent observation exposed the main usability gap left after v0.6: a browser extension cannot provide a local MCP result *inside an assistant generation that is already running*. Requiring the user to manually send every generated result turn would still make the bridge feel substantially less capable than a native plugin.

v0.7 does **not** pretend that limitation can be removed. Instead it formalizes LBP as a turn-to-turn continuation convention and adds bounded browser-side auto-continuation:

```text
assistant LBP task
-> local MCP operation
-> extension submits LBP result as next user turn
-> assistant continues
```

This is explicitly documented as different from provider-native same-run tool calling.

### Auto-continuation is not authority

Browser interaction preferences live in extension local storage and do not change daemon policy.

The model cannot set:

- auto-continue mode;
- round-trip cap;
- approval mode;
- leases/tokens;
- allowed tools/roots;
- mutation classification.

### Safety brakes added around auto-submit

Auto-submit is permitted only when the correlated local result belongs to the currently active task, the composer was empty before insertion, the provider is idle, a known send control is available, and the composer remains exactly the bridge-generated result immediately before Send.

It pauses/stops on:

- an existing or newly changed user draft;
- provider generation/DOM uncertainty;
- result/task mismatch;
- explicit Stop;
- approval denial;
- round-trip limit;
- malformed/multiple task envelopes.

A new ordinary human user prompt resets the chain. Bridge-generated LBP result turns do not.

### History/reload replay protection

Daemon journals already prevent a completed task id from mutating locally twice. v0.7 additionally scans existing user LBP results and will not auto-start a task whose result is already present in the conversation.

Only a task in the latest conversation message overall may auto-start, and the latest assistant host is ignored while it is still streaming; historical or countermanded unresolved tasks require manual review.

## Deliberate constraints retained

- No model-controlled policy or approvals.
- No bridge-native executor.
- No remote MCP endpoints.
- No multi-operation workflows.
- No automatic retry of ambiguous mutations.
- No hidden/private provider request API.
- No claim that turn-chained continuation is native synchronous tool calling.
- No second provider adapter until the final review validates the abstraction.
## v0.8: final-gate blockers closed

The v0.7 final gate again returned `PROCEED WITH BLOCKERS`, but only two narrow blockers remained. v0.8 closes both and folds in the same review's low-cost hardening items:

1. **Root containment is value-based.** The daemon now recursively inspects every string argument. Any value that is already absolute or becomes absolute after `~` expansion must resolve under a configured root regardless of whether the MCP calls it `path`, `filename`, `dest`, `pcb`, `output`, `src`, etc. Recognized path-key names remain an additional fail-closed rule for relative paths.
2. **Auto-start is countermand-safe.** A task auto-starts only if its assistant message is the latest conversation message overall. A later user message prevents execution after reload/new scan. Streaming assistant hosts are never processed.
3. **Composer auto-submit is normalized but still strict.** Provider whitespace normalization is tolerated, but the composer must contain exactly one `LBP_RESULT` and no unrelated text; the adapter rechecks immediately before clicking a Send control scoped to that composer's form.
4. **Approval token misuse no longer burns valid tokens.** Token bindings are validated before consumption and include daemon-derived classification.
5. **Session approval is narrower and clearer.** Default lease lifetime is 2 hours; the service worker scopes it to tab + conversation; the approval button spells out the actual risk scope/server/duration.
6. **Dangerous policy combinations are made explicit.** Settings warn on policy-only writes, un-gated destructive tools, and writes with no roots. Saving policy-only writes requires typing `ALLOW UNATTENDED WRITES`.
7. **Browser protocol validation matches daemon validation.** Deprecated model-authored `mutating`/`required` fields are rejected rather than silently stripped.

No protocol expansion was needed. LBP remains one operation per model turn, and auto-continuation remains browser-adapter behavior rather than model-authored protocol state.
