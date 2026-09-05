const serversNode = document.querySelector("#servers");
const template = document.querySelector("#server-template");
const messageNode = document.querySelector("#message");
const daemonNode = document.querySelector("#daemon");
let registryVersion = null;

const DEFAULT_INTERACTION = Object.freeze({
  mode: "manual",
  max_round_trips: 12,
  unknown_recovery: "manual",
  status_surface: "panel"
});

function interactionConfig() {
  const mode = document.querySelector("#interaction-mode").value;
  if (!["manual", "auto_continue"].includes(mode)) throw new Error("Invalid interaction mode.");

  const max = Number(document.querySelector("#interaction-max-rounds").value);
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error("Checkpoint size must be an integer from 1 to 100 tasks.");
  }
  const unknown_recovery = document.querySelector("#interaction-unknown-recovery").value;
  if (!["manual", "auto_continue"].includes(unknown_recovery)) throw new Error("Invalid unknown recovery mode.");

  return {
    mode,
    max_round_trips: max,
    unknown_recovery,
    status_surface: "panel"
  };
}

async function loadInteraction() {
  const stored = await chrome.storage.local.get("interaction");
  const raw = stored?.interaction || DEFAULT_INTERACTION;

  document.querySelector("#interaction-mode").value = raw.mode === "auto_continue" ? "auto_continue" : "manual";

  const max = Number(raw.max_round_trips);
  document.querySelector("#interaction-max-rounds").value =
    Number.isInteger(max) && max >= 1 && max <= 100 ? max : 12;
  document.querySelector("#interaction-unknown-recovery").value =
    raw.unknown_recovery === "auto_continue" ? "auto_continue" : "manual";

  void raw.status_surface;
}

function bridgeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!response?.ok) return reject(new Error(response?.error || "Local bridge request failed"));
      resolve(response.payload);
    });
  });
}

function lines(value) {
  return String(value || "")
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x, i, all) => all.indexOf(x) === i);
}

function verificationRules(card) {
  const raw = card.querySelector(".server-verification-rules").value.trim();
  if (!raw) return [];
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`Verification rules must be valid JSON: ${error.message || error}`); }
  if (!Array.isArray(value)) throw new Error("Verification rules must be a JSON array.");
  return value;
}

function serverConfig(card) {
  const id = card.querySelector(".server-id").value.trim();
  const endpoint = card.querySelector(".server-endpoint").value.trim();
  const timeoutRaw = card.querySelector(".server-timeout").value.trim();
  const timeout_s = Number(timeoutRaw);

  if (!Number.isInteger(timeout_s) || timeout_s < 1 || timeout_s > 180) {
    throw new Error(`Server ${id || "(unnamed)"}: timeout must be an integer from 1 to 180.`);
  }

  const write = card.querySelector(".server-write").checked;
  const allow_destructive = card.querySelector(".server-destructive").checked;
  if (allow_destructive && !write) throw new Error(`Server ${id}: destructive tools require writes to be enabled.`);

  return {
    id,
    config: {
      transport: "http",
      endpoint,
      timeout_s,
      enabled: card.querySelector(".server-enabled").checked,
      roots: lines(card.querySelector(".server-roots").value),
      allowed_tools: lines(card.querySelector(".server-tools").value),
      allow_verify: card.querySelector(".server-verify").checked,
      verification_rules: verificationRules(card),
      write,
      allow_destructive,
      approval_mode: card.querySelector(".server-approval-mode").value,
      approval_escalation: card.querySelector(".server-approval-escalation").value,
      always_approve_destructive: card.querySelector(".server-destructive-approval").checked
    }
  };
}

