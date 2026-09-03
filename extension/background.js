importScripts("config.js");

const CHAT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function scopedSessionId(message, sender) {
  const raw = typeof message?.sessionId === "string" ? message.sessionId : "";
  const tabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : 0;
  let conversation = "unknown";
  try { conversation = fnv1a(new URL(sender.tab?.url || "").pathname || "/"); } catch (_) {}
  return `${raw}.t${tabId}.c${conversation}`.slice(0, 128);
}

function validSender(message, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (["lbp-run", "lbp-preview", "lbp-approve"].includes(message?.type)) {
    try {
      const url = new URL(sender.tab?.url || "");
      return url.protocol === "https:" && CHAT_HOSTS.has(url.hostname);
    } catch (_) {
      return false;
    }
  }
  return true;
}

async function request(path, options = {}) {
  const cfg = globalThis.LOCAL_MCP_BRIDGE_CONFIG;
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${cfg.token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${cfg.endpoint}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  if (!validSender(message, sender)) {
    sendResponse({ ok: false, error: "request rejected: invalid extension sender" });
    return;
  }

  const reply = (promise) => {
    promise
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  };

  if (message.type === "lbp-health") return reply(request("/health"));
  if (message.type === "lbp-preview") {
    return reply(request("/v1/tasks/preview", {
      method: "POST",
      body: JSON.stringify({ task: message.task, session_id: scopedSessionId(message, sender) })
    }));
  }
  if (message.type === "lbp-approve") {
    return reply(request("/v1/approvals", {
      method: "POST",
      body: JSON.stringify({
        task: message.task,
        session_id: scopedSessionId(message, sender),
        decision: message.decision
      })
    }));
  }
  if (message.type === "lbp-run") {
    return reply(request("/v1/tasks", {
      method: "POST",
      body: JSON.stringify({
        task: message.task,
        session_id: scopedSessionId(message, sender),
        approval_token: message.approvalToken || null
      })
    }));
  }
  if (message.type === "lbp-servers-get") return reply(request("/v1/servers"));
  if (message.type === "lbp-servers-save") {
    return reply(request("/v1/servers", {
      method: "POST",
      body: JSON.stringify({ servers: message.servers, expected_version: message.expectedVersion })
    }));
  }
  if (message.type === "lbp-server-test") {
    return reply(request("/v1/servers/test", {
      method: "POST",
      body: JSON.stringify({ name: message.name, config: message.config })
    }));
  }
  if (message.type === "lbp-open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }
});
