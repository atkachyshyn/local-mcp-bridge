(() => {
  const processed = new WeakSet();
  const collapsed = new WeakSet();
  const SESSION_KEY = "lbp.browser-session.v1";
  const CHAIN_KEY = "lbp.auto-chain.v1";
  const DEFAULT_INTERACTION = Object.freeze({
    mode: "manual",
    max_round_trips: 12,
    collapse_payloads: true
  });

  let interaction = { ...DEFAULT_INTERACTION };
  let activeTaskId = null;
  let chain = loadChain();
  let bridgeStatus = { kind: "checking", text: "LBP · checking local bridge…", detail: "", busy: false };
  let statusUi = null;

  function ensureStatusUi() {
    if (statusUi?.root?.isConnected) return statusUi;
    const root = document.createElement("aside");
    root.className = "lbp-global-status lbp-global-checking";
    root.setAttribute("aria-live", "polite");

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "lbp-global-pill";
    pill.setAttribute("aria-expanded", "false");
    const dot = document.createElement("span");
    dot.className = "lbp-global-dot";
    const main = document.createElement("span");
    main.className = "lbp-global-main";
    pill.append(dot, main);

    const panel = document.createElement("section");
    panel.className = "lbp-global-panel";
    panel.hidden = true;
    const detail = document.createElement("div");
    detail.className = "lbp-global-detail";
    const meta = document.createElement("div");
    meta.className = "lbp-global-meta";
    const actions = document.createElement("div");
    actions.className = "lbp-global-actions";
    const stop = document.createElement("button");
    stop.type = "button";
    stop.textContent = "Stop chain";
    stop.addEventListener("click", () => {
      stopAutoContinue();
      setBridgeStatus("paused", "LBP · auto-continue stopped", "Future local tasks in this conversation chain require manual action.");
    });
    const settings = document.createElement("button");
    settings.type = "button";
    settings.textContent = "Settings";
    settings.addEventListener("click", () => chrome.runtime.sendMessage({ type: "lbp-open-options" }));
    actions.append(stop, settings);
    panel.append(detail, meta, actions);
    root.append(pill, panel);
    pill.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      pill.setAttribute("aria-expanded", String(!panel.hidden));
    });
    document.documentElement.appendChild(root);
    statusUi = { root, pill, main, detail, meta, stop, panel };
    renderBridgeStatus();
    return statusUi;
  }

  function renderBridgeStatus() {
    const ui = ensureStatusUi();
    ui.root.className = `lbp-global-status lbp-global-${bridgeStatus.kind}`;
    ui.main.textContent = bridgeStatus.text;
    ui.detail.textContent = bridgeStatus.detail || "Local MCP Bridge browser status";
    refreshChain();
    ui.meta.textContent = `${interaction.mode === "auto_continue" ? "Auto" : "Manual"} · ${chain.roundTrips}/${interaction.max_round_trips} round trips${chain.stopped ? " · stopped" : ""}`;
    ui.stop.hidden = interaction.mode !== "auto_continue" || chain.stopped;
  }

  function setBridgeStatus(kind, text, detail = "", busy = false) {
    bridgeStatus = { kind, text, detail, busy };
    renderBridgeStatus();
  }

  async function refreshBridgeHealth() {
    if (bridgeStatus.busy) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "lbp-health" });
      if (!response?.ok) throw new Error(response?.error || "health check failed");
      const health = response.payload || {};
      setBridgeStatus("connected", `LBP ● Connected · v${health.version || "?"}`, `LBP ${health.protocols?.[0]?.versions?.[0] || "?"} · ${interaction.mode === "auto_continue" ? "auto-continue" : "manual continuation"}`);
    } catch (error) {
      setBridgeStatus("offline", "LBP ✕ Daemon offline", String(error.message || error));
    }
  }

  function browserSessionId() {
    let value = sessionStorage.getItem(SESSION_KEY);
    if (!value) {
      value = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, value);
    }
    return value;
  }

  function loadChain() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(CHAIN_KEY) || "null");
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {}
    return { anchor: null, id: null, roundTrips: 0, stopped: false };
  }

  function saveChain() {
    sessionStorage.setItem(CHAIN_KEY, JSON.stringify(chain));
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function currentHumanAnchor() {
    const hosts = globalThis.LBP_PROVIDER_ADAPTER.findResultHosts();
    for (let i = hosts.length - 1; i >= 0; i -= 1) {
      const text = (hosts[i].innerText || hosts[i].textContent || "").trim();
      if (!text || text.includes("<LBP_RESULT>")) continue;
      return `${i}:${fnv1a(text.slice(0, 8192))}`;
    }
    return "conversation-start";
  }

  function refreshChain() {
    const anchor = currentHumanAnchor();
    if (chain.anchor !== anchor) {
      chain = {
        anchor,
        id: crypto.randomUUID(),
        roundTrips: 0,
        stopped: false
      };
      saveChain();
    }
    return chain;
  }

  function stopAutoContinue() {
    refreshChain();
    chain.stopped = true;
    saveChain();
  }

  function clipText(value, limit) {
    const text = typeof value === "string" ? value.trim() : "";
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
  }

  function operationLabel(op) {
    if (op?.type === "mcp.call") return `${op.server || "local"} → ${op.tool || "?"}`;
    if (op?.type === "mcp.list_tools") return `${op.server || "local"} → tools/list`;
    if (op?.type === "mcp.observe") return `${op.server || "local"} → observe ×${Array.isArray(op.calls) ? op.calls.length : "?"}`;
    return String(op?.type || "unknown");
  }

  function classificationText(kind) {
    if (kind === "read_only") return "READ ONLY";
    if (kind === "verify") return "VERIFY";
    if (kind === "destructive") return "DESTRUCTIVE WRITE";
    if (kind === "write") return "WRITE";
    return "UNKNOWN";
  }

  function isMutationClass(kind) {
    return kind === "write" || kind === "destructive";
  }

  function operationPathChecks(op) {
    if (Array.isArray(op?.path_checks)) return op.path_checks;
    if (Array.isArray(op?.calls)) return op.calls.flatMap((call) => Array.isArray(call.path_checks) ? call.path_checks : []);
    return [];
  }

  async function loadInteractionSettings() {
    try {
      const stored = await chrome.storage.local.get("interaction");
      const raw = stored?.interaction || {};
      const mode = raw.mode === "auto_continue" ? "auto_continue" : "manual";
      const max = Number(raw.max_round_trips);
      interaction = {
        mode,
        max_round_trips: Number.isInteger(max) && max >= 1 && max <= 50 ? max : DEFAULT_INTERACTION.max_round_trips,
        collapse_payloads: raw.collapse_payloads !== false
      };
    } catch (_) {
      interaction = { ...DEFAULT_INTERACTION };
    }
  }

  function showApproval(preview) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "lbp-modal-overlay";
      const modal = document.createElement("section");
      modal.className = "lbp-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");

      const op = preview.operation || {};
      if (isMutationClass(op.classification)) modal.classList.add("lbp-modal-write");

      const top = document.createElement("div");
      top.className = "lbp-modal-top";
      const eyebrow = document.createElement("div");
      eyebrow.className = "lbp-eyebrow";
      eyebrow.textContent = "LOCAL MCP APPROVAL";
      const badge = document.createElement("span");
      badge.className = `lbp-badge lbp-badge-${op.classification || "unknown"}`;
      badge.textContent = classificationText(op.classification);
      top.append(eyebrow, badge);

      const heading = document.createElement("h3");
      heading.textContent = clipText(preview.title || preview.task_id || "Local task", 160);

      const intent = document.createElement("p");
      intent.className = "lbp-model-intent";
      intent.textContent = clipText(preview.description || "", 260) || "No model-authored description.";

      const facts = document.createElement("div");
      facts.className = "lbp-derived-facts";
      const target = document.createElement("div");
      const targetKey = document.createElement("strong");
      targetKey.textContent = "Derived target";
      const targetValue = document.createElement("code");
      targetValue.textContent = op.type === "mcp.call"
        ? `${op.server} → ${op.tool}`
        : op.type === "mcp.observe"
          ? `${op.server} → observe ${Array.isArray(op.calls) ? op.calls.length : 0} calls`
          : `${op.server} → tools/list`;
      target.append(targetKey, targetValue);
      facts.appendChild(target);

      const policy = document.createElement("div");
      const policyKey = document.createElement("strong");
      policyKey.textContent = "Approval policy";
      const policyValue = document.createElement("code");
      policyValue.textContent = `${preview.approval?.mode || "?"} · ${preview.approval?.reason || "approval required"}`;
      policy.append(policyKey, policyValue);
      facts.appendChild(policy);

      for (const check of operationPathChecks(op)) {
          const line = document.createElement("div");
          const strong = document.createElement("strong");
          strong.textContent = "Resolved path";
          const code = document.createElement("code");
          code.textContent = `${check.path}  ⊂  ${check.root}`;
          line.append(strong, code);
          facts.appendChild(line);
      }

      const argsTitle = document.createElement("div");
      argsTitle.className = "lbp-args-title";
      argsTitle.textContent = op.type === "mcp.call"
        ? "Arguments sent to the MCP tool"
        : op.type === "mcp.observe"
          ? "Observation group · daemon-derived classifications and arguments"
          : "No tool arguments";
      const args = document.createElement("pre");
      args.className = "lbp-args";
      args.textContent = JSON.stringify(op.type === "mcp.observe" ? op.calls || [] : op.arguments || {}, null, 2);

      const provider = document.createElement("p");
      provider.className = "lbp-provider-note";
      provider.textContent = `The tool result is returned to this conversation on ${globalThis.LBP_PROVIDER_ADAPTER.providerHost()}. In auto-continue mode the extension may submit that result as the next user turn; it cannot inject it into an assistant response already in progress.`;

      const actions = document.createElement("div");
      actions.className = "lbp-modal-actions";
      const deny = document.createElement("button");
      deny.type = "button";
      deny.className = "lbp-modal-cancel";
      deny.textContent = "Deny";
      const once = document.createElement("button");
      once.type = "button";
      once.className = "lbp-modal-approve";
      once.textContent = "Allow once";
      actions.append(deny, once);
      let session = null;
      if (preview.approval?.session_approval_available) {
        session = document.createElement("button");
        session.type = "button";
        session.className = "lbp-modal-session";
        const ttlHours = Math.max(1, Math.round(Number(preview.approval?.session_ttl_seconds || 0) / 3600));
        const scope = op.classification === "read_only"
          ? "reads"
          : op.classification === "verify"
            ? "reads + verification"
            : op.classification === "destructive"
              ? "destructive operations"
              : "writes";
        session.textContent = `Allow all ${scope} to ${op.server || "server"} for ${ttlHours} h`;
        actions.appendChild(session);
      }

      let settled = false;
      function done(value) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", keyHandler);
        overlay.remove();
        resolve(value);
      }
      const keyHandler = (event) => { if (event.key === "Escape") done("deny"); };
      deny.addEventListener("click", () => done("deny"));
      once.addEventListener("click", () => done("once"));
      session?.addEventListener("click", () => done("session"));
      overlay.addEventListener("click", (event) => { if (event.target === overlay) done("deny"); });
      document.addEventListener("keydown", keyHandler);

      modal.append(top, heading, intent, facts, argsTitle, args, provider, actions);
      overlay.appendChild(modal);
      document.documentElement.appendChild(overlay);
      once.focus();
    });
  }

  function hideIsolatedPayload(host, marker, label) {
    if (!interaction.collapse_payloads) return;
    for (const pre of host.querySelectorAll("pre")) {
      if (collapsed.has(pre)) continue;
      const text = pre.innerText || pre.textContent || "";
      if (!text.includes(marker)) continue;
      collapsed.add(pre);
      pre.hidden = true;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "lbp-payload-chip";
      chip.textContent = label;
      chip.title = "Show/hide protocol payload";
      chip.addEventListener("click", () => {
        pre.hidden = !pre.hidden;
        chip.textContent = pre.hidden ? label : "Hide protocol payload";
      });
      pre.parentNode?.insertBefore(chip, pre);
    }
  }

  function collapseRenderedPayloads() {
    if (!interaction.collapse_payloads) return;
    for (const host of globalThis.LBP_PROVIDER_ADAPTER.findTaskHosts()) {
      hideIsolatedPayload(host, "<LBP_TASK>", "Local MCP task · payload hidden");
      hideIsolatedPayload(host, "<LBP_TASK_V1>", "Local MCP task · payload hidden");
      hideIsolatedPayload(host, "<ATLAS_TASK_V1>", "Local MCP task · payload hidden");
    }
    for (const host of globalThis.LBP_PROVIDER_ADAPTER.findResultHosts()) {
      hideIsolatedPayload(host, "<LBP_RESULT>", "Local MCP result · payload hidden");
    }
  }

  function resultTaskIds() {
    const ids = new Set();
    for (const host of globalThis.LBP_PROVIDER_ADAPTER.findResultHosts()) {
      const results = globalThis.LBP.extractResults(host.innerText || host.textContent || "");
      for (const result of results) {
        if (typeof result?.task_id === "string" && result.task_id) ids.add(result.task_id);
      }
    }
    return ids;
  }

  async function approveLocally(task, decision) {
    const response = await chrome.runtime.sendMessage({
      type: "lbp-approve",
      task,
      sessionId: browserSessionId(),
      decision
    });
    if (!response?.ok) throw new Error(response?.error || "Local approval failed");
    return response.payload;
  }

  async function deliverResult(task, result, status) {
    const envelope = globalThis.LBP.resultEnvelope(result);
    refreshChain();
    const wantsAuto = interaction.mode === "auto_continue" && !chain.stopped;
    const atLimit = chain.roundTrips >= interaction.max_round_trips;
    const requireEmpty = wantsAuto && !atLimit;
    const insertion = await globalThis.LBP_PROVIDER_ADAPTER.insertResult(envelope, { requireEmpty });

    if (!insertion?.inserted) {
      if (wantsAuto && insertion?.reason === "composer_not_empty") {
        try { await navigator.clipboard.writeText(envelope); } catch (_) {}
        status.textContent = "Auto-continue paused · composer contains your draft · local result copied to clipboard";
        setBridgeStatus("paused", "LBP ⏸ Paused · user draft detected", `Result for ${task.id} copied to clipboard.`);
      } else {
        status.textContent = insertion?.copied
          ? "Done · result copied to clipboard"
          : "Done · could not insert result automatically";
        setBridgeStatus("error", "LBP ⚠ Result delivery needs attention", `Task ${task.id} completed locally but browser insertion was not automatic.`);
      }
      return { autoSubmitted: false };
    }

    if (!wantsAuto) {
      status.textContent = result.status === "unknown"
        ? "Unknown execution state · result is in the composer · do not blindly retry"
        : "Done · result ready in composer";
      setBridgeStatus(result.status === "unknown" ? "error" : "connected", result.status === "unknown" ? "LBP ⚠ Unknown write state" : "LBP ● Done · result ready", `Task ${task.id} · manual continuation`);
      return { autoSubmitted: false };
    }

    if (atLimit) {
      chain.stopped = true;
      saveChain();
      status.textContent = `Auto-continue stopped at ${interaction.max_round_trips} local round trips · result is ready in composer`;
      setBridgeStatus("paused", `LBP ⏸ Round-trip limit ${interaction.max_round_trips}`, `Task ${task.id} result is ready in the composer.`);
      return { autoSubmitted: false };
    }

    if (activeTaskId !== task.id || result.task_id !== task.id) {
      stopAutoContinue();
      status.textContent = "Auto-continue stopped · local result/task correlation changed";
      setBridgeStatus("error", "LBP ⚠ Correlation changed", `Auto-continue stopped for ${task.id}.`);
      return { autoSubmitted: false };
    }

    const ready = await globalThis.LBP_PROVIDER_ADAPTER.waitUntilIdle(10000);
    if (!ready || !globalThis.LBP_PROVIDER_ADAPTER.canSubmit()) {
      status.textContent = "Auto-continue paused · provider composer is not safely submit-ready";
      setBridgeStatus("paused", "LBP ⏸ Provider not submit-ready", `Result for ${task.id} is in the composer.`);
      return { autoSubmitted: false };
    }
    if (!globalThis.LBP_PROVIDER_ADAPTER.composerMatches(envelope)) {
      stopAutoContinue();
      status.textContent = "Auto-continue stopped · composer changed after the local result was inserted";
      setBridgeStatus("error", "LBP ⚠ Composer changed", `Auto-continue stopped for ${task.id}.`);
      return { autoSubmitted: false };
    }

    const submitted = await globalThis.LBP_PROVIDER_ADAPTER.submitComposer(envelope);
    if (!submitted?.submitted) {
      status.textContent = "Auto-continue paused · result is ready in composer but was not submitted";
      setBridgeStatus("paused", "LBP ⏸ Result not submitted", `Task ${task.id} result remains in the composer.`);
      return { autoSubmitted: false };
    }

    chain.roundTrips += 1;
    if (result.status === "unknown") chain.stopped = true;
    saveChain();
    status.textContent = result.status === "unknown"
      ? `Unknown execution state · result sent to assistant · automatic chain stopped (${chain.roundTrips}/${interaction.max_round_trips})`
      : `Done · continued automatically · ${chain.roundTrips}/${interaction.max_round_trips}`;
    setBridgeStatus(result.status === "unknown" ? "error" : "continuing", result.status === "unknown" ? "LBP ⚠ Unknown write state · stopped" : `LBP ● Continuing · ${chain.roundTrips}/${interaction.max_round_trips}`, `Completed ${task.id}; result submitted as the next user turn.`);
    return { autoSubmitted: true };
  }

  async function executeTask(task, approvalToken, status, button) {
    status.textContent = "Running locally…";
    setBridgeStatus("running", `LBP ◌ Running · ${operationLabel(task.operation)}`, task.title || task.id, true);
    const response = await chrome.runtime.sendMessage({
      type: "lbp-run",
      task,
      sessionId: browserSessionId(),
      approvalToken: approvalToken || null
    });
    if (!response?.ok) throw new Error(response?.error || "Local task failed");
    const result = response.payload.result;
    await deliverResult(task, result, status);
    if (button) {
      button.hidden = false;
      button.textContent = "Run again";
    }
  }

  function makeTaskUI(host, task, { autoStart = false, alreadyCompleted = false } = {}) {
    const wrap = document.createElement("div");
    wrap.className = "lbp-wrap";

    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "lbp-settings";
    settings.title = "Local MCP server settings";
    settings.setAttribute("aria-label", "Local MCP server settings");
    settings.textContent = "⚙";
    settings.addEventListener("click", () => chrome.runtime.sendMessage({ type: "lbp-open-options" }));

    const eyebrow = document.createElement("div");
    eyebrow.className = "lbp-eyebrow";
    eyebrow.textContent = "LOCAL MCP";

    const heading = document.createElement("div");
    heading.className = "lbp-heading";
    heading.textContent = clipText(task.title || task.id || "Local task", 160);

    const details = document.createElement("details");
    details.className = "lbp-details";
    const summary = document.createElement("summary");
    summary.textContent = clipText(task.description || operationLabel(task.operation), 160);
    const tech = document.createElement("code");
    tech.className = "lbp-operation-tech";
    tech.textContent = task.operation ? operationLabel(task.operation) : "invalid task";
    details.append(summary, tech);

    const actions = document.createElement("div");
    actions.className = "lbp-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lbp-run";
    button.hidden = true;
    button.textContent = task.action_label || "Review local action";
    actions.appendChild(button);

    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "lbp-stop";
    stop.textContent = "Stop auto-continue";
    stop.hidden = interaction.mode !== "auto_continue";
    stop.addEventListener("click", () => {
      stopAutoContinue();
      stop.hidden = true;
      status.textContent = "Auto-continue stopped for this conversation chain";
      setBridgeStatus("paused", "LBP ⏸ Auto-continue stopped", "This conversation chain will not auto-submit further local results.");
    });
    actions.appendChild(stop);

    const status = document.createElement("div");
    status.className = "lbp-status";
    wrap.append(settings, eyebrow, heading, details, actions, status);
    host.appendChild(wrap);

    if (task.__parse_error) {
      button.hidden = false;
      button.disabled = true;
      button.textContent = "Task parse error";
      status.textContent = task.__parse_error;
      return;
    }

    if (alreadyCompleted) {
      button.hidden = true;
      status.textContent = "Completed · matching local result already exists in this conversation";
      return;
    }

    let currentPreview = null;
    let approvalFlowOpen = false;

    async function reviewAndRun() {
      if (approvalFlowOpen) return;
      approvalFlowOpen = true;
      button.disabled = true;
      try {
        if (!currentPreview) {
          const response = await chrome.runtime.sendMessage({
            type: "lbp-preview",
            task,
            sessionId: browserSessionId()
          });
          if (!response?.ok) throw new Error(response?.error || "Local policy rejected the task");
          currentPreview = response.payload.preview;
        }
        const decision = await showApproval(currentPreview);
        if (decision === "deny") {
          stopAutoContinue();
          status.textContent = "Not run · auto-continue stopped for this chain";
          setBridgeStatus("paused", "LBP ⏸ Local action denied", task.title || task.id);
          button.hidden = false;
          return;
        }
        const approval = await approveLocally(task, decision);
        status.textContent = approval.session_granted ? "Session approval granted · running…" : "Approved once · running…";
        setBridgeStatus("running", `LBP ◌ Approved · ${operationLabel(task.operation)}`, task.title || task.id, true);
        activeTaskId = task.id;
        await executeTask(task, approval.approval_token, status, button);
        currentPreview = null;
      } catch (error) {
        status.textContent = `Error: ${String(error.message || error)}`;
        setBridgeStatus("error", "LBP ⚠ Local task error", String(error.message || error));
        button.hidden = false;
      } finally {
        activeTaskId = null;
        button.disabled = false;
        approvalFlowOpen = false;
      }
    }

    async function preflightAndMaybeRun({ forceReview = false } = {}) {
      if (activeTaskId && activeTaskId !== task.id) {
        button.hidden = false;
        status.textContent = "Another local task is already active";
        return;
      }
      button.disabled = true;
      status.textContent = "Checking local policy…";
      setBridgeStatus("checking", `LBP ◌ Checking · ${operationLabel(task.operation)}`, task.title || task.id, true);
      try {
        const response = await chrome.runtime.sendMessage({
          type: "lbp-preview",
          task,
          sessionId: browserSessionId()
        });
        if (!response?.ok) throw new Error(response?.error || "Local policy rejected the task");
        currentPreview = response.payload.preview;
        wrap.classList.toggle("lbp-mutating", isMutationClass(currentPreview.operation?.classification));
        if (!currentPreview.approval?.required && !forceReview) {
          button.hidden = true;
          status.textContent = `Allowed by local policy · ${classificationText(currentPreview.operation?.classification)}`;
          setBridgeStatus("running", `LBP ◌ ${classificationText(currentPreview.operation?.classification)} · ${operationLabel(task.operation)}`, task.title || task.id, true);
          activeTaskId = task.id;
          try {
            await executeTask(task, null, status, button);
          } finally {
            activeTaskId = null;
          }
          return;
        }
        button.hidden = false;
        button.textContent = currentPreview.approval?.required
          ? (task.action_label || "Review local action")
          : "Review & run again";
        status.textContent = currentPreview.approval?.required
          ? "Local approval required"
          : "Local policy allows automatic execution";
        setBridgeStatus(currentPreview.approval?.required ? "approval" : "connected", currentPreview.approval?.required ? `LBP ⚠ Approval required · ${operationLabel(task.operation)}` : "LBP ● Allowed by local policy", `${classificationText(currentPreview.operation?.classification)} · ${task.title || task.id}`);
        if (autoStart && currentPreview.approval?.required && !forceReview) {
          await reviewAndRun();
        }
      } catch (error) {
        button.hidden = false;
        status.textContent = `Error: ${String(error.message || error)}`;
      } finally {
        button.disabled = false;
      }
    }

    button.addEventListener("click", async () => {
      if (!currentPreview) {
        await preflightAndMaybeRun({ forceReview: true });
        if (!currentPreview) return;
      }
      await reviewAndRun();
    });

    if (autoStart) {
      globalThis.LBP_PROVIDER_ADAPTER.waitUntilIdle(30000).then((idle) => {
        if (!idle) {
          button.hidden = false;
          status.textContent = "Provider did not reach a safe idle state · review manually";
          setBridgeStatus("paused", "LBP ⏸ Provider still generating", task.title || task.id);
          return;
        }
        preflightAndMaybeRun();
      });
    } else {
      button.hidden = false;
      status.textContent = "Historical or non-latest task · review manually";
    }
  }

  function scan() {
    refreshChain();
    collapseRenderedPayloads();
    const completed = resultTaskIds();
    const markers = globalThis.LBP.ENVELOPES.map((e) => e.start);
    const hosts = globalThis.LBP_PROVIDER_ADAPTER.findTaskHosts();
    const candidates = [];
    for (const host of hosts) {
      if (processed.has(host)) continue;
      const text = host.innerText || "";
      if (!markers.some((m) => text.includes(m))) continue;
      const tasks = globalThis.LBP.extractTasks(text);
      if (!tasks.length) continue;
      candidates.push({ host, tasks });
    }
    const latestAssistantHost = hosts.length ? hosts[hosts.length - 1] : null;
    const latestMessageHost = globalThis.LBP_PROVIDER_ADAPTER.findLastMessageHost?.() || null;
    for (const { host, tasks } of candidates) {
      // Never validate or execute a snapshot of an assistant message that is still streaming.
      if (host === latestAssistantHost && globalThis.LBP_PROVIDER_ADAPTER.isGenerating()) continue;
      processed.add(host);
      if (tasks.length !== 1) {
        makeTaskUI(host, {
          __parse_error: "Exactly one LBP task is allowed per assistant message; split local calls across turns."
        });
      } else {
        const task = tasks[0];
        makeTaskUI(host, task, {
          autoStart: host === latestAssistantHost && host === latestMessageHost && !completed.has(task.id) && !chain.stopped,
          alreadyCompleted: completed.has(task.id)
        });
      }
      collapseRenderedPayloads();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.interaction) return;
    loadInteractionSettings().then(() => { renderBridgeStatus(); scan(); });
  });

  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  loadInteractionSettings().then(() => {
    ensureStatusUi();
    refreshBridgeHealth();
    scan();
    setInterval(scan, 2500);
    setInterval(() => { if (!document.hidden) refreshBridgeHealth(); }, 30000);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshBridgeHealth();
  });
})();
