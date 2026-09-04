// Bootstrap and wiring only.
//
// All orchestration lives in coordinator.js, all rendering in presentation.js,
// all provider specifics in adapters/chatgpt.js. This file owns no state.
//
// Note what is deliberately absent: there is no sessionStorage chain, no
// workflow flag, no browser execution ledger and no DOM chain reconstruction.
// The daemon is the single source of truth for workflow state, task currentness,
// checkpoint scope, staleness and approval-window identity.
(() => {
  const coordinator = globalThis.LBP_COORDINATOR;
  const presentation = globalThis.LBP_PRESENTATION;

  async function loadInteraction() {
    let next = null;
    try {
      const stored = await chrome.storage.local.get("interaction");
      const raw = stored?.interaction || {};
      const max = Number(raw.max_round_trips);
      next = {
        mode: raw.mode === "auto_continue" ? "auto_continue" : "manual",
        max_round_trips: Number.isFinite(max) && max >= 1 && max <= 100 ? Math.floor(max) : 12,
        status_surface: raw.status_surface === "pill" ? "pill" : "panel"
      };
      coordinator.setInteraction(next);
    } catch (_) {
      // Defaults already applied by the coordinator.
    }
    if (next) {
      try {
        await coordinator.configureConversation(next);
      } catch (_) {
        // Health polling reports daemon availability; local presentation can still render.
      }
    }
  }

  async function refreshHealth() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "lbp-health" });
      if (!response?.ok) throw new Error(response?.error || "bridge unreachable");
      const health = response.payload || {};
      const protocols = Array.isArray(health.protocols) ? health.protocols[0] : null;
      coordinator.setIdentity({
        bridgeVersion: health.version || null,
        lbpVersion: Array.isArray(protocols?.versions) ? protocols.versions[0] : null
      });
      coordinator.setStatus("connected", "LBP ● Connected", "");
    } catch (error) {
      coordinator.setStatus("error", "LBP ⚠ Bridge unreachable", String(error.message || error));
    }
  }

  coordinator.subscribe(() => {
    presentation.render();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.interaction) return;
    void loadInteraction().then(() => coordinator.scan());
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshHealth();
  });

  void loadInteraction().then(() => {
    presentation.ensureUi();
    void refreshHealth();
    coordinator.start();
    setInterval(() => { if (!document.hidden) void refreshHealth(); }, 30000);
  });
})();
