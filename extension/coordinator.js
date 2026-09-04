// Browser coordinator.
//
// An event pump, not a durable workflow engine. It holds NO durable state: no
// chain, no workflow flags, no execution ledger, no DOM-derived task numbering.
// Everything authoritative lives in the daemon and is read back from it.
//
// The coordinator's whole job is:
//   1. serialize scans
//   2. read the latest provider snapshot
//   3. reconcile it with daemon state
//   4. register / preview / approve / execute the current task
//   5. insert and submit the daemon-produced result
//   6. report observed provider submission back to the daemon
//   7. hand daemon state to the presentation layer
globalThis.LBP_COORDINATOR = (() => {
  const adapter = () => globalThis.LBP_PROVIDER_ADAPTER;

  const DEFAULT_INTERACTION = Object.freeze({
    mode: "manual",
    max_round_trips: 12,
    status_surface: "panel",
    show_protocol_payloads: false
  });

  const BOOTSTRAP_TEXT = [
    "```text",
    "<LBP_WORKFLOW>",
    "Local MCP Bridge is active for this chat.",
    "Emit at most one <LBP_TASK> block per reply. Wait for the <LBP_RESULT> turn before continuing.",
    "Do not include mutating/required/classification fields; the local daemon derives authority.",
    "</LBP_WORKFLOW>",
    "```"
  ].join("\n");

  const tabToken = crypto.randomUUID();

  let interaction = { ...DEFAULT_INTERACTION };
  let daemonState = null;
  let stateStatus = { kind: "loading", detail: "" };
  let bridgeStatus = { kind: "checking", text: "checking local bridge…", detail: "", busy: false };
  let bridgeIdentity = { bridgeVersion: null, lbpVersion: null };
  let listeners = new Set();
  let ownerGranted = false;

  // Per-task UI state that is presentation only. Never used for any execution
  // decision -- those all read daemon state.
  const taskView = new Map();
  const handledBlocks = new WeakSet();

  function notify() {
    for (const listener of listeners) {
      try { listener(); } catch (_) { /* presentation must not break the pump */ }
    }
  }

  function setStatus(kind, text, detail = "", busy = false) {
    bridgeStatus = { kind, text, detail, busy };
    notify();
  }

  function setTaskView(taskId, patch) {
    if (!taskId) return;
    taskView.set(taskId, { ...(taskView.get(taskId) || {}), ...patch });
    notify();
  }

  function setInteraction(next) {
    interaction = { ...DEFAULT_INTERACTION, ...next };
    notify();
  }

  function setStateStatus(kind, detail = "") {
    stateStatus = { kind, detail };
    notify();
  }

  // --- Serialized daemon access ------------------------------------------------
  //
  // Every conversation mutation goes through one promise queue, and every
  // mutating call carries the revision we last saw. Two tabs on one conversation
  // are two pumps against one state machine; the daemon rejects the loser's write
  // instead of double-applying it. That is what stops one submission advancing
  // the checkpoint window twice.

  let stateQueue = Promise.resolve();

  function serialize(work) {
    const run = stateQueue.then(work, work);
    stateQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function rawStateCall(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({
      type: "lbp-conversation-state",
      action,
      payload: { ...payload, tab_token: tabToken }
    });
    if (!response?.ok) {
      const error = new Error(response?.error || "conversation state call failed");
      error.isConflict = response?.conflict === true;
      error.conflictState = response?.state || null;
      if (!error.isConflict && (action === "get" || !daemonState)) {
        setStateStatus("unavailable", error.message);
      }
      throw error;
    }
    daemonState = response.payload.state;
    setStateStatus("ready");
    notify();
    return daemonState;
  }

  async function bridgeMessage(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "Local bridge request failed");
    return response.payload || {};
  }

  function stateCall(action, payload = {}) {
    return serialize(async () => {
      const withRevision = action === "get"
        ? payload
        : { ...payload, expected_revision: daemonState?.revision };
      try {
        return await rawStateCall(action, withRevision);
      } catch (error) {
        if (!error.isConflict) throw error;
        // Someone else moved the state. Adopt theirs and retry once against the
        // revision we now hold; a second conflict is reported rather than looped.
        if (error.conflictState) {
          daemonState = error.conflictState;
          notify();
        } else {
          await rawStateCall("get", {});
        }
        return rawStateCall(action, { ...payload, expected_revision: daemonState?.revision });
      }
    });
  }

  async function refreshState() {
    try {
      return await stateCall("get");
    } catch (_) {
      return daemonState;
    }
  }

  async function configureConversation(next = interaction) {
    const checkpoint = Number(next.max_round_trips);
    return stateCall("configure", {
      mode: next.mode === "auto_continue" ? "auto_continue" : "manual",
      checkpoint_size: Number.isFinite(checkpoint) && checkpoint >= 1
        ? Math.floor(checkpoint) : DEFAULT_INTERACTION.max_round_trips
    });
  }

  // --- Ownership ---------------------------------------------------------------

  // A tab that has just loaded is the live tab, so it takes the lease. Periodic
  // renewals do not take over, so a genuinely second live tab settles the
  // question once instead of both tabs trading the lease back and forth.
  async function ensureOwner({ takeover = false } = {}) {
    try {
      const state = await stateCall("claim_owner", { tab_token: tabToken, takeover });
      ownerGranted = state?.owner_granted !== false;
    } catch (_) {
      ownerGranted = false;
    }
    return ownerGranted;
  }

  // --- Provider reconciliation --------------------------------------------------

  async function reconcileTurns(turns) {
    if (turns.user?.id && turns.user.id !== daemonState?.last_user_turn_id) {
      // The daemon decides what this turn means. An unarmed turn -- one scrolled
      // into view, produced by another tab, or a bridge result -- can never start
      // a chain, so virtualization cannot resurrect a historical chain.
      await stateCall("observe_user_turn", { turn_id: turns.user.id });
    }
    if (turns.assistant?.id && turns.assistant.id !== daemonState?.last_assistant_turn_id) {
      await stateCall("observe_assistant_turn", { turn_id: turns.assistant.id });
    }
  }

  async function handleAssistantTurn(turns) {
    const api = adapter();
    if (!turns.assistant) return;
    if (api.isGenerating()) return;

    const taskState = api.assistantTaskState(turns.assistant.host);

    if (taskState.kind === "none") {
      if (daemonState?.phase === "awaiting_assistant") await stateCall("assistant_no_task");
      return;
    }
    if (taskState.kind === "multiple") {
      await stateCall("stop", { reason: "multiple_tasks_in_one_assistant_turn" });
      setStatus("error", "LBP ⚠ Multiple tasks in one reply",
        `${taskState.count} LBP tasks in a single assistant message; exactly one is allowed.`);
      return;
    }
    if (taskState.kind === "malformed") {
      await stateCall("stop", { reason: "malformed_task" });
      setStatus("error", "LBP ⚠ Malformed task", String(taskState.error || ""));
      return;
    }

    if (handledBlocks.has(taskState.block)) return;
    if (!daemonState?.enabled) return;
    if (["stopped", "disabled", "checkpoint"].includes(daemonState?.phase)) return;

    let registration;
    try {
      // Registration is idempotent on (assistant turn, digest), so a reload that
      // rediscovers its own task re-attaches instead of being refused.
      const state = await stateCall("register_task", {
        assistant_turn_id: turns.assistant.id,
        task: taskState.task
      });
      registration = state.task;
      handledBlocks.add(taskState.block);
      setTaskView(taskState.task.id, {
        taskId: taskState.task.id,
        title: taskState.task.title || taskState.task.id,
        operation: taskState.task.operation,
        registrationId: registration.registration_id,
        status: registration.execution_status
      });
    } catch (error) {
      const message = String(error.message || error);
      if (message.includes("checkpoint_required")) {
        setStatus("paused", "LBP ⏸ Checkpoint reached", "Continue to start a new approval window.");
        return;
      }
      // A refusal here is the daemon rejecting stale or out-of-phase work. That
      // is the barrier doing its job, not something to work around.
      handledBlocks.add(taskState.block);
      setStatus("paused", "LBP ⏸ Task not registered", message);
      return;
    }

    if (registration.execution_status === "registered") {
      await runTask(registration);
    }
  }

  // --- Execution ----------------------------------------------------------------

  async function previewTask(registrationId) {
    const response = await chrome.runtime.sendMessage({ type: "lbp-preview", registration: registrationId });
    if (!response?.ok) throw new Error(response?.error || "preview failed");
    return response.payload.preview;
  }

  async function approveTask(registrationId, decision) {
    const response = await chrome.runtime.sendMessage({
      type: "lbp-approve", registration: registrationId, decision
    });
    if (!response?.ok) throw new Error(response?.error || "approval failed");
    return response.payload;
  }

  async function runTask(registration, approvalToken = null) {
    const registrationId = registration.registration_id;
    const taskId = registration.task_id;
    try {
      const preview = await previewTask(registrationId);
      setTaskView(taskId, { classification: preview.operation?.classification, preview });

      let token = approvalToken;
      if (preview.approval?.required && !token) {
        const decision = await globalThis.LBP_PRESENTATION.requestApproval(preview);
        if (decision === "deny") {
          await stateCall("abandon_task", { registration: registrationId, reason: "denied_by_user" });
          setTaskView(taskId, { status: "denied" });
          setStatus("connected", "LBP ● Denied", `${taskId} was not run.`);
          return;
        }
        const approval = await approveTask(registrationId, decision);
        token = approval.approval_token || null;
      }

      setTaskView(taskId, { status: "running" });
      await stateCall("task_execution_status", { registration: registrationId, status: "running" });
      setStatus("running", "LBP ◌ Running locally…", taskId, true);

      const response = await chrome.runtime.sendMessage({
        type: "lbp-run", registration: registrationId, approvalToken: token
      });
      if (!response?.ok) throw new Error(response?.error || "local task failed");
      const result = response.payload.result;

      // Execution status and delivery status are separate facts. This records
      // only what the local operation did; whether the result ever reached the
      // provider is recorded later, and only when it actually happens.
      const executionStatus = result.status === "ok" ? "completed"
        : result.status === "unknown" ? "unknown" : "error";
      await stateCall("task_execution_status", { registration: registrationId, status: executionStatus });
      setTaskView(taskId, { status: executionStatus, result });

      await deliverResult(registration, result);
    } catch (error) {
      setTaskView(taskId, { status: "error", detail: String(error.message || error) });
      setStatus("error", "LBP ⚠ Task failed", String(error.message || error));
      try {
        await stateCall("abandon_task", { registration: registrationId, reason: "execution_failed" });
      } catch (_) { /* the daemon may already have moved on */ }
    }
  }

  // --- Result delivery -----------------------------------------------------------

  async function deliverResult(registration, result) {
    const api = adapter();
    const taskId = registration.task_id;
    const auto = daemonState?.mode === "auto_continue" && daemonState?.phase !== "stopped";

    const insertion = await api.insertResult(result, { requireEmpty: auto });
    if (!insertion.inserted) {
      await stateCall("task_delivery_status", {
        registration: registration.registration_id,
        status: insertion.reason === "composer_not_empty" ? "withheld" : "failed"
      });
      setTaskView(taskId, { delivery: insertion.reason });
      setStatus("paused", "LBP ⏸ Result not delivered",
        `${taskId} completed locally; the result is on the clipboard. Use Re-deliver result.`);
      return;
    }
    await stateCall("task_delivery_status", { registration: registration.registration_id, status: "inserted" });

    // A checkpoint result is inserted and left for the human. It is never
    // auto-submitted, and the window does not advance until it is.
    if (daemonState?.phase === "checkpoint") {
      setTaskView(taskId, { delivery: "awaiting_checkpoint" });
      setStatus("paused", "LBP ⏸ Checkpoint",
        `Result for ${taskId} is in the composer. Continue to open a new approval window.`);
      return;
    }
    if (!auto) {
      setStatus("connected", "LBP ● Result ready", `${taskId} · submit when ready.`);
      return;
    }
    await submitResult(registration, result);
  }

  async function submitResult(registration, result) {
    const api = adapter();
    const taskId = registration.task_id;
    if (!(await api.waitUntilIdle(10000))) {
      setStatus("paused", "LBP ⏸ Provider not ready", `Result for ${taskId} remains in the composer.`);
      return;
    }
    const submitted = await api.submitAndAwaitAcknowledgement(result);
    if (!submitted.submitted) {
      setStatus("paused", "LBP ⏸ Result not submitted", `${taskId}: ${submitted.reason}`);
      return;
    }
    // Only now, with a real provider turn carrying the exact stored result, is
    // delivery recorded and the checkpoint window allowed to advance.
    await stateCall("acknowledge_submission", {
      registration: registration.registration_id,
      turn_id: submitted.turnId,
      result: submitted.result
    });
    setTaskView(taskId, { delivery: "submitted" });
    setStatus("continuing", "LBP ● Continuing", `${taskId} submitted as the next user turn.`);
  }

  // --- Public actions -------------------------------------------------------------

  async function enable() {
    await ensureOwner({ takeover: true });
    await stateCall("enable");
    await configureConversation(interaction);
    setStatus("connected", "LBP ● Enabled for this chat",
      "Workflow instructions attach to your next message.");
  }

  async function stop(reason = "stopped_by_user") {
    await stateCall("stop", { reason });
  }

  async function continueCheckpoint() {
    const api = adapter();
    const entry = [...taskView.values()].reverse().find((item) => item.result);
    if (!entry) return;
    await stateCall("request_continue");
    if (!api.composerMatches(entry.result)) {
      const insertion = await api.insertResult(entry.result, { requireEmpty: false });
      if (!insertion.inserted) {
        setStatus("error", "LBP ⚠ Composer changed", "Re-deliver the result before continuing.");
        return;
      }
    }
    const registration = { registration_id: entry.registrationId, task_id: entry.taskId };
    await submitResult(registration, entry.result);
  }

  async function updateInteraction(next) {
    const normalized = { ...DEFAULT_INTERACTION, ...next };
    await ensureOwner({ takeover: true });
    await configureConversation(normalized);
    setInteraction(normalized);
    try {
      const stored = await chrome.storage.local.get("interaction");
      await chrome.storage.local.set({
        interaction: { ...(stored?.interaction || {}), ...normalized }
      });
    } catch (_) { /* settings persistence is best effort from content */ }
  }

  async function configuredContextSources() {
    const payload = await bridgeMessage({ type: "lbp-context-workspaces" });
    return Array.isArray(payload.sources) ? payload.sources : [];
  }

  async function addContextSource(source) {
    await ensureOwner({ takeover: true });
    return stateCall("add_context_source", {
      kind: "folder",
      path: source?.path,
      server: source?.server,
      label: source?.label
    });
  }

  async function chooseContextFolder() {
    const payload = await bridgeMessage({ type: "lbp-context-choose-folder" });
    if (payload.cancelled) return { cancelled: true };
    await addContextSource({ kind: "folder", path: payload.path });
    return { cancelled: false };
  }

  async function removeContextSource(sourceId) {
    await ensureOwner({ takeover: true });
    return stateCall("remove_context_source", { source_id: sourceId });
  }

  // Journal replay surfaced as a user action. This re-inserts the stored result;
  // it never re-enters MCP. Re-running work requires a newly authored task with a
  // new id, which is why there is no "Run again".
  async function redeliverResult(taskId) {
    const entry = taskView.get(taskId);
    if (!entry?.result) return;
    const insertion = await adapter().insertResult(entry.result, { requireEmpty: false });
    await stateCall("task_delivery_status", {
      registration: entry.registrationId,
      status: insertion.inserted ? "inserted" : "failed"
    });
    setStatus(insertion.inserted ? "connected" : "error",
      insertion.inserted ? "LBP ● Result re-delivered" : "LBP ⚠ Re-delivery failed", taskId);
  }

  // --- Scan pump --------------------------------------------------------------------

  let scanning = false;
  let scanPending = false;

  async function scanOnce() {
    const api = adapter();
    const turns = api.latestTurns();
    await refreshState();
    if (!daemonState) return;
    await reconcileTurns(turns);
    if (daemonState.enabled) await handleAssistantTurn(turns);
  }

  async function scan() {
    if (scanning) { scanPending = true; return; }
    scanning = true;
    try {
      do {
        scanPending = false;
        try {
          await scanOnce();
        } catch (error) {
          setStatus("error", "LBP ⚠ Coordinator error", String(error.message || error));
        }
      } while (scanPending);
    } finally {
      scanning = false;
      notify();
    }
  }

  function start() {
    const api = adapter();

    api.onBeforeUserSend(() => {
      if (!daemonState?.enabled) return;
      if (!daemonState?.workflow_attached) {
        const attached = api.prependComposerText(BOOTSTRAP_TEXT);
        if (attached?.prepended) void stateCall("workflow_attached", { attached: true });
      }
      // Arms the daemon only. The chain is created when the provider actually
      // produces the turn, so a send that never happens changes nothing.
      void stateCall("arm_human_send").catch(() => {});
    });

    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        const node = mutation.target?.nodeType === Node.ELEMENT_NODE
          ? mutation.target : mutation.target?.parentElement;
        return !node?.closest?.(".lbp-global-status, .lbp-wrap, .lbp-modal-overlay, .lbp-payload-disclosure");
      });
      if (relevant) void scan();
    });
    observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });

    // This tab just loaded, so it is the live one: claim the lease before the
    // first scan rather than waiting for the renewal interval.
    void ensureOwner({ takeover: true }).then(() => scan());
    // Low-frequency recovery fallback, not the primary workflow engine.
    setInterval(() => void scan(), 5000);
    setInterval(() => { if (!document.hidden) void ensureOwner(); }, 12000);
  }

  return Object.freeze({
    start,
    scan,
    enable,
    stop,
    continueCheckpoint,
    updateInteraction,
    configureConversation,
    configuredContextSources,
    addContextSource,
    chooseContextFolder,
    removeContextSource,
    redeliverResult,
    runTask,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    state: () => daemonState,
    stateStatus: () => stateStatus,
    status: () => bridgeStatus,
    identity: () => bridgeIdentity,
    interaction: () => interaction,
    taskViews: () => taskView,
    setInteraction,
    setIdentity: (next) => { bridgeIdentity = next; notify(); },
    setStatus,
    BOOTSTRAP_TEXT
  });
})();
