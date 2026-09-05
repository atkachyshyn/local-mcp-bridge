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
    unknown_recovery: "manual",
    status_surface: "panel"
  });

  const BOOTSTRAP_TEXT = [
    "```",
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

  const MAX_INLINE_RESULT_BYTES = 48 * 1024;
  const MAX_CACHED_INLINE_RESULTS = 8;

  // Per-task UI state that is presentation only. Never used for any execution
  // decision -- those all read daemon state. Never put complete MCP result
  // bodies in taskView.
  const taskView = new Map();

  // Ephemeral, non-reactive cache used only for small results that still
  // need to be inserted/submitted to the provider. The daemon journal
  // remains authoritative.
  const resultCache = new Map();

  const observedUserTurns = new Set();
  const settledAssistantTurns = new Set();
  const handledAssistantTasks = new Set();
  const deliveringRegistrations = new Set();
  let pendingHumanTurnBaseline = null;

  function logTransport(event, detail = {}) {
    try { console.debug("[LBP transport]", event, detail); } catch (_) { /* debug only */ }
  }

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
    // taskView is presentation state only. Never allow raw MCP result bodies
    // to enter reactive UI state, even if a caller accidentally passes one.
    const safePatch = { ...(patch || {}) };
    delete safePatch.result;
    taskView.set(taskId, { ...(taskView.get(taskId) || {}), ...safePatch });
    notify();
  }

  function resultSizeBytes(result) {
    const serialized = JSON.stringify(result);
    if (typeof serialized !== "string") {
      throw new Error("LBP result could not be serialized");
    }
    return new TextEncoder().encode(serialized).byteLength;
  }

  function cacheInlineResult(taskId, result, bytes = null) {
    if (!taskId) return false;
    const size = Number.isFinite(bytes) ? bytes : resultSizeBytes(result);
    if (size > MAX_INLINE_RESULT_BYTES) {
      resultCache.delete(taskId);
      return false;
    }
    // Refresh insertion order when replacing an existing entry.
    resultCache.delete(taskId);
    resultCache.set(taskId, result);
    while (resultCache.size > MAX_CACHED_INLINE_RESULTS) {
      const oldest = resultCache.keys().next().value;
      if (oldest === undefined) break;
      resultCache.delete(oldest);
    }
    return true;
  }

  function formatResultBytes(bytes) {
    if (!Number.isFinite(bytes)) return "unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }

  async function withholdOversizedResult(registration, resultBytes) {
    const taskId = registration?.task_id;
    const registrationId = registration?.registration_id;

    if (taskId) {
      resultCache.delete(taskId);
      setTaskView(taskId, { resultBytes, delivery: "oversized" });
    }

    // Execution already happened successfully. Failure to record delivery
    // metadata must never turn this into an execution failure.
    if (registrationId) {
      const pending = taskId ? currentPendingRegistrationFor({ task_id: taskId }) : null;
      if (pending?.deliveryStatus !== "withheld") {
        try {
          await stateCall("task_delivery_status", { registration: registrationId, status: "withheld" });
        } catch (error) {
          logTransport("oversized_delivery_status_failed", {
            task_id: taskId,
            registration_id: registrationId,
            error: String(error?.stack || error?.message || error)
          });
        }
      }
    }

    logTransport("result_oversized", {
      task_id: taskId,
      registration_id: registrationId,
      result_bytes: resultBytes,
      inline_limit_bytes: MAX_INLINE_RESULT_BYTES
    });

    setStatus(
      "paused",
      "LBP ⏸ Result too large for inline delivery",
      `${taskId} · ${formatResultBytes(resultBytes)} · inline limit ${formatResultBytes(MAX_INLINE_RESULT_BYTES)}. ` +
        "The complete result remains in the daemon journal."
    );
  }

  function setInteraction(next) {
    interaction = { ...DEFAULT_INTERACTION, ...next };
    notify();
  }

  function setStateStatus(kind, detail = "") {
    stateStatus = { kind, detail };
    notify();
  }

  function sameTurnId(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    return `msg:${left}` === right || left === `msg:${right}`;
  }

  function turnIdSet(turns, role) {
    return new Set((turns?.[role] || []).map((turn) => turn.id).filter(Boolean));
  }

  function deliveryFrom(registration, result, meta = {}) {
    const taskId = registration?.task_id || result?.task_id || meta.task_id || meta.taskId;
    const pending = taskId ? currentPendingRegistrationFor({ task_id: taskId }) : null;
    const view = taskId ? taskView.get(taskId) : null;
    const deliveryId = meta.delivery_id || meta.deliveryId || pending?.deliveryId || view?.deliveryId;
    return {
      result,
      task_id: taskId,
      taskId,
      delivery_id: deliveryId,
      deliveryId,
      result_digest: meta.result_digest || meta.resultDigest || pending?.resultDigest || view?.resultDigest || null,
      resultDigest: meta.result_digest || meta.resultDigest || pending?.resultDigest || view?.resultDigest || null,
      conversation_id: daemonState?.conversation_id || null
    };
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
        ? Math.floor(checkpoint) : DEFAULT_INTERACTION.max_round_trips,
      unknown_recovery: next.unknown_recovery === "auto_continue" ? "auto_continue" : "manual"
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

  async function reconcileSubmittedResultTurn(turns) {
    const api = adapter();

    // Recover the delivery transition even when the automatic send path failed
    // and the person pressed Enter manually. This must happen BEFORE
    // observe_user_turn, otherwise a bridge result can be mistaken for a new
    // human chain and reset checkpoint progress.
    const pending = currentPendingRegistrationFor();
    if (!pending?.registrationId || !pending?.deliveryId) return false;
    // Result content is deliberately not required here. Correlation uses
    // daemon-owned task/delivery metadata, not the cached result body.
    const delivery = deliveryFrom(
      { registration_id: pending.registrationId, task_id: pending.taskId },
      null,
      pending
    );
    if (pending.deliveryStatus === "observed" && pending.observedTurnId) {
      const all = turns.all || [];
      const observedIndex = all.findIndex((turn) => turn.role === "user" && sameTurnId(turn.id, pending.observedTurnId));
      const confirmingAssistant = observedIndex >= 0
        ? all.slice(observedIndex + 1).find((turn) => turn.role === "assistant" && turn.id)
        : null;
      if (!confirmingAssistant) return false;
      try {
        await stateCall("acknowledge_submission", {
          registration: pending.registrationId,
          turn_id: pending.observedTurnId,
          delivery_id: delivery.delivery_id,
          result_digest: delivery.result_digest
        });
        setTaskView(pending.taskId, {
          taskId: pending.taskId,
          registrationId: pending.registrationId,
          deliveryId: delivery.delivery_id,
          resultDigest: delivery.result_digest,
          delivery: "submitted"
        });
        resultCache.delete(pending.taskId);
        logTransport("result_acknowledged", {
          task_id: pending.taskId,
          registration_id: pending.registrationId,
          turn_id: pending.observedTurnId,
          delivery_id: delivery.delivery_id,
          confirming_assistant_turn_id: confirmingAssistant.id
        });
        if (
          pending.executionStatus === "unknown" &&
          daemonState?.unknown_recovery === "auto_continue" &&
          daemonState?.phase === "stopped" &&
          daemonState?.stopped_reason === "unknown_mutation_state"
        ) {
          await stateCall("acknowledge_unknown", { registration: pending.registrationId });
          setTaskView(pending.taskId, {
            status: "unknown",
            detail: "Ambiguous result acknowledged automatically"
          });
          logTransport("unknown_acknowledge_auto_success", {
            task_id: pending.taskId,
            registration_id: pending.registrationId
          });
        }
        return true;
      } catch (error) {
        setStatus("paused", "LBP ⏸ Result confirmation failed", String(error.message || error));
        return false;
      }
    }

    for (const turn of turns.user || []) {
      if (!turn.id || sameTurnId(turn.id, daemonState?.last_user_turn_id)) continue;
      if (!api.textContainsDelivery(api.sourceText(turn.host), delivery)) continue;
      try {
        await stateCall("observe_submission", {
          registration: pending.registrationId,
          turn_id: turn.id,
          delivery_id: delivery.delivery_id,
          result_digest: delivery.result_digest
        });
        setTaskView(pending.taskId, {
          taskId: pending.taskId,
          registrationId: pending.registrationId,
          deliveryId: delivery.delivery_id,
          resultDigest: delivery.result_digest,
          delivery: "observed"
        });
        observedUserTurns.add(turn.id);
        logTransport("result_user_turn_observed", {
          task_id: pending.taskId,
          registration_id: pending.registrationId,
          turn_id: turn.id,
          delivery_id: delivery.delivery_id
        });
        return true;
      } catch (error) {
        setStatus("paused", "LBP ⏸ Result observation failed", String(error.message || error));
        return false;
      }
    }
    return false;
  }

  function currentPendingRegistrationFor(result = null) {
    const current = daemonState?.current_registration;
    const tasks = Array.isArray(daemonState?.recent_tasks) ? daemonState.recent_tasks : [];
    const candidates = tasks
      .filter((task) => task?.registration_id && task.delivery_status !== "submitted")
      .filter((task) => ["completed", "error", "unknown"].includes(task.execution_status));
    const task = result
      ? (candidates.find((item) => item.registration_id === current && item.task_id === result.task_id)
        || candidates.find((item) => item.task_id === result.task_id))
      : candidates.find((item) => item.registration_id === current);
    if (!task) return null;
    return {
      registrationId: task.registration_id,
      taskId: task.task_id,
      executionStatus: task.execution_status,
      deliveryStatus: task.delivery_status,
      deliveryId: task.delivery_id || task.deliveryId || null,
      resultDigest: task.result_digest || task.resultDigest || null,
      observedTurnId: task.observed_turn_id || task.observedTurnId || null
    };
  }

  async function reconcileTurns(turns) {
    const userCandidates = (turns.user || []).filter((turn) =>
      turn.id
      && !observedUserTurns.has(turn.id)
      && !sameTurnId(turn.id, daemonState?.last_user_turn_id)
    );
    let observedUser = null;
    if (daemonState?.pending_human_send && pendingHumanTurnBaseline?.userIds) {
      observedUser = userCandidates.find((turn) => !pendingHumanTurnBaseline.userIds.has(turn.id));
    } else {
      observedUser = userCandidates[0] || null;
    }

    if (observedUser?.id) {
      // The daemon decides what this turn means. An unarmed turn -- one scrolled
      // into view, produced by another tab, or a bridge result -- can never start
      // a chain, so virtualization cannot resurrect a historical chain.
      await stateCall("observe_user_turn", { turn_id: observedUser.id });
      observedUserTurns.add(observedUser.id);
    }
  }

  function assistantCandidates(turns) {
    const assistantIdsAtSend = pendingHumanTurnBaseline?.assistantIds;

    return (turns.assistant || []).filter((turn) => {
      if (!turn.id) {
        logTransport("assistant_skipped", {
          reason: "missing_turn_id"
        });
        return false;
      }

      if (settledAssistantTurns.has(turn.id)) {
        logTransport("assistant_skipped", {
          turn_id: turn.id,
          reason: "already_settled"
        });
        return false;
      }

      if (assistantIdsAtSend?.has(turn.id)) {
        logTransport("assistant_skipped", {
          turn_id: turn.id,
          reason: "present_in_send_baseline"
        });
        return false;
      }

      logTransport("assistant_candidate", {
        turn_id: turn.id
      });

      return true;
    });
  }

  async function handleAssistantTurn(turn) {
    logTransport("assistant_seen", {
      turn_id: turn?.id,
      generating: adapter().isGenerating()
    });

    const api = adapter();

    if (!turn) return;

    if (api.isGenerating()) {
      logTransport("assistant_waiting_for_settle", {
        turn_id: turn.id
      });
      return;
    }

    if (!settledAssistantTurns.has(turn.id)) {
      settledAssistantTurns.add(turn.id);

      logTransport("assistant_turn_settled", {
        turn_id: turn.id
      });
    }

    if (!sameTurnId(turn.id, daemonState?.last_assistant_turn_id)) {
      await stateCall("observe_assistant_turn", {
        turn_id: turn.id
      });
    }

    const taskState = api.assistantTaskState(turn.host);

    if (taskState.kind === "none") {
      // One logical assistant response may surface as multiple provider turns.
      // Prose-only segments are therefore not evidence that the active LBP
      // chain has ended: a later physical assistant turn may carry the task.
      // Keep the send baseline as well, so historical assistant turns remain
      // excluded while we wait for that task-bearing turn.
      logTransport("assistant_no_task_ignored", {
        turn_id: turn.id,
        phase: daemonState?.phase
      });
      return;
    }

    if (taskState.kind === "multiple") {
      setStatus(
        "paused",
        "LBP ⚠ Multiple tasks in one reply",
        `${taskState.count} LBP tasks found; exactly one is allowed.`
      );

      return;
    }

    if (taskState.kind === "malformed") {
      setStatus(
        "paused",
        "LBP ⚠ Malformed task",
        String(taskState.error || "")
      );

      return;
    }

    logTransport("task_candidate_found", {
      turn_id: turn.id,
      task_id: taskState.task.id,
      plan_id: taskState.task.plan_id || taskState.task.plan?.id || null,
      plan_item_id: taskState.task.plan_item_id || null
    });

    const taskKey =
      `${turn.id}\n${taskState.fingerprint || globalThis.LBP.canonicalJson(taskState.task)}`;

    if (handledAssistantTasks.has(taskKey)) {
      return;
    }

    if (
      ["stopped", "disabled"].includes(
        daemonState?.phase
      )
    ) {
      return;
    }

    let registration;

    try {
      logTransport("task_register_attempt", {
        turn_id: turn.id,
        task_id: taskState.task.id,
        phase: daemonState?.phase,
        last_assistant_turn_id: daemonState?.last_assistant_turn_id
      });

      const state = await stateCall("register_task", {
        assistant_turn_id: turn.id,
        task: taskState.task
      });

      /*
      * IMPORTANT:
      * stateCall("register_task") returns the updated daemon
      * conversation state. The actual task registration is state.task.
      *
      * Assign it BEFORE trying to log registration fields.
      */
      registration = state?.task;

      if (
        !registration?.registration_id ||
        !registration?.task_id
      ) {
        throw new Error(
          "register_task returned no task registration"
        );
      }

      logTransport("task_register_success", {
        turn_id: turn.id,
        task_id: registration.task_id,
        registration_id: registration.registration_id,
        execution_status: registration.execution_status
      });

      /*
      * Only mark this assistant task handled after we have a
      * valid registration object from the daemon.
      */
      handledAssistantTasks.add(taskKey);

      logTransport("task_registered", {
        task_id: registration.task_id,
        registration_id: registration.registration_id,
        status: registration.execution_status
      });

      setTaskView(taskState.task.id, {
        taskId: taskState.task.id,
        title: taskState.task.title || taskState.task.id,
        operation: taskState.task.operation,
        registrationId: registration.registration_id,
        status: registration.execution_status
      });
    } catch (error) {
      logTransport("task_register_failed", {
        turn_id: turn.id,
        task_id: taskState.task.id,
        error: String(
          error?.stack ||
          error?.message ||
          error
        ),
        phase: daemonState?.phase
      });

      const message = String(
        error?.message || error
      );

      /*
      * Do NOT mark taskKey handled here.
      *
      * An unexpected coordinator/runtime failure after the daemon
      * accepted registration must remain recoverable.
      */
      setStatus(
        "paused",
        "LBP ⏸ Task registration pipeline failed",
        message
      );

      return;
    }

    if (registration.execution_status === "registered") {
      await runTask(registration);
    }
  }

  async function handleAssistantTurns(turns) {
    for (const turn of assistantCandidates(turns)) {
      if (["stopped", "disabled"].includes(daemonState?.phase)) return;
      await handleAssistantTurn(turn);
      if (daemonState?.phase !== "awaiting_assistant" && daemonState?.phase !== "task_registered") return;
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

      // Local spinner only. Execution status belongs to the daemon, which moves
      // the journal registered -> executing -> terminal itself; reporting
      // "running" here first is what made the daemon refuse the dispatch.
      setTaskView(taskId, { status: "running" });
      setStatus("running", "LBP ◌ Running locally…", taskId, true);
      logTransport("task_execute_started", { task_id: taskId, registration_id: registrationId });

      const response = await chrome.runtime.sendMessage({
        type: "lbp-run", registration: registrationId, approvalToken: token
      });
      if (!response?.ok) throw new Error(response?.error || "local task failed");
      const result = response.payload.result;

      // Measure before the result is put into any presentation state or
      // provider composer path.
      const resultBytes = resultSizeBytes(result);
      const delivery = deliveryFrom(registration, result, response.payload);

      // Execution status and delivery status are separate facts. This records
      // only what the local operation did; whether the result ever reached the
      // provider is recorded later, and only when it actually happens.
      const executionStatus = result.status === "ok" ? "completed"
        : result.status === "unknown" ? "unknown" : "error";
      await stateCall("task_execution_status", { registration: registrationId, status: executionStatus });
      const pending = currentPendingRegistrationFor({ task_id: taskId });
      const boundDelivery = deliveryFrom(registration, result, pending || delivery);
      // Metadata only. Do NOT put `result` into taskView -- see setTaskView.
      setTaskView(taskId, {
        status: executionStatus,
        deliveryId: boundDelivery.delivery_id,
        resultDigest: boundDelivery.result_digest,
        resultBytes
      });
      logTransport("result_ready", {
        task_id: taskId, registration_id: registrationId, status: result.status, result_bytes: resultBytes
      });

      // Hard browser safety boundary. Large results never reach presentation
      // or the ChatGPT composer.
      if (resultBytes > MAX_INLINE_RESULT_BYTES) {
        await withholdOversizedResult(registration, resultBytes);
        return;
      }

      // Only small results may be retained transiently in browser memory.
      cacheInlineResult(taskId, result, resultBytes);

      await deliverResult(registration, result, { ...boundDelivery, resultBytes });
    } catch (error) {
      setTaskView(taskId, { status: "error", detail: String(error.message || error) });
      setStatus("error", "LBP ⚠ Task failed", String(error.message || error));
      try {
        await stateCall("abandon_task", { registration: registrationId, reason: "execution_failed" });
      } catch (_) { /* the daemon may already have moved on */ }
    }
  }

  // --- Result delivery -----------------------------------------------------------

  async function deliverResult(registration, result, deliveryMeta = {}) {
    const api = adapter();
    const taskId = registration.task_id;
    const registrationId = registration.registration_id;

    const resultBytes = Number.isFinite(deliveryMeta?.resultBytes)
      ? deliveryMeta.resultBytes
      : Number.isFinite(deliveryMeta?.result_bytes)
        ? deliveryMeta.result_bytes
        : resultSizeBytes(result);

    // Defense in depth. No caller may bypass the inline transport ceiling,
    // even on a recovery/re-delivery path that reaches this function directly.
    if (resultBytes > MAX_INLINE_RESULT_BYTES) {
      await withholdOversizedResult(registration, resultBytes);
      return;
    }

    cacheInlineResult(taskId, result, resultBytes);

    const delivery = deliveryFrom(registration, result, deliveryMeta);
    if (deliveringRegistrations.has(registrationId)) return;
    deliveringRegistrations.add(registrationId);
    try {
      const auto = daemonState?.mode === "auto_continue" && daemonState?.phase !== "stopped";

      const insertion = await api.insertResult(result, delivery);
      if (!insertion.inserted) {
        await stateCall("task_delivery_status", {
          registration: registrationId,
          status: insertion.reason === "composer_not_empty" ? "withheld" : "failed"
        });
        setTaskView(taskId, { delivery: insertion.reason });
        logTransport("delivery_timeout", { task_id: taskId, registration_id: registrationId, reason: insertion.reason });
        setStatus("paused", "LBP ⏸ Result not delivered",
          `${taskId} completed locally; the result is on the clipboard. Use Re-deliver result.`);
        return;
      }
      await stateCall("task_delivery_status", { registration: registrationId, status: "inserted" });

      // A checkpoint result is inserted and left for the human. It is never
      // auto-submitted, and the window does not advance until it is.
      if (!auto) {
        setStatus("connected", "LBP ● Result ready", `${taskId} · submit when ready.`);
        return;
      }
      await submitResult(registration, result, delivery);
    } finally {
      deliveringRegistrations.delete(registrationId);
    }
  }

  async function submitResult(registration, result, deliveryMeta = {}) {
    const api = adapter();
    const taskId = registration.task_id;
    const delivery = deliveryFrom(registration, result, deliveryMeta);
    if (!(await api.waitUntilIdle(10000))) {
      setStatus("paused", "LBP ⏸ Provider not ready", `Result for ${taskId} remains in the composer.`);
      return;
    }
    const submitted = await api.submitAndAwaitAcknowledgement(delivery);
    if (!submitted.submitted) {
      logTransport("delivery_timeout", {
        task_id: taskId,
        registration_id: registration.registration_id,
        reason: submitted.reason
      });
      setStatus("paused", "LBP ⏸ Result not submitted", `${taskId}: ${submitted.reason}`);
      return;
    }
    // A matching DOM user turn proves only that ChatGPT rendered the send locally.
    // It is not persistence proof: the conversation write can still fail after
    // optimistic rendering. Persist this intermediate observation and keep the
    // journal result until a later assistant turn confirms provider acceptance.
    await stateCall("observe_submission", {
      registration: registration.registration_id,
      turn_id: submitted.turnId,
      delivery_id: delivery.delivery_id,
      result_digest: delivery.result_digest
    });
    logTransport("result_submission_observed", {
      task_id: taskId,
      registration_id: registration.registration_id,
      turn_id: submitted.turnId,
      delivery_id: delivery.delivery_id
    });
    setTaskView(taskId, {
      delivery: "observed",
      deliveryId: delivery.delivery_id,
      resultDigest: delivery.result_digest
    });
    setStatus("continuing", "LBP ● Awaiting provider confirmation", `${taskId} appeared as a user turn; waiting for the provider response.`);
    logTransport("next_assistant_wait", { task_id: taskId });
  }

  async function fetchStoredDelivery(registrationId) {
    const response = await chrome.runtime.sendMessage({
      type: "lbp-run", registration: registrationId, approvalToken: null
    });
    if (!response?.ok) throw new Error(response?.error || "stored result replay failed");
    const result = response.payload.result;
    const resultBytes = resultSizeBytes(result);
    return {
      result,
      result_bytes: resultBytes,
      resultBytes,
      delivery_id: response.payload.delivery_id || null,
      result_digest: response.payload.result_digest || null
    };
  }

  async function recoverPendingDelivery() {
    if (daemonState?.phase !== "result_ready") return;
    const pending = currentPendingRegistrationFor();
    if (!pending || deliveringRegistrations.has(pending.registrationId)) return;

    // Withheld results wait for explicit human recovery. Observed results have
    // already appeared as a user turn and must never be blindly re-delivered;
    // they wait for reconcileSubmittedResultTurn() to see provider confirmation.
    if (pending.deliveryStatus === "withheld" || pending.deliveryStatus === "observed") {
      setTaskView(pending.taskId, {
        taskId: pending.taskId,
        registrationId: pending.registrationId,
        status: pending.executionStatus,
        delivery: taskView.get(pending.taskId)?.delivery || pending.deliveryStatus,
        deliveryId: pending.deliveryId,
        resultDigest: pending.resultDigest
      });
      return;
    }

    const api = adapter();
    let result = resultCache.get(pending.taskId) || null;
    let deliveryMeta = pending;
    if (!result) {
      const replay = await fetchStoredDelivery(pending.registrationId);
      const resultBytes = replay.resultBytes;
      if (resultBytes > MAX_INLINE_RESULT_BYTES) {
        await withholdOversizedResult(
          { registration_id: pending.registrationId, task_id: pending.taskId },
          resultBytes
        );
        return;
      }
      result = replay.result;
      deliveryMeta = replay;
      cacheInlineResult(pending.taskId, result, resultBytes);
      setTaskView(pending.taskId, {
        taskId: pending.taskId,
        registrationId: pending.registrationId,
        status: pending.executionStatus,
        deliveryId: replay.delivery_id,
        resultDigest: replay.result_digest,
        resultBytes
      });
      logTransport("result_ready", {
        task_id: pending.taskId,
        registration_id: pending.registrationId,
        status: result.status,
        result_bytes: resultBytes,
        recovery: "journal_replay"
      });
    }

    const registration = {
      registration_id: pending.registrationId,
      task_id: pending.taskId
    };
    const delivery = deliveryFrom(registration, result, deliveryMeta);
    if (pending.deliveryStatus === "inserted" && api.composerHoldsDelivery(delivery)) {
      if (daemonState?.mode === "auto_continue") {
        await submitResult(registration, result, delivery);
      }
      return;
    }
    await deliverResult(registration, result, deliveryMeta);
  }

  // --- Public actions -------------------------------------------------------------

  async function enable() {
    const baseline = adapter().providerTurnIdSnapshot();

    pendingHumanTurnBaseline = {
      userIds: baseline.userIds,
      assistantIds: baseline.assistantIds
    };

    await ensureOwner({ takeover: true });
    await stateCall("enable");
    await configureConversation(interaction);

    setStatus(
      "connected",
      "LBP ● Enabled for this chat",
      "Workflow instructions attach to your next message."
    );
  }

  async function stop(reason = "stopped_by_user") {
    await stateCall("stop", { reason });
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

  async function acknowledgeUnknown() {
    const registrationId = daemonState?.current_registration;
    const taskId = daemonState?.current_task_id;

    logTransport("unknown_acknowledge_clicked", {
      task_id: taskId || null,
      registration_id: registrationId || null,
      phase: daemonState?.phase || null,
      stopped_reason: daemonState?.stopped_reason || null
    });

    if (
      daemonState?.phase !== "stopped" ||
      daemonState?.stopped_reason !== "unknown_mutation_state" ||
      !registrationId
    ) {
      setStatus("paused", "LBP ⏸ Nothing to acknowledge", "No unknown mutation is awaiting acknowledgement.");
      return;
    }

    try {
      await stateCall("acknowledge_unknown", { registration: registrationId });
      logTransport("unknown_acknowledge_success", {
        task_id: taskId || null,
        registration_id: registrationId,
        phase: daemonState?.phase || null
      });

      if (taskId) {
        setTaskView(taskId, {
          status: "unknown",
          detail: "Ambiguous result acknowledged by user"
        });
      }

      setStatus(
        "continuing",
        "LBP ● Unknown state acknowledged",
        "The ambiguous task was not retried or marked successful. The chain may continue with a new task."
      );

      await scan();
    } catch (error) {
      logTransport("unknown_acknowledge_failed", {
        task_id: taskId || null,
        registration_id: registrationId || null,
        error: String(error?.message || error)
      });
      setStatus(
        "error",
        "LBP ⚠ Unknown acknowledgement failed",
        String(error?.message || error)
      );
    }
  }

  // Journal replay surfaced as a user action. This re-inserts the stored result;
  // it never re-enters MCP. Re-running work requires a newly authored task with a
  // new id, which is why there is no "Run again".
  async function redeliverResult(taskId) {
    const pending = currentPendingRegistrationFor({ task_id: taskId });
    if (!pending) return;

    const registration = { registration_id: pending.registrationId, task_id: pending.taskId };
    let result = resultCache.get(taskId) || null;
    let deliveryMeta = pending;

    if (!result) {
      const replay = await fetchStoredDelivery(pending.registrationId);
      if (replay.resultBytes > MAX_INLINE_RESULT_BYTES) {
        await withholdOversizedResult(registration, replay.resultBytes);
        return;
      }
      result = replay.result;
      deliveryMeta = replay;
      cacheInlineResult(taskId, result, replay.resultBytes);
      setTaskView(taskId, {
        taskId,
        registrationId: pending.registrationId,
        resultBytes: replay.resultBytes,
        deliveryId: replay.delivery_id,
        resultDigest: replay.result_digest
      });
    }

    const delivery = deliveryFrom(registration, result, deliveryMeta);
    const insertion = await adapter().insertResult(result, delivery);
    await stateCall("task_delivery_status", {
      registration: pending.registrationId,
      status: insertion.inserted ? "inserted" : "failed"
    });
    setTaskView(taskId, { delivery: insertion.inserted ? "inserted" : "failed" });
    setStatus(insertion.inserted ? "connected" : "error",
      insertion.inserted ? "LBP ● Result re-delivered" : "LBP ⚠ Re-delivery failed", taskId);
  }

  // --- Scan pump --------------------------------------------------------------------

  let scanning = false;
  let scanPending = false;

  async function scanOnce() {
    const api = adapter();
    await refreshState();
    if (!daemonState) return;
    const turns = await api.providerTurns({ conversationId: daemonState.conversation_id });
    // logTransport("scan_snapshot", {
    //   phase: daemonState?.phase,
    //   enabled: daemonState?.enabled,
    //   pending_human_send: daemonState?.pending_human_send,
    //   last_user_turn_id: daemonState?.last_user_turn_id,
    //   last_assistant_turn_id: daemonState?.last_assistant_turn_id,
    //   user_turns: (turns.user || []).map((t) => t.id),
    //   assistant_turns: (turns.assistant || []).map((t) => t.id)
    // });
    await reconcileSubmittedResultTurn(turns);
    await reconcileTurns(turns);
    await recoverPendingDelivery();
    await handleAssistantTurns(turns);
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

  function mutationTouchesProviderMessage(mutation) {
    const target = mutation.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target?.parentElement;

    if (target?.closest?.("[data-message-author-role][data-message-id]")) {
      return true;
    }

    for (const node of mutation.addedNodes || []) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      if (
        node.matches?.("[data-message-author-role][data-message-id]") ||
        node.querySelector?.("[data-message-author-role][data-message-id]")
      ) {
        return true;
      }
    }

    return false;
  }

  function start() {
    const api = adapter();

    api.onBeforeUserSend((event) => {
      if (daemonState?.enabled !== true) return;

      const pending = currentPendingRegistrationFor();

      if (
        pending?.deliveryId &&
        api.textContainsDelivery(event?.text || "", pending)
      ) {
        return;
      }

      const baseline = api.providerTurnIdSnapshot();

      logTransport("human_send_baseline", {
        user_ids: [...baseline.userIds],
        assistant_ids: [...baseline.assistantIds]
      });

      pendingHumanTurnBaseline = {
        userIds: baseline.userIds,
        assistantIds: baseline.assistantIds
      };

      if (
        daemonState?.enabled &&
        !daemonState?.workflow_attached
      ) {
        daemonState = {
          ...daemonState,
          workflow_attached: true
        };

        const attached = api.prependComposerText(
          BOOTSTRAP_TEXT
        );

        if (attached?.prepended) {
          void stateCall("workflow_attached", {
            attached: true
          });
        }
      }

      void stateCall("arm_human_send")
        .then((state) => {
          logTransport("human_send_armed", {
            phase: state?.phase,
            pending_human_send:
              state?.pending_human_send
          });
        })
        .catch((error) => {
          logTransport("human_send_arm_failed", {
            error: String(
              error?.message || error
            )
          });
        });
    });

    /*
    * Coalesce bursts of provider DOM mutations.
    *
    * ChatGPT can produce hundreds of mutations while streaming
    * one assistant turn. They should wake the coordinator once,
    * not create a tight scan loop.
    */
    let mutationScanTimer = null;

    function scheduleProviderScan() {
      if (mutationScanTimer !== null) {
        return;
      }

      mutationScanTimer = setTimeout(() => {
        mutationScanTimer = null;
        void scan();
      }, 100);
    }

    const observer = new MutationObserver(
      (mutations) => {
        if (
          mutations.some(
            mutationTouchesProviderMessage
          )
        ) {
          scheduleProviderScan();
        }
      }
    );

    observer.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true
    });

    /*
    * Claim this tab before first reconciliation.
    */
    void ensureOwner({
      takeover: true
    }).then(() => scan());

    /*
    * Recovery only. This is not the primary event source.
    */
    setInterval(() => {
      void scan();
    }, 5000);

    setInterval(() => {
      if (!document.hidden) {
        void ensureOwner();
      }
    }, 12000);
  }

  return Object.freeze({
    start,
    scan,
    enable,
    stop,
    updateInteraction,
    configureConversation,
    configuredContextSources,
    addContextSource,
    chooseContextFolder,
    removeContextSource,
    acknowledgeUnknown,
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
