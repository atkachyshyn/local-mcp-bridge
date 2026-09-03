(() => {
  const processed = new WeakSet();
  const SESSION_KEY = "lbp.browser-session.v1";
  const CHAIN_KEY = "lbp.auto-chain.v2";
  const WORKFLOW_KEY = "lbp.chat-workflow.v1";
  const DEFAULT_INTERACTION = Object.freeze({
    mode: "manual",
    max_round_trips: 12,
    status_surface: "panel",
    show_protocol_payloads: false
  });
  const MAX_TIMELINE = 64;
  const BOOTSTRAP_TEXT = [
    "<LBP_WORKFLOW>",
    "Local MCP Bridge is enabled for this conversation and uses LBP 1.3 with backward-compatible LBP 1.2 support.",
    "When local work is useful, emit exactly one fenced text code block containing one <LBP_TASK> JSON envelope and keep explanatory prose outside that block.",
    "Use mcp.observe for 1–8 same-server READ/VERIFY calls. Use mcp.mutate for 1–8 same-server WRITE/DESTRUCTIVE calls that form one bounded logical mutation batch; calls execute in order and stop on first failure, with no implied rollback. Use mcp.call for a single call.",
    "Never self-declare classification or authority. The local daemon derives policy, roots, VERIFY, approvals, and execution.",
    "LBP results return as real user turns inside <LBP_RESULT>. Treat those turns as local tool results and continue automatically only while the next local operation is clearly defined without new human judgment.",
    "If progress requires the user to choose between alternatives, clarify intent, provide missing information, make a design/product decision, or answer a question, respond normally and emit NO <LBP_TASK>. Absence of an executable <LBP_TASK> intentionally stops the automatic round-trip chain.",
    "Security approval is separate from conversational input: approval asks whether an already-defined local operation may execute; do not use approval as a substitute for asking the user what should be done.",
    "</LBP_WORKFLOW>"
  ].join("\n");

  function conversationKey() {
    const match = location.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function loadWorkflowState() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(WORKFLOW_KEY) || "null");
      if (parsed && typeof parsed === "object") {
        return {
          enabled: parsed.enabled === true,
          active: parsed.active === true,
          conversationKey: typeof parsed.conversationKey === "string" && parsed.conversationKey ? parsed.conversationKey : null
        };
      }
    } catch (_) {}
    return { enabled: false, active: false, conversationKey: null };
  }

  function saveWorkflowState() {
    sessionStorage.setItem(WORKFLOW_KEY, JSON.stringify(workflow));
  }

  function conversationHasLbpActivity() {
    for (const host of globalThis.LBP_PROVIDER_ADAPTER.findTaskHosts()) {
      if (tasksInHost(host).some((task) => !task?.__parse_error)) return true;
    }
    for (const host of globalThis.LBP_PROVIDER_ADAPTER.findResultHosts()) {
      if (resultsInHost(host).length) return true;
      if (sourceText(host).includes("<LBP_WORKFLOW>")) return true;
    }
    return false;
  }

  function syncWorkflowConversation() {
    const current = conversationKey();

    if (!workflow.enabled && current && conversationHasLbpActivity()) {
      workflow = { enabled: true, active: true, conversationKey: current };
      saveWorkflowState();
      return workflow;
    }

    if (!workflow.enabled) return workflow;

    if (!workflow.conversationKey && current) {
      workflow.conversationKey = current;
      saveWorkflowState();
      return workflow;
    }

    if (workflow.conversationKey && current && current !== workflow.conversationKey) {
      workflow = conversationHasLbpActivity()
        ? { enabled: true, active: true, conversationKey: current }
        : { enabled: false, active: false, conversationKey: null };
      saveWorkflowState();
    }
    return workflow;
  }

  function enableWorkflowForCurrentChat() {
    workflow = {
      enabled: true,
      active: false,
      conversationKey: conversationKey()
    };
    saveWorkflowState();
    return workflow;
  }

  function markWorkflowActive() {
    workflow = {
      enabled: true,
      active: true,
      conversationKey: conversationKey() || workflow.conversationKey
    };
    saveWorkflowState();
    return workflow;
  }

  let interaction = { ...DEFAULT_INTERACTION };
  let activeTaskId = null;
  // Legacy browser state remains readable during the migration, but daemonState is
  // authoritative for workflow/chain/checkpoint state from v0.9.2 onward.
  let workflow = loadWorkflowState();
  let chain = loadChain();
  let daemonState = null;
  let daemonStateRequest = null;
  let bridgeStatus = { kind: "checking", text: "checking local bridge…", detail: "", busy: false };
  let bridgeConnection = { kind: "checking", text: "Connecting" };
  let bridgeIdentity = { bridgeVersion: null, lbpVersion: null };
  let statusUi = null;
  let timeline = new Map();
  const payloadExpandedByKey = new Map();

  async function conversationStateAction(action = "get", payload = {}) {
    const response = await chrome.runtime.sendMessage({
      type: "lbp-conversation-state",
      action,
      payload
    });
    if (!response?.ok) throw new Error(response?.error || "Local conversation state request failed");
    daemonState = response.payload?.state || null;
    renderBridgeStatus();
    return daemonState;
  }

  async function refreshConversationState() {
    if (daemonStateRequest) return daemonStateRequest;
    daemonStateRequest = conversationStateAction("get")
      .finally(() => { daemonStateRequest = null; });
    return daemonStateRequest;
  }

  async function configureConversationState() {
    return conversationStateAction("configure", {
      mode: interaction.mode,
      checkpoint_size: interaction.max_round_trips
    });
  }

  function localWorkflowState() {
    return {
      enabled: daemonState?.enabled === true,
      active: daemonState?.active === true
    };
  }

  function localApprovalWindowId() {
    return typeof daemonState?.approval_window_id === "string" ? daemonState.approval_window_id : null;
  }

  function clipText(value, limit) {
    const text = typeof value === "string" ? value.trim() : "";
    return text.length <= limit ? text : `${text.slice(0, limit)}…`;
  }

  function operationLabel(op) {
    if (op?.type === "mcp.call") return `${op.server || "local"} → ${op.tool || "?"}`;
    if (op?.type === "mcp.list_tools") return `${op.server || "local"} → tools/list`;
    if (op?.type === "mcp.observe") return `${op.server || "local"} → observe ×${Array.isArray(op.calls) ? op.calls.length : "?"}`;
    if (op?.type === "mcp.mutate") return `${op.server || "local"} → mutate ×${Array.isArray(op.calls) ? op.calls.length : "?"}`;
    return String(op?.type || "unknown");
  }

  function classificationText(kind) {
    if (kind === "read_only") return "READ";
    if (kind === "verify") return "VERIFY";
    if (kind === "destructive") return "DESTRUCTIVE";
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

  function executionLedgerKey() {
    return `${CHAIN_KEY}:executed:${conversationKey() || "unresolved"}`;
  }

  function loadExecutedTaskIds() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(executionLedgerKey()) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id) : []);
    } catch (_) {
      return new Set();
    }
  }

  function wasTaskExecuted(taskId) {
    if (typeof taskId !== "string" || !taskId) return false;
    return loadExecutedTaskIds().has(taskId);
  }

  function rememberExecutedTask(taskId) {
    if (typeof taskId !== "string" || !taskId) return;
    const ids = loadExecutedTaskIds();
    ids.add(taskId);
    sessionStorage.setItem(executionLedgerKey(), JSON.stringify([...ids].slice(-512)));
  }

  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function sourceText(node) {
    return String(node?.textContent || node?.innerText || "");
  }

  function protocolSources(host) {
    const blocks = Array.from(host?.querySelectorAll?.("pre") || []);
    return blocks.map((node) => sourceText(node));
  }

  function resultsInHost(host) {
    const found = [];
    const sources = protocolSources(host);
    if (!sources.length) sources.push(sourceText(host));
    for (const text of sources) found.push(...globalThis.LBP.extractResults(text));
    return found.filter((value) => !value?.__parse_error);
  }

  function isLbpResultHost(host) {
    if (resultsInHost(host).length) return true;
    return sourceText(host).includes("<LBP_RESULT>");
  }

  function tasksInHost(host) {
    const found = [];
    const sources = protocolSources(host);
    if (!sources.length) sources.push(sourceText(host));
    for (const text of sources) found.push(...globalThis.LBP.extractTasks(text));
    return found;
  }

  function humanChainSnapshot() {
    const hosts = globalThis.LBP_PROVIDER_ADAPTER.findAllMessageHosts?.() || [];
    let humanIndex = -1;
    let anchor = "conversation-start";
    let host = null;

    for (let i = hosts.length - 1; i >= 0; i -= 1) {
      if (hosts[i].getAttribute("data-message-author-role") !== "user") continue;
      if (isLbpResultHost(hosts[i])) continue;
      const text = sourceText(hosts[i]).trim();
      if (!text) continue;
      humanIndex = i;
      const messageId = hosts[i].getAttribute("data-message-id") ||
        hosts[i].closest?.("[data-message-id]")?.getAttribute("data-message-id") ||
        hosts[i].id || null;
      anchor = messageId ? `message:${messageId}` : `text:${fnv1a(text.slice(0, 8192))}`;
      host = hosts[i];
      break;
    }

    const taskIds = [];
    for (let i = humanIndex + 1; i < hosts.length; i += 1) {
      if (hosts[i].getAttribute("data-message-author-role") !== "assistant") continue;
      for (const task of tasksInHost(hosts[i])) {
        if (typeof task?.id === "string" && task.id && !taskIds.includes(task.id)) taskIds.push(task.id);
      }
    }
    return { anchor, taskIds, host };
  }

  function syncChainToHumanPrompt() {
    const snapshot = humanChainSnapshot();
    const hasResolvedHuman = Boolean(snapshot.host);
    const effectiveAnchor = hasResolvedHuman
      ? snapshot.anchor
      : (chain.anchor || snapshot.anchor);
    const sameAnchor = effectiveAnchor === chain.anchor;
    const existingTaskIds = Array.isArray(chain.taskIds) ? chain.taskIds : [];
    const observedTaskIds = hasResolvedHuman
      ? (snapshot.taskIds || []).filter((id) => sameAnchor
        ? existingTaskIds.includes(id) || !wasTaskExecuted(id)
        : !wasTaskExecuted(id))
      : [];
    const mergedTaskIds = sameAnchor
      ? [...new Set([...existingTaskIds, ...observedTaskIds])]
      : observedTaskIds;
    const previous = JSON.stringify(chain);
    chain = globalThis.LBP_CHAIN_STATE.recover({
      anchor: effectiveAnchor,
      id: sameAnchor ? chain.id : crypto.randomUUID(),
      taskIds: mergedTaskIds,
      stopped: sameAnchor ? chain.stopped === true : false,
      checkpointPasses: sameAnchor ? Number(chain.checkpointPasses || 0) : 0
    });
    if (JSON.stringify(chain) !== previous) saveChain();
    return { chain, snapshot: { ...snapshot, anchor: effectiveAnchor, taskIds: mergedTaskIds } };
  }

  function recoverChainFromDom() {
    return syncChainToHumanPrompt().chain;
  }

  function stopAutoContinue() {
    syncChainToHumanPrompt();
    chain = globalThis.LBP_CHAIN_STATE.stop(chain);
    saveChain();
    renderBridgeStatus();
  }

  function trimTimeline() {
    while (timeline.size > MAX_TIMELINE) {
      const first = timeline.keys().next().value;
      timeline.delete(first);
    }
  }

  function setTaskState(task, status, detail = "", classification = null) {
    if (!task?.id) return;
    const previous = timeline.get(task.id) || {};
    timeline.set(task.id, {
      ...previous,
      id: task.id,
      title: clipText(task.title || task.id, 64),
      operation: operationLabel(task.operation),
      status,
      detail: clipText(detail || "", 80),
      classification: classification || previous.classification || null,
      updatedAt: Date.now()
    });
    trimTimeline();
    renderBridgeStatus();
  }

  function timelineSymbol(status) {
    if (status === "done") return "✓";
    if (status === "error" || status === "unknown") return "!";
    if (status === "paused") return "⏸";
    if (status === "approval") return "●";
    if (status === "running" || status === "checking" || status === "continuing") return "◌";
    return "○";
  }

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
    const list = document.createElement("div");
    list.className = "lbp-task-list";
    const meta = document.createElement("div");
    meta.className = "lbp-global-meta";

    const actions = document.createElement("div");
    actions.className = "lbp-global-actions";

    const bootstrap = document.createElement("button");
    bootstrap.type = "button";
    bootstrap.textContent = "Enable Local MCP";
    bootstrap.title = "Enable Local MCP for this chat; workflow instructions will be attached to your next message";
    bootstrap.addEventListener("click", async () => {
      if (daemonState?.enabled) return;
      try {
        await conversationStateAction("enable");
      } catch (error) {
        setBridgeStatus("error", "LBP ⚠ Local state error", String(error.message || error));
      }
    });

    const protocol = document.createElement("button");
    protocol.type = "button";
    protocol.addEventListener("click", async () => {
      interaction.show_protocol_payloads = !interaction.show_protocol_payloads;
      payloadExpandedByKey.clear();
      try {
        const stored = await chrome.storage.local.get("interaction");
        await chrome.storage.local.set({
          interaction: { ...(stored?.interaction || {}), show_protocol_payloads: interaction.show_protocol_payloads }
        });
      } catch (_) {}
      applyPayloadVisibility();
      renderBridgeStatus();
    });

    const checkpoint = document.createElement("button");
    checkpoint.type = "button";
    checkpoint.hidden = true;
    checkpoint.addEventListener("click", () => continueCheckpoint());

    const stop = document.createElement("button");
    stop.type = "button";
    stop.textContent = "Stop chain";
    stop.addEventListener("click", async () => {
      pendingCheckpoint = null;
      try {
        await conversationStateAction("stop");
      } catch (error) {
        setBridgeStatus("error", "LBP ⚠ Local state error", String(error.message || error));
      }
    });

    const settings = document.createElement("button");
    settings.type = "button";
    settings.textContent = "Settings";
    settings.addEventListener("click", () => chrome.runtime.sendMessage({ type: "lbp-open-options" }));

    actions.append(bootstrap, checkpoint, protocol, stop, settings);
    panel.append(list, meta, actions);
    root.append(pill, panel);

    pill.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      pill.setAttribute("aria-expanded", String(!panel.hidden));
    });

    document.documentElement.appendChild(root);
    statusUi = { root, pill, main, detail, list, meta, bootstrap, checkpoint, stop, protocol, panel };
    return statusUi;
  }

  function currentWindowTaskIds() {
    const tasks = Array.isArray(daemonState?.tasks) ? daemonState.tasks : [];
    const window = Number(daemonState?.checkpoint_window || 0);
    return tasks
      .filter((task) => Number(task?.window || 0) === window && typeof task?.task_id === "string")
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
      .map((task) => task.task_id);
  }

  function renderTaskTimeline(ui) {
    ui.list.innerHTML = "";
    const visibleTaskIds = currentWindowTaskIds();
    const visibleSet = new Set(visibleTaskIds);
    const orderedIds = [];
    for (const host of globalThis.LBP_PROVIDER_ADAPTER.findTaskHosts()) {
      for (const task of tasksInHost(host)) {
        if (typeof task?.id === "string" && visibleSet.has(task.id) && timeline.has(task.id) && !orderedIds.includes(task.id)) orderedIds.push(task.id);
      }
    }
    const entries = [
      ...orderedIds.map((id) => timeline.get(id)).filter(Boolean),
      ...visibleTaskIds.map((id) => timeline.get(id)).filter((entry) => entry && !orderedIds.includes(entry.id))
    ];

    let index = 0;
    for (const entry of entries) {
      index += 1;
      const row = document.createElement("div");
      row.className = `lbp-task-row lbp-task-${entry.status || "queued"}`;

      const symbol = document.createElement("span");
      symbol.className = "lbp-task-symbol";
      symbol.textContent = timelineSymbol(entry.status);

      const number = document.createElement("span");
      number.className = "lbp-task-number";
      number.textContent = String(index);

      const body = document.createElement("div");
      body.className = "lbp-task-body";
      const title = document.createElement("div");
      title.className = "lbp-task-title";
      title.textContent = entry.title;
      const sub = document.createElement("div");
      sub.className = "lbp-task-sub";
      const bits = [entry.operation];
      if (entry.classification) bits.push(classificationText(entry.classification));
      if (entry.detail) bits.push(entry.detail);
      sub.textContent = bits.filter(Boolean).join(" · ");
      body.append(title, sub);

      row.append(symbol, number, body);
      ui.list.appendChild(row);
    }
    ui.list.hidden = entries.length === 0;
  }

  function renderBridgeStatus() {
    const ui = ensureStatusUi();
    const showPanel = interaction.status_surface === "panel";
    ui.root.hidden = !showPanel;
    ui.root.className = `lbp-global-status lbp-global-${bridgeConnection.kind}`;
    const identity = [];
    if (bridgeIdentity.bridgeVersion) identity.push(`Bridge v${bridgeIdentity.bridgeVersion}`);
    if (bridgeIdentity.lbpVersion) identity.push(`LBP ${bridgeIdentity.lbpVersion}`);
    ui.main.textContent = [bridgeConnection.text, ...identity].filter(Boolean).join(" · ");
    renderTaskTimeline(ui);

    const local = localWorkflowState();
    ui.bootstrap.textContent = "Enable Local MCP";
    ui.bootstrap.disabled = local.enabled;
    ui.bootstrap.hidden = local.enabled;
    ui.bootstrap.title = "Enable Local MCP for this chat";

    const workflowLabel = local.active ? "Active" : local.enabled ? "Enabled" : "Inactive";
    const modeLabel = daemonState?.mode === "auto_continue" ? "Auto" : "Manual";
    const checkpointSize = Number(daemonState?.checkpoint_size || interaction.max_round_trips);
    const windowCount = Number(daemonState?.window_task_count || 0);
    const stateLabel = daemonState?.checkpoint_pending
      ? " · checkpoint"
      : daemonState?.state === "stopped"
        ? " · stopped"
        : "";
    ui.meta.textContent = `${workflowLabel} · ${modeLabel} · ${windowCount}/${checkpointSize}${stateLabel}`;
    ui.checkpoint.hidden = !daemonState?.checkpoint_pending;
    ui.checkpoint.textContent = `Continue another ${checkpointSize}`;
    ui.stop.hidden = daemonState?.mode !== "auto_continue" || daemonState?.state === "stopped";
    ui.protocol.textContent = interaction.show_protocol_payloads ? "Hide protocol" : "Show protocol";
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
      bridgeIdentity = {
        bridgeVersion: health.version || null,
        lbpVersion: health.protocols?.[0]?.versions?.[0] || null
      };
      bridgeConnection = { kind: "connected", text: "Connected" };
      try {
        await refreshConversationState();
        await configureConversationState();
      } catch (stateError) {
        bridgeStatus = { kind: "error", text: "Local state unavailable", detail: String(stateError.message || stateError), busy: false };
      }
      renderBridgeStatus();
    } catch (error) {
      bridgeConnection = { kind: "offline", text: "Offline" };
      bridgeStatus = { kind: "offline", text: "Daemon offline", detail: String(error.message || error), busy: false };
      renderBridgeStatus();
    }
  }

  async function loadInteractionSettings() {
    try {
      const stored = await chrome.storage.local.get("interaction");
      const raw = stored?.interaction || {};
      const mode = raw.mode === "auto_continue" ? "auto_continue" : "manual";
      const max = Number(raw.max_round_trips);
      let surface = raw.status_surface;
      if (!["panel", "inline", "off"].includes(surface)) surface = "panel";
      interaction = {
        mode,
        max_round_trips: Number.isInteger(max) && max >= 1 && max <= 50 ? max : DEFAULT_INTERACTION.max_round_trips,
        status_surface: surface,
        show_protocol_payloads: raw.show_protocol_payloads === true || raw.collapse_payloads === false
      };
    } catch (_) {
      interaction = { ...DEFAULT_INTERACTION };
    }
  }

  function partialJsonString(text, key) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
    const match = String(text || "").match(pattern);
    if (!match) return null;
    try { return JSON.parse(`"${match[1]}"`); } catch (_) { return match[1]; }
  }

  function payloadSummary(text) {
    const tasks = globalThis.LBP.extractTasks(text);
    if (tasks.length === 1 && !tasks[0]?.__parse_error) {
      const task = tasks[0];
      return {
        kind: "task",
        title: clipText(task.title || task.id || "Local MCP task", 80),
        meta: operationLabel(task.operation)
      };
    }

    const results = globalThis.LBP.extractResults(text).filter((value) => !value?.__parse_error);
    if (results.length === 1) {
      const result = results[0];
      const operation = result.operation || {};
      const bits = [result.status === "ok" ? "Completed" : String(result.status || "Result")];
      if (operation.classification) bits.push(classificationText(operation.classification));
      if (Array.isArray(result.applied_mutations)) bits.push(`${result.applied_mutations.length} mutations`);
      return {
        kind: "result",
        title: clipText(result.title || result.task_id || "Local MCP result", 80),
        meta: bits.join(" · ")
      };
    }

    if (String(text || "").includes("<LBP_TASK>")) {
      const title = partialJsonString(text, "title");
      const server = partialJsonString(text, "server");
      const type = partialJsonString(text, "type");
      return {
        kind: "streaming-task",
        title: clipText(title || "Local MCP task", 80),
        meta: server && type ? `${server} → ${type.replace(/^mcp\\./, "")}` : "Composing task…"
      };
    }

    if (String(text || "").includes("<LBP_RESULT>")) {
      const title = partialJsonString(text, "title");
      const taskId = partialJsonString(text, "task_id");
      const status = partialJsonString(text, "status");
      return {
        kind: "streaming-result",
        title: clipText(title || taskId || "Local MCP result", 80),
        meta: status ? `Result · ${status}` : "Receiving result…"
      };
    }

    return { kind: "payload", title: "Local MCP technical payload", meta: "LBP protocol" };
  }

  function payloadDisclosureAnchor(pre) {
    const host = pre.closest('[data-message-author-role]');
    let node = pre;
    let candidate = pre;
    while (node.parentElement && node.parentElement !== host) {
      const parent = node.parentElement;
      const ownsThisPre = parent.querySelectorAll("pre").length === 1 && parent.querySelector("pre") === pre;
      const hasCodeControls = Boolean(parent.querySelector("button"));
      if (ownsThisPre && hasCodeControls) candidate = parent;
      node = parent;
    }
    return candidate;
  }

  function payloadIdentity(pre) {
    const text = sourceText(pre);
    const tasks = globalThis.LBP.extractTasks(text).filter((value) => !value?.__parse_error);
    if (tasks.length === 1 && tasks[0]?.id) return `task:${tasks[0].id}`;
    const results = globalThis.LBP.extractResults(text).filter((value) => !value?.__parse_error);
    if (results.length === 1 && results[0]?.task_id) return `result:${results[0].task_id}`;
    return `payload:${fnv1a(text.slice(0, 8192))}`;
  }

  function ensurePayloadDisclosure(host, pre) {
    const anchor = payloadDisclosureAnchor(pre);
    const existing = Array.from(host.querySelectorAll(".lbp-payload-disclosure"));
    let shell = existing.shift() || null;
    for (const duplicate of existing) duplicate.remove();

    if (!shell) {
      shell = document.createElement("div");
      shell.className = "lbp-payload-disclosure";

      const body = document.createElement("div");
      body.className = "lbp-payload-disclosure-body";
      const title = document.createElement("div");
      title.className = "lbp-payload-disclosure-title";
      const meta = document.createElement("div");
      meta.className = "lbp-payload-disclosure-meta";
      body.append(title, meta);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "lbp-payload-toggle";
      toggle.addEventListener("click", () => {
        const key = shell.dataset.lbpPayloadKey;
        if (!key) return;
        const currentlyExpanded = payloadExpandedByKey.has(key)
          ? payloadExpandedByKey.get(key) === true
          : interaction.show_protocol_payloads;
        payloadExpandedByKey.set(key, !currentlyExpanded);
        applyPayloadVisibility();
      });

      shell.append(body, toggle);
      anchor.parentNode?.insertBefore(shell, anchor);
    } else if (shell.nextElementSibling !== anchor) {
      anchor.parentNode?.insertBefore(shell, anchor);
    }

    const key = payloadIdentity(pre);
    shell.dataset.lbpPayloadKey = key;
    const summary = payloadSummary(sourceText(pre));
    shell.classList.toggle("lbp-payload-task", summary.kind === "task" || summary.kind === "streaming-task");
    shell.classList.toggle("lbp-payload-result", summary.kind === "result" || summary.kind === "streaming-result");
    shell.querySelector(".lbp-payload-disclosure-title").textContent = summary.title;
    shell.querySelector(".lbp-payload-disclosure-meta").textContent = summary.meta;
    return { shell, key };
  }

  function applyPayloadVisibility() {
    const markers = [
      ...globalThis.LBP.ENVELOPES.map((item) => item.start),
      globalThis.LBP.RESULT_ENVELOPE.start
    ];

    for (const host of [
      ...globalThis.LBP_PROVIDER_ADAPTER.findTaskHosts(),
      ...globalThis.LBP_PROVIDER_ADAPTER.findResultHosts()
    ]) {
      host.classList.remove("lbp-protocol-only-result");
      const protocolPres = Array.from(host.querySelectorAll("pre")).filter((pre) => {
        const text = sourceText(pre);
        return markers.some((marker) => text.includes(marker));
      });
      if (!protocolPres.length) continue;

      const canonical = protocolPres.find((pre) => payloadSummary(sourceText(pre)).kind !== "payload") ||
        protocolPres.slice().sort((a, b) => sourceText(b).length - sourceText(a).length)[0];
      const summary = payloadSummary(sourceText(canonical));
      const { shell, key } = ensurePayloadDisclosure(host, canonical);
      const streaming = summary.kind === "streaming-task" || summary.kind === "streaming-result" || summary.kind === "payload";
      const previousKind = host.dataset.lbpPayloadKind || "";
      if (!streaming && previousKind !== summary.kind && !payloadExpandedByKey.has(key)) {
        payloadExpandedByKey.set(key, false);
      }
      host.dataset.lbpPayloadKind = summary.kind;
      if (streaming) host.dataset.lbpPayloadStreaming = "1";
      else delete host.dataset.lbpPayloadStreaming;

      const expanded = streaming
        ? true
        : payloadExpandedByKey.has(key)
          ? payloadExpandedByKey.get(key) === true
          : interaction.show_protocol_payloads;

      for (const pre of protocolPres) {
        pre.hidden = false;
        pre.classList.add("lbp-protocol-payload");
        const anchor = payloadDisclosureAnchor(pre);
        anchor.classList.add("lbp-protocol-container");
        anchor.classList.toggle("lbp-protocol-collapsed", !expanded);
      }
      shell.querySelector(".lbp-payload-toggle").textContent = expanded
        ? "Hide technical payload"
        : "Show technical payload";
    }
  }

  function resultMap() {
    const results = new Map();
    for (const host of globalThis.LBP_PROVIDER_ADAPTER.findResultHosts()) {
      for (const result of resultsInHost(host)) {
        if (typeof result?.task_id === "string" && result.task_id) results.set(result.task_id, result);
      }
    }
    return results;
  }

  let activeApprovalDialog = null;

  function showApproval(preview) {
    const taskId = preview.task_id || "unknown";
    if (activeApprovalDialog?.taskId === taskId) return activeApprovalDialog.promise;
    if (activeApprovalDialog) return Promise.reject(new Error("Another Local MCP approval dialog is already active"));

    let resolveDialog;
    const promise = new Promise((resolve) => { resolveDialog = resolve; });
    activeApprovalDialog = { taskId, promise };

    const overlay = document.createElement("div");
    overlay.className = "lbp-modal-overlay";
    overlay.dataset.taskId = taskId;
    const modal = document.createElement("section");
    modal.className = "lbp-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const op = preview.operation || {};
    const approval = preview.approval || {};
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
    heading.textContent = clipText(preview.title || taskId || "Local task", 120);

    const intent = document.createElement("p");
    intent.className = "lbp-model-intent";
    intent.textContent = clipText(preview.description || "", 220) || "No model-authored description.";

    const facts = document.createElement("div");
    facts.className = "lbp-derived-facts";

    const target = document.createElement("div");
    target.innerHTML = "<strong>Target</strong>";
    const targetValue = document.createElement("code");
    targetValue.textContent = op.type === "mcp.call"
      ? `${op.server} → ${op.tool}`
      : op.type === "mcp.observe"
        ? `${op.server} → observe ${Array.isArray(op.calls) ? op.calls.length : 0} calls`
        : op.type === "mcp.mutate"
          ? `${op.server} → mutate ${Array.isArray(op.calls) ? op.calls.length : 0} bounded writes`
          : `${op.server} → tools/list`;
    target.appendChild(targetValue);
    facts.appendChild(target);

    const policy = document.createElement("div");
    policy.innerHTML = "<strong>Approval policy</strong>";
    const policyValue = document.createElement("code");
    policyValue.textContent = `${approval.mode || "?"} baseline · escalation ≤ ${approval.approval_escalation || "once"}`;
    policy.appendChild(policyValue);
    facts.appendChild(policy);

    const reason = document.createElement("div");
    reason.innerHTML = "<strong>Why now</strong>";
    const reasonValue = document.createElement("code");
    reasonValue.textContent = approval.reason || "approval required";
    reason.appendChild(reasonValue);
    facts.appendChild(reason);

    const pathChecks = operationPathChecks(op);
    if (pathChecks.length) {
      const paths = document.createElement("div");
      paths.innerHTML = "<strong>Paths</strong>";
      const pathValue = document.createElement("code");
      pathValue.textContent = pathChecks.map((check) => check.path).join("\n");
      paths.appendChild(pathValue);
      facts.appendChild(paths);
    }

    const technical = document.createElement("details");
    technical.className = "lbp-technical";
    const summary = document.createElement("summary");
    summary.textContent = "Technical details";
    const args = document.createElement("pre");
    args.className = "lbp-args";
    args.textContent = JSON.stringify(
      op.type === "mcp.observe" || op.type === "mcp.mutate" ? op.calls || [] : op.arguments || {},
      null,
      2
    );
    technical.append(summary, args);

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

    let chainButton = null;
    if (approval.chain_approval_available) {
      chainButton = document.createElement("button");
      chainButton.type = "button";
      chainButton.className = "lbp-modal-chain";
      chainButton.textContent = "Allow this chain";
      chainButton.title = `Reuse this approval through the current ${Number(daemonState?.checkpoint_size || interaction.max_round_trips)}-task checkpoint window. Continuing starts a new approval window.`;
      actions.appendChild(chainButton);
    }

    let session = null;
    if (approval.session_approval_available) {
      session = document.createElement("button");
      session.type = "button";
      session.className = "lbp-modal-session";
      const ttlHours = Math.max(1, Math.round(Number(approval.session_ttl_seconds || 0) / 3600));
      session.textContent = `Allow session · ${ttlHours} h`;
      session.title = "Allow this risk level for this browser-session scope, subject to local policy";
      actions.appendChild(session);
    }

    const actionButtons = [deny, once, chainButton, session].filter(Boolean);
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      for (const button of actionButtons) button.disabled = true;
      document.removeEventListener("keydown", keyHandler);
      overlay.style.pointerEvents = "none";
      overlay.remove();
      activeApprovalDialog = null;
      resolveDialog(value);
    }

    const keyHandler = (event) => { if (event.key === "Escape") done("deny"); };
    deny.addEventListener("click", () => done("deny"), { once: true });
    once.addEventListener("click", () => done("once"), { once: true });
    chainButton?.addEventListener("click", () => done("chain"), { once: true });
    session?.addEventListener("click", () => done("session"), { once: true });
    overlay.addEventListener("click", (event) => { if (event.target === overlay) done("deny"); });
    document.addEventListener("keydown", keyHandler);

    modal.append(top, heading, intent, facts, technical, actions);
    overlay.appendChild(modal);
    document.documentElement.appendChild(overlay);
    once.focus();
    return promise;
  }

  async function approveLocally(task, decision) {
    const response = await chrome.runtime.sendMessage({
      type: "lbp-approve",
      task,
      sessionId: browserSessionId(),
      chainId: localApprovalWindowId(),
      decision
    });
    if (!response?.ok) throw new Error(response?.error || "Local approval failed");
    return response.payload;
  }

  let pendingCheckpoint = null;

  function checkpointThrough() {
    return interaction.max_round_trips * (Number(chain.checkpointPasses || 0) + 1);
  }

  async function continueCheckpoint() {
    const pending = pendingCheckpoint;
    if (!pending || !daemonState?.checkpoint_pending) return;
    const { task, result, statusNode, envelope } = pending;

    const ready = await globalThis.LBP_PROVIDER_ADAPTER.waitUntilIdle(10000);
    if (!ready || !globalThis.LBP_PROVIDER_ADAPTER.canSubmit()) {
      setBridgeStatus("paused", "LBP ⏸ Provider not submit-ready", `Result for ${task.id} remains in the composer.`);
      return;
    }
    if (!globalThis.LBP_PROVIDER_ADAPTER.composerMatches(envelope)) {
      pendingCheckpoint = null;
      await conversationStateAction("stop");
      setTaskState(task, "error", "composer changed at checkpoint", result.operation?.classification);
      setBridgeStatus("error", "LBP ⚠ Composer changed", `Checkpoint continuation stopped for ${task.id}.`);
      return;
    }

    await conversationStateAction("continue");
    const submitted = await globalThis.LBP_PROVIDER_ADAPTER.submitComposer(envelope);
    if (!submitted?.submitted) {
      await conversationStateAction("stop");
      setBridgeStatus("paused", "LBP ⏸ Result not submitted", `Task ${task.id} result remains in the composer.`);
      return;
    }

    pendingCheckpoint = null;
    const unknown = result.status === "unknown";
    if (unknown) await conversationStateAction("stop");
    statusNode.textContent = unknown ? "Unknown execution state · chain stopped" : "Done · checkpoint continued";
    setTaskState(task, unknown ? "unknown" : "done", unknown ? "automatic chain stopped" : "checkpoint continued", result.operation?.classification);
    renderBridgeStatus();
  }

  async function deliverResult(task, result, statusNode) {
    const envelope = globalThis.LBP.resultEnvelope(result);
    const daemonStatus = result.status === "unknown" ? "unknown" : result.status === "ok" ? "completed" : "error";
    await conversationStateAction("task_status", { task_id: task.id, status: daemonStatus });
    const wantsAuto = daemonState?.mode === "auto_continue" && daemonState?.state !== "stopped";
    const insertion = await globalThis.LBP_PROVIDER_ADAPTER.insertResult(envelope, { requireEmpty: wantsAuto });

    if (!insertion?.inserted) {
      if (wantsAuto && insertion?.reason === "composer_not_empty") {
        try { await navigator.clipboard.writeText(envelope); } catch (_) {}
        statusNode.textContent = "Paused · composer contains your draft";
        setTaskState(task, "paused", "user draft detected", result.operation?.classification);
        setBridgeStatus("paused", "LBP ⏸ Paused · user draft detected", `Result for ${task.id} copied to clipboard.`);
      } else {
        statusNode.textContent = insertion?.copied ? "Done · result copied" : "Done · result delivery needs attention";
        setTaskState(task, "error", "result delivery needs attention", result.operation?.classification);
        setBridgeStatus("error", "LBP ⚠ Result delivery needs attention", `Task ${task.id} completed locally but browser insertion was not automatic.`);
      }
      return { autoSubmitted: false };
    }

    if (!wantsAuto) {
      const unknown = result.status === "unknown";
      statusNode.textContent = unknown ? "Unknown execution state · result ready in composer" : "Done · result ready in composer";
      setTaskState(task, unknown ? "unknown" : "done", "manual continuation", result.operation?.classification);
      setBridgeStatus(unknown ? "error" : "connected", unknown ? "LBP ⚠ Unknown write state" : "LBP ● Done · result ready", `Task ${task.id} · manual continuation`);
      return { autoSubmitted: false };
    }

    if (activeTaskId !== task.id || result.task_id !== task.id) {
      stopAutoContinue();
      statusNode.textContent = "Stopped · result/task correlation changed";
      setTaskState(task, "error", "correlation changed", result.operation?.classification);
      setBridgeStatus("error", "LBP ⚠ Correlation changed", `Auto-continue stopped for ${task.id}.`);
      return { autoSubmitted: false };
    }

    if (daemonState?.checkpoint_pending) {
      pendingCheckpoint = { task, result, statusNode, envelope };
      const count = Number(daemonState?.window_task_count || 0);
      const size = Number(daemonState?.checkpoint_size || interaction.max_round_trips);
      statusNode.textContent = `Checkpoint · ${count}/${size}`;
      setTaskState(task, "paused", "continuation checkpoint", result.operation?.classification);
      renderBridgeStatus();
      return { autoSubmitted: false };
    }

    const ready = await globalThis.LBP_PROVIDER_ADAPTER.waitUntilIdle(10000);
    if (!ready || !globalThis.LBP_PROVIDER_ADAPTER.canSubmit()) {
      statusNode.textContent = "Paused · provider not submit-ready";
      setTaskState(task, "paused", "provider not submit-ready", result.operation?.classification);
      setBridgeStatus("paused", "LBP ⏸ Provider not submit-ready", `Result for ${task.id} is in the composer.`);
      return { autoSubmitted: false };
    }
    if (!globalThis.LBP_PROVIDER_ADAPTER.composerMatches(envelope)) {
      stopAutoContinue();
      statusNode.textContent = "Stopped · composer changed";
      setTaskState(task, "error", "composer changed", result.operation?.classification);
      setBridgeStatus("error", "LBP ⚠ Composer changed", `Auto-continue stopped for ${task.id}.`);
      return { autoSubmitted: false };
    }

    const submitted = await globalThis.LBP_PROVIDER_ADAPTER.submitComposer(envelope);
    if (!submitted?.submitted) {
      statusNode.textContent = "Paused · result not submitted";
      setTaskState(task, "paused", "result remains in composer", result.operation?.classification);
      setBridgeStatus("paused", "LBP ⏸ Result not submitted", `Task ${task.id} result remains in the composer.`);
      return { autoSubmitted: false };
    }

    const unknown = result.status === "unknown";
    if (unknown) chain = globalThis.LBP_CHAIN_STATE.stop(chain);
    saveChain();
    statusNode.textContent = unknown ? "Unknown execution state · chain stopped" : `Done · continued automatically · ${chain.roundTrips} tasks`;
    setTaskState(task, unknown ? "unknown" : "done", unknown ? "automatic chain stopped" : "continued automatically", result.operation?.classification);
    setBridgeStatus(
      unknown ? "error" : "continuing",
      unknown ? "LBP ⚠ Unknown write state · stopped" : `LBP ● Continuing · ${chain.roundTrips} tasks`,
      `Completed ${task.id}; result submitted as the next user turn.`
    );
    return { autoSubmitted: true };
  }

  async function executeTask(task, approvalToken, statusNode, button) {
    statusNode.textContent = "Running locally…";
    setTaskState(task, "running", "", timeline.get(task.id)?.classification);
    setBridgeStatus("running", `LBP ◌ Running · ${operationLabel(task.operation)}`, task.title || task.id, true);

    const response = await chrome.runtime.sendMessage({
      type: "lbp-run",
      task,
      sessionId: browserSessionId(),
      chainId: localApprovalWindowId(),
      approvalToken: approvalToken || null
    });
    if (!response?.ok) throw new Error(response?.error || "Local task failed");
    const result = response.payload.result;
    rememberExecutedTask(task.id);
    await deliverResult(task, result, statusNode);
    if (button) {
      button.hidden = false;
      button.textContent = "Run again";
    }
  }

  function makeTaskUI(host, task, { autoStart = false, alreadyCompleted = false, result = null } = {}) {
    let wrap = null;
    let button = document.createElement("button");
    button.type = "button";
    let statusNode = document.createElement("div");

    if (interaction.status_surface === "inline") {
      wrap = document.createElement("div");
      wrap.className = "lbp-wrap";

      const eyebrow = document.createElement("div");
      eyebrow.className = "lbp-eyebrow";
      eyebrow.textContent = "LOCAL MCP";

      const heading = document.createElement("div");
      heading.className = "lbp-heading";
      heading.textContent = clipText(task.title || task.id || "Local task", 120);

      const operation = document.createElement("div");
      operation.className = "lbp-operation-tech";
      operation.textContent = operationLabel(task.operation);

      const actions = document.createElement("div");
      actions.className = "lbp-actions";
      button.className = "lbp-run";
      button.hidden = true;
      button.textContent = task.action_label || "Review local action";
      actions.appendChild(button);

      statusNode.className = "lbp-status";
      wrap.append(eyebrow, heading, operation, actions, statusNode);
      host.appendChild(wrap);
    }

    if (task.__parse_error) {
      statusNode.textContent = task.__parse_error;
      setBridgeStatus("error", "LBP ⚠ Task parse error", task.__parse_error);
      return;
    }

    setTaskState(task, alreadyCompleted ? (result?.status === "ok" ? "done" : (result?.status || "done")) : (autoStart ? "checking" : "queued"), alreadyCompleted ? "matching result found" : "");

    if (alreadyCompleted) {
      statusNode.textContent = "Completed";
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
            sessionId: browserSessionId(),
      chainId: localApprovalWindowId()
          });
          if (!response?.ok) throw new Error(response?.error || "Local policy rejected the task");
          currentPreview = response.payload.preview;
        }

        setTaskState(task, "approval", "local approval required", currentPreview.operation?.classification);
        const decision = await showApproval(currentPreview);
        if (decision === "deny") {
          stopAutoContinue();
          statusNode.textContent = "Not run";
          setTaskState(task, "paused", "denied", currentPreview.operation?.classification);
          setBridgeStatus("paused", "LBP ⏸ Local action denied", task.title || task.id);
          button.hidden = false;
          return;
        }

        const approval = await approveLocally(task, decision);
        const grantedScope = approval.session_granted
          ? "session"
          : approval.chain_granted
            ? "chain"
            : "once";
        const grantedLabel = grantedScope === "session"
          ? "Session approval granted"
          : grantedScope === "chain"
            ? "Approved until your next message"
            : "Approved once";
        statusNode.textContent = `${grantedLabel} · running…`;
        setTaskState(task, "running", `${grantedScope} approved`, currentPreview.operation?.classification);
        activeTaskId = task.id;
        await executeTask(task, approval.approval_token, statusNode, button);
        currentPreview = null;
      } catch (error) {
        statusNode.textContent = `Error: ${String(error.message || error)}`;
        setTaskState(task, "error", String(error.message || error), currentPreview?.operation?.classification);
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
        statusNode.textContent = "Another local task is active";
        setTaskState(task, "queued", "waiting for active task");
        return;
      }

      button.disabled = true;
      statusNode.textContent = "Checking local policy…";
      setTaskState(task, "checking", "");
      setBridgeStatus("checking", `LBP ◌ Checking · ${operationLabel(task.operation)}`, task.title || task.id, true);

      try {
        const response = await chrome.runtime.sendMessage({
          type: "lbp-preview",
          task,
          sessionId: browserSessionId(),
      chainId: localApprovalWindowId()
        });
        if (!response?.ok) throw new Error(response?.error || "Local policy rejected the task");
        currentPreview = response.payload.preview;
        wrap?.classList.toggle("lbp-mutating", isMutationClass(currentPreview.operation?.classification));

        if (!currentPreview.approval?.required && !forceReview) {
          statusNode.textContent = `Allowed · ${classificationText(currentPreview.operation?.classification)}`;
          setTaskState(task, "running", "allowed by local policy", currentPreview.operation?.classification);
          activeTaskId = task.id;
          try {
            await executeTask(task, null, statusNode, button);
          } finally {
            activeTaskId = null;
          }
          return;
        }

        button.hidden = false;
        button.textContent = currentPreview.approval?.required
          ? (task.action_label || "Review local action")
          : "Review & run again";
        statusNode.textContent = currentPreview.approval?.required ? "Local approval required" : "Allowed by local policy";

        if (currentPreview.approval?.required) {
          setTaskState(task, "approval", "local approval required", currentPreview.operation?.classification);
          setBridgeStatus("approval", `LBP ⚠ Approval required · ${operationLabel(task.operation)}`, `${classificationText(currentPreview.operation?.classification)} · ${task.title || task.id}`);
          if (autoStart && !forceReview) await reviewAndRun();
        } else {
          setTaskState(task, "queued", "manual review", currentPreview.operation?.classification);
        }
      } catch (error) {
        statusNode.textContent = `Error: ${String(error.message || error)}`;
        setTaskState(task, "error", String(error.message || error));
        setBridgeStatus("error", "LBP ⚠ Local policy error", String(error.message || error));
        button.hidden = false;
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
          statusNode.textContent = "Provider did not reach a safe idle state";
          setTaskState(task, "paused", "provider still generating");
          setBridgeStatus("paused", "LBP ⏸ Provider still generating", task.title || task.id);
          return;
        }
        preflightAndMaybeRun();
      });
    } else if (interaction.status_surface === "inline") {
      button.hidden = false;
      statusNode.textContent = "Historical or non-latest task";
    }
  }

  const settleAttempts = new WeakMap();

  function retryUnsettledTask(source) {
    const attempt = (settleAttempts.get(source) || 0) + 1;
    settleAttempts.set(source, attempt);
    if (attempt > 8) return;
    const delay = Math.min(100 + (attempt * 50), 500);
    setTimeout(() => scheduleScan(), delay);
  }

  async function scan() {
    const snapshot = humanChainSnapshot();
    applyPayloadVisibility();
    try { await refreshConversationState(); } catch (_) {}

    const completed = resultMap();
    const markers = globalThis.LBP.ENVELOPES.map((e) => e.start);
    const hosts = globalThis.LBP_PROVIDER_ADAPTER.findTaskHosts();
    const discoveredIds = Array.isArray(snapshot.taskIds) ? snapshot.taskIds : [];
    const currentTaskId = snapshot.host && discoveredIds.length ? discoveredIds[discoveredIds.length - 1] : null;

    for (const host of hosts) {
      for (const source of host.querySelectorAll("pre")) {
        if (processed.has(source)) continue;
        const text = sourceText(source);
        if (!markers.some((marker) => text.includes(marker))) continue;
        const tasks = globalThis.LBP.extractTasks(text);
        if (!tasks.length) continue;

        if (tasks.length !== 1) {
          processed.add(source);
          setBridgeStatus("error", "LBP ⚠ Multiple tasks in one message", "Exactly one LBP task is allowed per assistant message.");
          continue;
        }

        const task = tasks[0];
        const result = completed.get(task.id) || null;
        const isCurrentDiscovery = task.id === currentTaskId;

        if (isCurrentDiscovery && !result && globalThis.LBP_PROVIDER_ADAPTER.isGenerating()) {
          retryUnsettledTask(source);
          continue;
        }

        let registration = "historical";
        let known = Array.isArray(daemonState?.tasks)
          ? daemonState.tasks.find((entry) => entry?.task_id === task.id) || null
          : null;

        if (isCurrentDiscovery && !result && daemonState?.enabled && daemonState?.active && daemonState?.state === "active") {
          try {
            const state = await conversationStateAction("register_task", { task_id: task.id, title: task.title || task.id });
            registration = state?.registration || "known";
            known = state?.task || known;
          } catch (error) {
            setBridgeStatus("error", "LBP ⚠ Task registration failed", String(error.message || error));
          }
        }

        settleAttempts.delete(source);
        processed.add(source);
        const daemonCompleted = known && ["completed", "error", "unknown"].includes(known.status);
        makeTaskUI(host, task, {
          autoStart: registration === "new" && !result && daemonState?.state === "active",
          alreadyCompleted: Boolean(result) || Boolean(daemonCompleted),
          result
        });
      }
    }

    applyPayloadVisibility();
    renderBridgeStatus();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.interaction) return;
    loadInteractionSettings().then(async () => {
      payloadExpandedByKey.clear();
      applyPayloadVisibility();
      try { await configureConversationState(); } catch (_) {}
      renderBridgeStatus();
      scan();
    });
  });

  let scanScheduled = false;

  function isBridgeUiNode(node) {
    if (!node) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(
      element?.closest?.(".lbp-global-status, .lbp-wrap, .lbp-modal-overlay, .lbp-payload-disclosure")
    );
  }

  function mutationIsBridgeUiOnly(mutation) {
    if (isBridgeUiNode(mutation.target)) return true;
    const changed = [...mutation.addedNodes, ...mutation.removedNodes];
    return changed.length > 0 && changed.every(isBridgeUiNode);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    queueMicrotask(() => {
      scanScheduled = false;
      scan();
    });
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.length && mutations.every(mutationIsBridgeUiOnly)) return;
    scheduleScan();
  });
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });

  globalThis.LBP_PROVIDER_ADAPTER.onBeforeUserSend(() => {
    const local = localWorkflowState();
    if (!local.enabled) return;

    if (!local.active) {
      const attached = globalThis.LBP_PROVIDER_ADAPTER.prependComposerText(BOOTSTRAP_TEXT);
      if (!attached?.prepended) {
        setBridgeStatus("paused", "LBP ⏸ Enabled for this chat", "Workflow instructions could not be attached; Local MCP is not Active yet.");
        return;
      }
    }

    // This callback only fires for genuine human sends; pure auto-submitted
    // LBP_RESULT turns are filtered by the provider adapter. A fresh opaque anchor
    // therefore starts exactly one new daemon-owned request chain.
    void conversationStateAction("human_prompt", { anchor: crypto.randomUUID() })
      .catch((error) => setBridgeStatus("error", "LBP ⚠ Local state error", String(error.message || error)));
  });

  loadInteractionSettings().then(() => {
    syncWorkflowConversation();
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