function updateRiskWarning(card) {
  const warnings = [];
  const write = card.querySelector(".server-write").checked;
  const allowVerify = card.querySelector(".server-verify").checked;
  const destructive = card.querySelector(".server-destructive").checked;
  const mode = card.querySelector(".server-approval-mode").value;
  const destructiveApproval = card.querySelector(".server-destructive-approval").checked;
  const roots = lines(card.querySelector(".server-roots").value);
  const allowedTools = lines(card.querySelector(".server-tools").value);
  const interactionMode = document.querySelector("#interaction-mode")?.value || "manual";

  let verifyRules = [];
  try { verifyRules = verificationRules(card); } catch (_) {}

  if (allowedTools.includes("*")) {
    warnings.push("Wildcard tool eligibility is enabled. Every tool currently exposed by this MCP server is eligible for the remaining daemon policy checks.");
  }
  if (allowVerify && verifyRules.length === 0) {
    warnings.push("VERIFY is enabled but no verification rules are configured.");
  }
  if (allowVerify) {
    warnings.push("VERIFY commands may still create caches/artifacts, run project code, spawn processes, or use network access permitted by the underlying MCP server.");
  }
  if (write && roots.length === 0) {
    warnings.push("Writes are enabled with no allowed roots. Path-bearing calls fail closed until at least one root is configured.");
  }
  if (mode === "none" && write) {
    warnings.push("Policy-only mode + writes allows permitted write tools to execute without a local approval prompt.");
    if (interactionMode === "auto_continue") {
      warnings.push("Auto-continue is also enabled, so multiple model-driven write turns may execute unattended inside the configured policy boundary.");
    }
  }
  if (destructive && !destructiveApproval) {
    warnings.push("Destructive tools are enabled and the per-operation destructive approval gate is OFF.");
  }

  const node = card.querySelector(".risk-warning");
  node.hidden = warnings.length === 0;
  node.textContent = warnings.join("\n\n");
}

function updateAllRiskWarnings() {
  for (const card of serversNode.querySelectorAll(".server-card")) updateRiskWarning(card);
}

function classificationLabel(tool) {
  if (tool.classification === "read_only") return "read only";
  if (tool.classification === "destructive") return "destructive";
  return "write / unknown";
}

function renderDiscovered(card, tools) {
  const wrap = card.querySelector(".discovered-wrap");
  const node = card.querySelector(".discovered-tools");
  node.innerHTML = "";

  for (const tool of tools) {
    const row = document.createElement("div");
    row.className = `tool-row tool-${tool.classification}`;
    const name = document.createElement("code");
    name.textContent = tool.name;
    const kind = document.createElement("span");
    kind.textContent = classificationLabel(tool);
    row.append(name, kind);
    node.appendChild(row);
  }

  wrap.hidden = !tools.length;
  card.__discoveredTools = tools;
  card.querySelector(".allow-readonly").disabled = !tools.some((t) => t.classification === "read_only");
}

function addServer(id = "", cfg = {}) {
  const card = template.content.firstElementChild.cloneNode(true);

  card.querySelector(".server-id").value = id;
  card.querySelector(".server-endpoint").value = cfg.endpoint || "http://127.0.0.1:8000/mcp";
  card.querySelector(".server-timeout").value = cfg.timeout_s || 30;
  card.querySelector(".server-enabled").checked = cfg.enabled !== false;
  card.querySelector(".server-roots").value = (cfg.roots || []).join("\n");
  card.querySelector(".server-tools").value = (cfg.allowed_tools || []).join("\n");
  card.querySelector(".server-verify").checked = cfg.allow_verify === true;
  card.querySelector(".server-verification-rules").value = JSON.stringify(cfg.verification_rules || [], null, 2);
  card.querySelector(".server-write").checked = cfg.write === true;
  card.querySelector(".server-destructive").checked = cfg.allow_destructive === true;
  card.querySelector(".server-approval-mode").value = cfg.approval_mode || "mutations";
  card.querySelector(".server-approval-escalation").value = cfg.approval_escalation || "chain";
  card.querySelector(".server-destructive-approval").checked = cfg.always_approve_destructive !== false;

  card.querySelector(".server-write").addEventListener("change", (event) => {
    if (!event.currentTarget.checked) card.querySelector(".server-destructive").checked = false;
    updateRiskWarning(card);
  });

  for (const selector of [
    ".server-tools",
    ".server-verify",
    ".server-verification-rules",
    ".server-destructive",
    ".server-approval-mode",
    ".server-approval-escalation",
    ".server-destructive-approval",
    ".server-roots"
  ]) {
    card.querySelector(selector).addEventListener("change", () => updateRiskWarning(card));
    card.querySelector(selector).addEventListener("input", () => updateRiskWarning(card));
  }

  card.querySelector(".remove").addEventListener("click", () => {
    const name = card.querySelector(".server-id").value.trim() || "this server";
    if (confirm(`Remove ${name} from the local MCP registry?`)) card.remove();
  });

  card.querySelector(".allow-readonly").addEventListener("click", () => {
    const tools = card.__discoveredTools || [];
    const existing = lines(card.querySelector(".server-tools").value);
    const merged = [
      ...new Set([
        ...existing,
        ...tools.filter((t) => t.classification === "read_only").map((t) => t.name)
      ])
    ].sort();
    card.querySelector(".server-tools").value = merged.join("\n");
    updateRiskWarning(card);
  });

  card.querySelector(".test").addEventListener("click", async () => {
    const button = card.querySelector(".test");
    const status = card.querySelector(".test-status");
    try {
      const { id: name, config } = serverConfig(card);
      if (!name) throw new Error("Enter a server ID first.");
      button.disabled = true;
      status.textContent = "Connecting and reading tools/list…";
      const payload = await bridgeMessage({ type: "lbp-server-test", name, config });
      const result = payload.result;
      const label = result.server_info?.name || name;
      const version = result.server_info?.version ? ` ${result.server_info.version}` : "";
      const counts = (result.tools || []).reduce((acc, tool) => {
        acc[tool.classification] = (acc[tool.classification] || 0) + 1;
        return acc;
      }, {});
      status.textContent = `✓ ${label}${version} · ${result.tool_count} tools · ${counts.read_only || 0} read-only · ${(counts.write || 0) + (counts.destructive || 0)} write/unknown · ${result.duration_ms} ms`;
      renderDiscovered(card, result.tools || []);
    } catch (error) {
      status.textContent = `✕ ${error.message || error}`;
    } finally {
      button.disabled = false;
    }
  });

  updateRiskWarning(card);
  serversNode.appendChild(card);
}

