// Presentation layer.
//
// A pure projection. It reads daemon state and renders it; it never decides
// anything and never touches execution. In particular the sidebar is ordered by
// the daemon's own sequence, never by DOM order -- under virtualization DOM order
// is wrong in exactly the situation where the user most needs it to be right.
globalThis.LBP_PRESENTATION = (() => {
  const coordinator = () => globalThis.LBP_COORDINATOR;

  let ui = null;
  let activeDialog = null;
  let activeContextMenu = null;
  let outputsExpanded = false;
  let contextExpanded = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Inline SVG icon set.
  //
  // These were CSS pseudo-element hacks tuned for the 2x reference mock: two bars
  // rotated +/-45deg. At real size they collapsed into an "x" (the section
  // carets) or a slashed circle (the gear), so they are drawn properly instead.
  // Every glyph inherits currentColor and scales with its box.
  const ICON_PATHS = {
    chevron: '<path d="M4 10 8 6l4 4"/>',
    caret: '<path d="M4 6.5 8 10.5l4-4"/>',
    bookmark: '<path d="M4.5 2.5h7v11l-3.5-2.3-3.5 2.3v-11Z"/>',
    plus: '<path d="M8 4.5v7M4.5 8h7"/>',
    folder: '<path d="M2.5 5.2V12a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6.4a1 1 0 0 0-1-1H8.3L7 4.1a1 1 0 0 0-.7-.3H3.5a1 1 0 0 0-1 1Z"/>',
    enable: '<circle cx="8" cy="8" r="5.6"/><path d="M5.7 8.1 7.3 9.7l3-3.4"/>',
    checkpoint: '<path d="M3 8h10M9 4l4 4-4 4"/>',
    stop: '<rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4"/>',
    settings: '<circle cx="8" cy="8" r="2.3"/><circle cx="8" cy="8" r="5.2"/>'
      + '<path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6"/>'
      + '<path d="M12.5 3.5 11.3 4.7M4.7 11.3 3.5 12.5M12.5 12.5 11.3 11.3M4.7 4.7 3.5 3.5"/>',
    command: '<path d="M6 4.5a1.5 1.5 0 1 0-1.5 1.5H6V4.5ZM10 4.5A1.5 1.5 0 1 1 11.5 6H10V4.5ZM6 11.5A1.5 1.5 0 1 1 4.5 10H6v1.5ZM10 11.5a1.5 1.5 0 1 0 1.5-1.5H10v1.5ZM6 6h4v4H6z"/>'
  };

  function icon(name, className) {
    const span = el("span", className);
    span.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" `
      + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
    return span;
  }

  function classificationText(kind) {
    return {
      read_only: "READ ONLY", verify: "VERIFY", write: "WRITE", destructive: "DESTRUCTIVE"
    }[kind] || String(kind || "").toUpperCase();
  }

  function operationLabel(operation) {
    if (!operation) return "";
    if (operation.type === "mcp.list_tools") return `${operation.server} · list tools`;
    if (operation.type === "mcp.observe") return `${operation.server} · observe ${operation.calls?.length || 0}`;
    if (operation.type === "mcp.mutate") return `${operation.server} · mutate ${operation.calls?.length || 0}`;
    return `${operation.server} · ${operation.tool}`;
  }

  // --- Status surface ------------------------------------------------------------

  function ensureUi() {
    if (ui) return ui;
    const root = el("aside", "lbp-global-status");
    const pill = el("button", "lbp-connection");
    pill.type = "button";
    const dot = el("span", "lbp-connection-dot");
    const main = el("span", "lbp-connection-text");
    pill.append(dot, main);

    const panel = el("section", "lbp-panel");
    panel.hidden = true;

    const progress = el("section", "lbp-progress");
    const progressTitleRow = el("div", "lbp-progress-title-row");
    const progressTitle = el("h1", "lbp-progress-title", "Progress");
    const collapse = el("button", "lbp-panel-collapse");
    collapse.type = "button";
    collapse.title = "Collapse";
    collapse.setAttribute("aria-label", "Collapse Local MCP Bridge panel");
    collapse.append(icon("chevron", "lbp-chevron-up"));
    progressTitleRow.append(progressTitle, collapse);

    const progressMeta = el("div", "lbp-meta-row");
    const metaLeft = el("div", "lbp-meta-left");
    const activeDot = el("span", "lbp-active-dot");
    const metaStatus = el("span", "lbp-meta-status");
    const metaMode = el("span", "lbp-meta-mode");
    const metaCount = el("span", "lbp-meta-count");
    metaLeft.append(
      activeDot,
      metaStatus,
      el("span", "lbp-meta-sep", "·"),
      metaMode,
      el("span", "lbp-meta-sep", "·"),
      metaCount
    );
    const metaRight = el("div", "lbp-meta-right");
    const checkpointAt = el("span", "lbp-checkpoint-at");
    const bookmark = icon("bookmark", "lbp-bookmark");
    bookmark.setAttribute("aria-hidden", "true");
    metaRight.append(checkpointAt, bookmark);
    progressMeta.append(metaLeft, metaRight);

    const timeline = el("div", "lbp-timeline");
    const timelineLine = el("div", "lbp-timeline-line");
    const list = el("div", "lbp-timeline-list");
    timeline.append(timelineLine, list);

    const checkpointFooter = el("div", "lbp-checkpoint-footer");
    const footerMeta = el("span", "lbp-footer-meta");
    const autoToggle = el("label", "lbp-auto");
    const autoToggleText = el("span", null, "Auto-continue");
    const autoToggleInput = document.createElement("input");
    autoToggleInput.type = "checkbox";
    autoToggleInput.className = "lbp-switch-input";
    autoToggleInput.setAttribute("role", "switch");
    const autoSwitch = el("span", "lbp-switch");
    autoSwitch.append(el("span", "lbp-switch-knob"));
    autoToggle.append(autoToggleText, autoToggleInput, autoSwitch);
    checkpointFooter.append(footerMeta, autoToggle);
    progress.append(progressTitleRow, progressMeta, timeline, checkpointFooter);

    const outputs = el("section", "lbp-outputs lbp-fold-section");
    const outputsSummary = el("button", "lbp-section-row");
    outputsSummary.type = "button";
    outputsSummary.append(el("span", "lbp-section-name", "Outputs"), icon("caret", "lbp-down"));
    const outputsCount = el("span", "lbp-section-count");
    outputsSummary.append(outputsCount);
    const outputsList = el("div", "lbp-output-list");
    outputs.append(outputsSummary, outputsList);

    const context = el("section", "lbp-context lbp-fold-section");
    const contextHeader = el("div", "lbp-context-header");
    const contextSummary = el("button", "lbp-context-left");
    contextSummary.type = "button";
    contextSummary.append(el("span", "lbp-section-name", "Context"), icon("caret", "lbp-down"));
    const contextAdd = el("button", "lbp-plus");
    contextAdd.append(icon("plus", "lbp-plus-glyph"));
    contextAdd.type = "button";
    contextAdd.title = "Add context";
    contextAdd.setAttribute("aria-label", "Add context");
    contextHeader.append(contextSummary, contextAdd);
    const contextChips = el("div", "lbp-context-chips");
    const contextMenu = el("div", "lbp-context-menu");
    contextMenu.hidden = true;
    const contextNotice = el("div", "lbp-context-notice");
    contextNotice.hidden = true;
    const contextDetails = el("div", "lbp-context-details");
    context.append(contextHeader, contextChips, contextMenu, contextNotice, contextDetails);

    const actions = el("div", "lbp-actions");

    function actionButton(label, kind) {
      const button = el("button", `lbp-action lbp-action-${kind}`);
      button.type = "button";
      const labelNode = el("span", "lbp-action-label", label);
      button.append(icon(kind, `lbp-action-icon lbp-icon-${kind}`), labelNode);
      button.__lbpLabel = labelNode;
      return button;
    }

    const enable = actionButton("Enable", "enable");
    const checkpoint = actionButton("Continue to next checkpoint", "checkpoint");
    const stop = actionButton("Stop chain", "stop");
    const settings = actionButton("Settings", "settings");

    enable.addEventListener("click", () => void coordinator().enable());
    checkpoint.addEventListener("click", () => void coordinator().continueCheckpoint());
    stop.addEventListener("click", () => void coordinator().stop());
    settings.addEventListener("click", () => chrome.runtime.sendMessage({ type: "lbp-open-options" }));
    actions.append(enable, checkpoint, stop, settings);
    panel.append(progress, outputs, context, actions);
    root.append(pill, panel);

    pill.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      pill.setAttribute("aria-expanded", String(!panel.hidden));
    });
    collapse.addEventListener("click", () => {
      panel.hidden = true;
      pill.setAttribute("aria-expanded", "false");
    });
    outputsSummary.addEventListener("click", () => {
      outputsExpanded = !outputsExpanded;
      render();
    });
    contextSummary.addEventListener("click", () => {
      contextExpanded = !contextExpanded;
      render();
    });
    contextAdd.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openContextMenu();
    });
    autoToggleInput.addEventListener("change", async () => {
      autoToggleInput.disabled = true;
      try {
        await coordinator().updateInteraction({
          ...coordinator().interaction(),
          mode: autoToggleInput.checked ? "auto_continue" : "manual"
        });
      } catch (error) {
        // Never leave the switch showing a mode the daemon did not accept --
        // that is how the sidebar and the settings page came to disagree.
        showContextNotice(humanError(error, "Could not change Auto-continue"));
      } finally {
        autoToggleInput.disabled = false;
        render();
      }
    });
    document.documentElement.appendChild(root);
    ui = {
      root, pill, dot, main, panel, progressMeta, activeDot, metaStatus,
      metaMode, metaCount, checkpointAt, timeline, list, outputs, outputsSummary,
      outputsCount, outputsList, context, contextChips, contextMenu,
      contextAdd, contextNotice, contextDetails, footerMeta, autoToggle,
      autoToggleInput, actions, enable, checkpoint, stop, settings
    };
    return ui;
  }

  function phaseLabel(value) {
    return String(value || "execute").replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function planSymbol(status) {
    return {
      completed: "✓", current: "◉", error: "✕", unknown: "⚠", skipped: "–", pending: "○"
    }[status] || "○";
  }

  // Daemon error strings are precise but not addressed to a person.
  function humanError(error, prefix) {
    const raw = String(error?.message || error || "");
    if (raw.includes("conversation_not_owner")) {
      return "Another tab is driving this conversation. Reload this tab to take over.";
    }
    if (raw.includes("conversation_revision_conflict")) {
      return "This tab was out of date and has refreshed. Try again.";
    }
    if (raw.includes("context_folder_outside_roots") || raw.includes("outside the currently allowed")) {
      return "That folder is outside the roots your MCP servers are allowed to read.";
    }
    return `${prefix}: ${raw}`;
  }

  function statusLabel(status) {
    return {
      registered: "Pending approval",
      running: "Running locally",
      completed: "Completed",
      current: "In progress",
      error: "Error",
      unknown: "Unknown",
      skipped: "Skipped",
      pending: "Pending",
      inserted: "Inserted",
      submitted: "Submitted",
      withheld: "Withheld",
      failed: "Failed",
      produced: "Produced",
      loading: "Loading...",
      unavailable: "State unavailable"
    }[status] || phaseLabel(status || "");
  }

  function workflowSummary(state) {
    const chain = state.active_chain || {};
    const enabled = state.enabled === true;
    // Phase, not just enabled + chain. A stopped chain still has an active_chain,
    // so the sidebar used to report "Active" while the daemon had actually
    // stopped the run -- the user saw "Active - waiting" and no explanation.
    const phase = state.phase || "disabled";
    // A running chain stays "Active" as the reference specifies; the step row
    // already says "In progress". Only the states the reference does not depict
    // -- stopped and checkpoint -- get their own label.
    // `enabled` only means "the model was given the instructions", so it is no
    // longer a status. What matters is whether a run is live.
    const status = phase === "disabled" ? "Off"
      : phase === "stopped" ? "Stopped"
      : phase === "checkpoint" ? "Checkpoint"
      : state.active_chain ? "Active"
      : "Idle";
    void enabled;
    // The configured mode, NOT whether the chat is enabled. Forcing "Manual"
    // while disabled made the sidebar contradict the settings page, and made the
    // Auto-continue switch look broken: a click set the mode, then this line
    // rendered "Manual" straight back over it.
    const mode = state.mode === "auto_continue" ? "Auto" : "Manual";
    const limit = Number(chain.window_limit || state.checkpoint_size || 12);
    const count = state.active_chain ? Number(chain.window_task_count || 0) : 0;
    return { status, mode, count, limit };
  }

  function stepClass(status, isCurrent = false) {
    if (isCurrent || status === "current" || status === "running" || status === "registered") return "current";
    if (status === "completed" || status === "submitted" || status === "produced") return "done";
    if (status === "error" || status === "failed" || status === "denied") return "error";
    if (status === "unknown") return "unknown";
    if (status === "skipped") return "skipped";
    return "pending";
  }

  function stepTime(task = {}) {
    const seconds = Number(task.updated_at || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    return new Date(seconds * 1000).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    });
  }

  // Sub-line wording follows the approved sidebar reference
  // (docs/sidebar-reference.html):
  //
  //   done     "Completed · 14:02:11"      status, then completion time
  //   current  "Align tests · In progress" detail, then status
  //   pending  "Pending"
  //
  // The reference only specifies those three states. For the states it does not
  // depict -- error, unknown, withheld, skipped -- the richer text is kept,
  // because that is where the operator actually needs the extra signal (an
  // ambiguous mutation in particular must say so on the row itself).
  function taskDetail(status, view = {}, task = {}) {
    if (status === "current" || status === "running" || status === "registered") {
      const detail = view.detail || (view.operation ? operationLabel(view.operation) : "");
      return [detail, statusLabel("current")].filter(Boolean).join(" · ");
    }

    if (status === "completed" || status === "submitted" || status === "produced") {
      return [statusLabel("completed"), stepTime(task)].filter(Boolean).join(" · ");
    }

    if (status === "pending") return statusLabel("pending");

    const bits = [statusLabel(status)];
    if (view.operation) bits.push(operationLabel(view.operation));
    if (view.classification) bits.push(classificationText(view.classification));
    if (task.delivery_status && task.delivery_status !== "none" && task.delivery_status !== "submitted") {
      bits.push(statusLabel(task.delivery_status));
    }
    if (view.detail) bits.push(view.detail);
    if (status === "unknown") bits.push("Auto-continuation stopped");
    const time = stepTime(task);
    if (time) bits.push(time);
    return bits.filter(Boolean).join(" · ");
  }

  function appendStep(surface, { index, title, status, detail, current, action }) {
    const row = el("div", `lbp-step ${stepClass(status, current)}`);
    row.append(el("div", "lbp-marker"), el("div", "lbp-num", String(index)));
    const copy = el("div", "lbp-copy");
    const titleRow = el("div", "lbp-title-row");
    titleRow.append(el("div", "lbp-step-title", title));
    if (current) titleRow.append(el("div", "lbp-current-tag", "Current step"));
    copy.append(titleRow, el("div", "lbp-sub", detail || statusLabel(status)));
    if (action) copy.append(action);
    row.append(copy);
    surface.list.append(row);
  }

  function renderProgress(surface, state) {
    const views = coordinator().taskViews();
    surface.list.innerHTML = "";
    surface.timeline.dataset.empty = "true";
    if (!state) return;

    const plan = state.plan;
    if (plan?.items?.length) {
      surface.timeline.dataset.empty = "false";
      plan.items.forEach((item, index) => {
        const task = (state.recent_tasks || []).find((entry) => entry.plan_item_id === item.id) || {};
        const view = views.get(item.task_id || task.task_id) || {};
        const current = item.status === "current";
        const status = current ? (view.status || task.execution_status || "current") : (item.status || "pending");
        appendStep(surface, {
          index: index + 1,
          title: item.title || item.id,
          status,
          current,
          detail: taskDetail(status === "current" ? "current" : status, view, task)
        });
      });
      return;
    }

    const chain = state.active_chain || {};
    const window = Number(chain.window || 0);
    const tasks = (state.recent_tasks || [])
      .filter((task) => Number(task.window || 0) === window)
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
    if (!tasks.length) {
      // An empty track with nothing but the rail reads as broken. Say what the
      // sidebar is actually waiting for.
      const stoppedReason = {
        multiple_tasks_in_one_assistant_turn:
          "The assistant put more than one LBP task in a single reply. Send a new message to start a fresh run.",
        malformed_task: "The assistant's LBP task could not be parsed. Send a new message to start a fresh run.",
        unknown_mutation_state:
          "A write finished in an unknown state, so the run stopped. Check the result before continuing.",
        stopped_by_user: "Run stopped. Send a new message to start a fresh one."
      }[state.stopped_reason] || "Run stopped. Send a new message to start a fresh one.";
      surface.list.append(el("div", "lbp-timeline-empty",
        state.phase === "disabled" ? "The bridge is off for this chat. Enable to switch it back on."
          : state.phase === "stopped" ? stoppedReason
          : state.active_chain ? "Waiting for the assistant's first task…"
          : "Send a message to start a run."));
      return;
    }
    surface.timeline.dataset.empty = "false";
    tasks.forEach((task, index) => {
      const view = views.get(task.task_id) || {};
      const status = view.status || task.execution_status || "registered";
      const current = task.task_id === state.current_task_id && !["completed", "error", "unknown"].includes(status);
      let action = null;
      const terminal = ["completed", "error", "unknown"].includes(status);
      const undelivered = !task.delivery_status || task.delivery_status !== "submitted";
      if (terminal && undelivered && view.result) {
        action = el("button", "lbp-task-action", "Re-deliver result");
        action.type = "button";
        action.addEventListener("click", () => void coordinator().redeliverResult(task.task_id));
      }
      appendStep(surface, {
        index: index + 1,
        title: task.title || task.task_id,
        status,
        current,
        detail: taskDetail(status, view, task),
        action
      });
    });
  }

  function renderOutputs(surface, state) {
    const outputs = state?.outputs || [];
    surface.outputsList.innerHTML = "";
    surface.outputs.dataset.open = outputsExpanded ? "true" : "false";
    surface.outputsCount.textContent = outputs.length ? String(outputs.length) : "";
    surface.outputsList.hidden = !outputsExpanded;
    if (!outputs.length) {
      if (outputsExpanded) surface.outputsList.append(el("div", "lbp-empty", "No outputs"));
      return;
    }
    for (const output of outputs) {
      const row = el("div", `lbp-output-row lbp-output-${output.status || "pending"}`);
      row.append(el("span", "lbp-output-label", output.label || output.id));
      row.append(el("span", "lbp-output-status", statusLabel(output.status || "pending")));
      surface.outputsList.append(row);
    }
  }

  function clearContextNotice() {
    const surface = ensureUi();
    surface.contextNotice.innerHTML = "";
    surface.contextNotice.hidden = true;
  }

  function showContextNotice(message, offerSettings = false) {
    const surface = ensureUi();
    surface.contextNotice.innerHTML = "";
    surface.contextNotice.append(el("div", "lbp-context-notice-text", message));
    if (offerSettings) {
      const actions = el("div", "lbp-context-notice-actions");
      const settings = el("button", null, "Open MCP settings");
      settings.type = "button";
      settings.addEventListener("click", () => chrome.runtime.sendMessage({ type: "lbp-open-options" }));
      const cancel = el("button", null, "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", clearContextNotice);
      actions.append(settings, cancel);
      surface.contextNotice.append(actions);
    }
    surface.contextNotice.hidden = false;
    contextExpanded = true;
    surface.context.dataset.open = "true";
    surface.contextDetails.hidden = false;
  }

  function isOutsideRootError(error) {
    return /context_folder_outside_roots|outside the currently allowed MCP roots/i.test(String(error?.message || error));
  }

  function contextMenuButton(label) {
    const button = el("button", null, label);
    button.type = "button";
    return button;
  }

  function closeContextMenu() {
    if (!activeContextMenu) return;
    activeContextMenu.innerHTML = "";
    activeContextMenu.hidden = true;
    activeContextMenu = null;
  }

  function openContextMenu() {
    const surface = ensureUi();
    closeContextMenu();
    clearContextNotice();
    contextExpanded = true;
    surface.context.dataset.open = "true";
    surface.contextDetails.hidden = false;

    const menu = surface.contextMenu;
    menu.innerHTML = "";
    menu.hidden = false;
    menu.append(el("div", "lbp-context-menu-title", "Add context"));
    const chooseFolder = contextMenuButton("Choose folder…");
    const addWorkspace = contextMenuButton("Add configured workspace…");
    const workspaceList = el("div", "lbp-context-workspaces");
    workspaceList.hidden = true;
    menu.append(chooseFolder, addWorkspace, workspaceList);
    activeContextMenu = menu;

    chooseFolder.addEventListener("click", async () => {
      chooseFolder.disabled = true;
      try {
        const result = await coordinator().chooseContextFolder();
        closeContextMenu();
        if (!result?.cancelled) clearContextNotice();
      } catch (error) {
        closeContextMenu();
        if (isOutsideRootError(error)) {
          showContextNotice("Folder is outside the currently allowed MCP roots.", true);
        } else {
          showContextNotice(String(error.message || error));
        }
      }
    });

    addWorkspace.addEventListener("click", async () => {
      addWorkspace.disabled = true;
      workspaceList.hidden = false;
      workspaceList.innerHTML = "";
      workspaceList.append(el("div", "lbp-context-menu-status", "Loading..."));
      try {
        const sources = await coordinator().configuredContextSources();
        workspaceList.innerHTML = "";
        if (!sources.length) {
          workspaceList.append(el("div", "lbp-context-menu-status", "No configured workspaces"));
          return;
        }
        for (const source of sources) {
          const item = contextMenuButton([source.label, source.server].filter(Boolean).join(" · "));
          item.title = source.path || source.label || "";
          item.addEventListener("click", async () => {
            item.disabled = true;
            try {
              await coordinator().addContextSource(source);
              closeContextMenu();
              clearContextNotice();
            } catch (error) {
              closeContextMenu();
              if (isOutsideRootError(error)) {
                showContextNotice("Folder is outside the currently allowed MCP roots.", true);
              } else {
                showContextNotice(String(error.message || error));
              }
            }
          });
          workspaceList.append(item);
        }
      } catch (error) {
        workspaceList.innerHTML = "";
        workspaceList.append(el("div", "lbp-context-menu-status", String(error.message || error)));
      } finally {
        addWorkspace.disabled = false;
      }
    });
  }

  function renderContext(surface, state) {
    const context = state?.context || {};
    surface.contextChips.innerHTML = "";
    surface.contextDetails.innerHTML = "";
    surface.context.dataset.open = contextExpanded ? "true" : "false";
    surface.contextDetails.hidden = !contextExpanded;
    const sources = Array.isArray(context.sources) && context.sources.length
      ? context.sources
      : context.resources || [];
    if (sources.length) {
      for (const source of sources) {
        const row = el("div", `lbp-chip lbp-chip-${source.kind || "resource"}${source.accessible === false ? " lbp-context-inaccessible" : ""}`);
        // NB: named chipIcon, not icon -- a local `icon` would shadow the SVG
        // icon() helper for this whole function scope.
        const kind = source.kind || "resource";
        const chipIcon = icon(kind === "folder" ? "folder" : "command",
          `lbp-chip-icon lbp-chip-icon-${kind}`);
        const label = typeof source === "string"
          ? source
          : source.label || [source.kind, source.ref].filter(Boolean).join(" · ");
        row.append(chipIcon, el("span", "lbp-chip-label", label));
        row.title = source.path || source.ref || label;
        if (source.removable) {
          const remove = el("button", "lbp-context-remove", "×");
          remove.type = "button";
          remove.title = "Remove context source";
          remove.setAttribute("aria-label", `Remove ${label} from context`);
          remove.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
              await coordinator().removeContextSource(source.id);
              clearContextNotice();
            } catch (error) {
              showContextNotice(String(error.message || error));
            }
          });
          row.append(remove);
        }
        surface.contextChips.append(row);
      }
    }
    for (const server of context.servers || []) {
      const label = typeof server === "string" ? server : server.label;
      if (!label) continue;
      const row = el("div", "lbp-chip lbp-chip-mcp");
      row.append(icon("command", "lbp-command-icon"), el("span", "lbp-chip-label", label));
      surface.contextChips.append(row);
    }
    const sections = [
      ["Constraints", context.constraints || []]
    ];
    for (const [label, items] of sections) {
      if (!items.length) continue;
      surface.contextDetails.append(el("div", "lbp-context-heading", label));
      for (const item of items) {
        const text = typeof item === "string" ? item : [item.kind, item.label].filter(Boolean).join(" · ");
        surface.contextDetails.append(el("div", "lbp-context-line", text));
      }
    }
  }

  function render() {
    const surface = ensureUi();
    const state = coordinator().state();
    const stateStatus = coordinator().stateStatus?.() || { kind: state ? "ready" : "loading" };
    const status = coordinator().status();
    const identity = coordinator().identity();

    const connected = Boolean(identity.bridgeVersion);
    const transportKind = connected ? "connected" : status.kind === "checking" ? "checking" : "offline";
    const transport = connected ? "Connected" : status.kind === "checking" ? "Connecting" : "Offline";
    surface.root.dataset.lbpKind = transportKind;
    const pillBits = [transport];
    if (identity.bridgeVersion) pillBits.push(`Bridge v${identity.bridgeVersion}`);
    if (identity.lbpVersion) pillBits.push(`LBP ${identity.lbpVersion}`);
    surface.main.textContent = pillBits.join(" · ");
    surface.dot.className = `lbp-connection-dot lbp-connection-dot-${transportKind}`;

    const unavailable = !state && (stateStatus.kind === "unavailable" || status.kind === "error");
    if (!state) {
      const label = unavailable ? "State unavailable" : "Loading...";
      surface.progressMeta.dataset.workflow = unavailable ? "unavailable" : "loading";
      surface.metaStatus.textContent = label;
      surface.metaMode.textContent = "";
      surface.metaCount.textContent = "";
      surface.checkpointAt.textContent = "";
      surface.footerMeta.textContent = label;
      surface.autoToggleInput.checked = false;
      surface.autoToggleInput.disabled = true;
      surface.enable.hidden = true;
      surface.checkpoint.hidden = true;
      surface.stop.hidden = true;
      surface.list.innerHTML = "";
      renderOutputs(surface, null);
      renderContext(surface, null);
      return;
    }

    const summary = workflowSummary(state);
    surface.progressMeta.dataset.workflow = summary.status.toLowerCase();
    surface.metaStatus.textContent = summary.status;
    surface.metaMode.textContent = summary.mode;
    surface.metaCount.textContent = `${summary.count}/${summary.limit}`;
    surface.checkpointAt.textContent = `Checkpoint at ${summary.limit}`;
    surface.footerMeta.textContent = `${summary.count}/${summary.limit} until checkpoint`;

    const phase = state.phase || "disabled";
    surface.enable.hidden = state.enabled === true;
    surface.checkpoint.hidden = phase !== "checkpoint";
    surface.stop.hidden = !state.active_chain || phase === "checkpoint" || ["disabled", "stopped"].includes(phase);
    surface.autoToggleInput.checked = state.mode === "auto_continue";
    surface.autoToggleInput.disabled = false;

    renderProgress(surface, state);
    renderOutputs(surface, state);
    renderContext(surface, state);
  }

  // --- Approval dialog -------------------------------------------------------------

  function requestApproval(preview) {
    if (activeDialog) return activeDialog;
    const operation = preview.operation || {};
    const approval = preview.approval || {};

    activeDialog = new Promise((resolve) => {
      const overlay = el("div", "lbp-modal-overlay");
      const modal = el("section", "lbp-modal");

      modal.append(el("div", "lbp-modal-eyebrow", "Local MCP Bridge"));
      const badge = el("span", `lbp-badge lbp-badge-${operation.classification}`,
        classificationText(operation.classification));
      modal.append(badge);
      modal.append(el("h3", null, preview.title || preview.task_id || "Local MCP operation"));
      if (preview.description) modal.append(el("p", "lbp-modal-intent", preview.description));

      const facts = el("div", "lbp-modal-facts");
      facts.append(el("div", "lbp-modal-fact", `Target: ${operationLabel(operation)}`));
      facts.append(el("div", "lbp-modal-fact", `Policy: ${approval.mode || "mutations"}`));
      facts.append(el("div", "lbp-modal-fact", `Reason: ${approval.reason || ""}`));
      const checks = operation.path_checks || [];
      if (checks.length) {
        facts.append(el("div", "lbp-modal-fact",
          `Paths: ${checks.map((check) => check.path).join(", ")}`));
      }
      modal.append(facts);

      const technical = document.createElement("details");
      technical.append(el("summary", null, "Technical detail"));
      technical.append(el("pre", null, JSON.stringify(operation.arguments ?? operation.calls ?? {}, null, 2)));
      modal.append(technical);

      const actions = el("div", "lbp-modal-actions");
      const buttons = [];
      function button(label, value, className) {
        const node = el("button", className, label);
        node.type = "button";
        node.addEventListener("click", () => settle(value));
        buttons.push(node);
        return node;
      }
      actions.append(button("Deny", "deny", "lbp-deny"));
      actions.append(button("Allow once", "once", "lbp-once"));
      if (approval.chain_approval_available) {
        // "Allow this chain" is the CURRENT checkpoint window and nothing wider.
        // The daemon derives that scope; continuing past a checkpoint necessarily
        // requires a fresh approval.
        actions.append(button(
          `Allow this chain (this window of ${Number(preview.window_limit || 12)})`,
          "chain", "lbp-chain"));
      }
      if (approval.session_approval_available) {
        const hours = Math.max(1, Math.round(Number(approval.session_ttl_seconds || 0) / 3600));
        actions.append(button(`Allow for this conversation (${hours}h)`, "session", "lbp-session"));
      }
      modal.append(actions);

      let settled = false;
      function settle(value) {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        activeDialog = null;
        resolve(value);
      }
      const onKey = (event) => { if (event.key === "Escape") settle("deny"); };
      document.addEventListener("keydown", onKey, true);

      overlay.append(modal);
      document.documentElement.appendChild(overlay);
      buttons[1]?.focus();
    });
    return activeDialog;
  }

  return Object.freeze({ render, ensureUi, requestApproval });
})();