async function load() {
  await loadInteraction();
  try {
    const health = await bridgeMessage({ type: "lbp-health" });
    daemonNode.textContent = `● Local bridge ${health.version} connected · LBP ${health.protocols?.[0]?.versions?.[0] || "?"}`;
    const payload = await bridgeMessage({ type: "lbp-servers-get" });
    registryVersion = payload.version;
    serversNode.innerHTML = "";
    for (const [id, cfg] of Object.entries(payload.servers || {})) addServer(id, cfg);
    if (!serversNode.children.length) addServer();
  } catch (error) {
    daemonNode.textContent = "○ Local bridge unavailable";
    messageNode.textContent = String(error.message || error);
  }
}

document.querySelector("#interaction-mode").addEventListener("change", updateAllRiskWarnings);
document.querySelector("#add").addEventListener("click", () => addServer());

document.querySelector("#save").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const servers = {};

  try {
    const interaction = interactionConfig();

    for (const card of serversNode.querySelectorAll(".server-card")) {
      const { id, config } = serverConfig(card);
      if (!id) throw new Error("Every server needs an ID.");
      if (servers[id]) throw new Error(`Duplicate server ID: ${id}`);
      servers[id] = config;
    }

    const unattendedWrites = Object.entries(servers)
      .filter(([, cfg]) => cfg.enabled !== false && cfg.write === true && cfg.approval_mode === "none")
      .map(([id]) => id);

    if (unattendedWrites.length) {
      const phrase = "ALLOW UNATTENDED WRITES";
      const typed = window.prompt(
        `The following servers can execute allowed write tools without a local approval prompt: ${unattendedWrites.join(", ")}.\n\nType ${phrase} to save this configuration.`
      );
      if (typed !== phrase) throw new Error("Policy-only write configuration was not confirmed.");
    }

    button.disabled = true;
    messageNode.textContent = "Saving…";
    const payload = await bridgeMessage({
      type: "lbp-servers-save",
      servers,
      expectedVersion: registryVersion
    });
    registryVersion = payload.version;
    await chrome.storage.local.set({ interaction });

    messageNode.textContent = interaction.mode === "auto_continue"
      ? "Saved. Daemon policy updated; auto-continue is enabled."
      : "Saved. Daemon policy updated; result continuation is manual.";
  } catch (error) {
    messageNode.textContent = `Error: ${error.message || error}`;
  } finally {
    button.disabled = false;
  }
});

load();
