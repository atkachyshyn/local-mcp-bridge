importScripts("config.js");

const CHAT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const PRIVILEGED = new Set([
  "lbp-run", "lbp-preview", "lbp-approve", "lbp-conversation-state",
  "lbp-context-choose-folder", "lbp-context-workspaces"
]);

// --- Conversation identity ---------------------------------------------------
//
// Two shapes, and the distinction is load-bearing.
//
// canonical  conv-<32 hex>  derived from the provider's own conversation id --
//                           for ChatGPT the /c/<uuid> path segment, which is a
//                           public route parameter, not a private API. Hashed
//                           with SHA-256.
//
// provisional prov-<32 hex> per TAB, used before the provider has assigned a
//                           conversation id (a new chat at "/", a project route
//                           with no conversation id).
//
// The old identity was FNV-1a over the whole pathname, which collapsed every new
// chat in every tab into one bucket -- and because `enabled` lives in that
// bucket, enabling once enabled every future new chat everywhere. Per-tab
// provisional ids are what stop that.

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CANONICAL_ROUTE = /(?:^|\/)c\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/;

function providerConversationUuid(url) {
  try {
    const match = new URL(url).pathname.match(CANONICAL_ROUTE);
    return match ? match[1].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

async function sessionGet(key) {
  try {
    const bag = await chrome.storage.session.get(key);
    return bag?.[key] ?? null;
  } catch (_) {
    return null;
  }
}

async function sessionSet(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (_) { /* best effort */ }
}

async function provisionalId(tabId) {
  const key = `lbp.tabNonce.${tabId}`;
  let nonce = await sessionGet(key);
  if (!nonce) {
    nonce = crypto.randomUUID();
    await sessionSet(key, nonce);
  }
  return `prov-${(await sha256Hex(`tab:${tabId}:${nonce}`)).slice(0, 32)}`;
}

async function canonicalId(uuid) {
  return `conv-${(await sha256Hex(`chatgpt:${uuid}`)).slice(0, 32)}`;
}

// Resolve the conversation identity for a tab, performing the one-time
// provisional -> canonical migration when the SPA settles on a conversation id.
// Only provisional state is ever migrated, and never over existing canonical
// state; navigation between two canonical conversations copies nothing.
async function resolveConversation(sender) {
  const tabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : 0;
  const uuid = providerConversationUuid(sender.tab?.url || "");
  const lastKey = `lbp.lastConv.${tabId}`;

  if (!uuid) {
    const provisional = await provisionalId(tabId);
    await sessionSet(lastKey, provisional);
    return provisional;
  }

  const canonical = await canonicalId(uuid);
  const previous = await sessionGet(lastKey);
  if (previous && previous.startsWith("prov-") && previous !== canonical) {
    try {
      await request("/v1/conversation-state/bind", {
        method: "POST",
        body: JSON.stringify({ provisional_id: previous, canonical_id: canonical })
      });
    } catch (_) {
      // Binding is best effort. On failure the canonical conversation simply
      // starts clean, which fails closed rather than sharing state.
    }
  }
  await sessionSet(lastKey, canonical);
  return canonical;
}

// The browser approval session identifier. Scoped per tab so it cannot be
// reused across tabs. Note the daemon keys approval LEASES on the conversation,
// not on this value -- this only binds one-time approval tokens.
async function scopedSessionId(sender) {
  const tabId = Number.isInteger(sender.tab?.id) ? sender.tab.id : 0;
  const key = `lbp.session.${tabId}`;
  let value = await sessionGet(key);
  if (!value) {
    value = crypto.randomUUID();
    await sessionSet(key, value);
  }
  return `${value}.t${tabId}`.slice(0, 128);
}

function validSender(message, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (!PRIVILEGED.has(message?.type)) return true;
  try {
    const url = new URL(sender.tab?.url || "");
    return url.protocol === "https:" && CHAT_HOSTS.has(url.hostname);
  } catch (_) {
    return false;
  }
}

async function request(path, options = {}) {
  const cfg = globalThis.LOCAL_MCP_BRIDGE_CONFIG;
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${cfg.token}`);
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${cfg.endpoint}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (response.status === 409) {
    // Optimistic-concurrency conflict. Surface the daemon's current state so the
    // coordinator can reconcile instead of retrying blindly.
    const conflict = new Error(payload.error || "conversation_revision_conflict");
    conflict.conflictState = payload.state || null;
    conflict.isConflict = true;
    throw conflict;
  }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.tabs?.onRemoved?.addListener((tabId) => {
  chrome.storage.session.remove([
    `lbp.tabNonce.${tabId}`, `lbp.lastConv.${tabId}`, `lbp.session.${tabId}`
  ]).catch(() => {});
});

async function handle(message, sender) {
  switch (message.type) {
    case "lbp-health":
      return request("/health");

    case "lbp-conversation-state":
      return request("/v1/conversation-state", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: await resolveConversation(sender),
          action: message.action || "get",
          payload: message.payload && typeof message.payload === "object" ? message.payload : {}
        })
      });

    // Preview / approve / run address a daemon-registered task by handle. The
    // task BODY is never sent again after registration, so its content cannot
    // change between preview, approval and execution. chain_id is not on the
    // wire at all -- approval-window identity is derived by the daemon.
    case "lbp-preview":
      return request("/v1/tasks/preview", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: await resolveConversation(sender),
          registration: message.registration,
          session_id: await scopedSessionId(sender)
        })
      });

    case "lbp-approve":
      return request("/v1/approvals", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: await resolveConversation(sender),
          registration: message.registration,
          session_id: await scopedSessionId(sender),
          decision: message.decision
        })
      });

    case "lbp-run":
      return request("/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: await resolveConversation(sender),
          registration: message.registration,
          session_id: await scopedSessionId(sender),
          approval_token: message.approvalToken || null
        })
      });

    case "lbp-servers-get":
      return request("/v1/servers");

    case "lbp-servers-save":
      return request("/v1/servers", {
        method: "POST",
        body: JSON.stringify({ servers: message.servers, expected_version: message.expectedVersion })
      });

    case "lbp-server-test":
      return request("/v1/servers/test", {
        method: "POST",
        body: JSON.stringify({ name: message.name, config: message.config })
      });

    case "lbp-context-workspaces":
      return request("/v1/context/workspaces");

    case "lbp-context-choose-folder":
      return request("/v1/context/choose-folder", {
        method: "POST",
        body: JSON.stringify({})
      });

    default:
      throw new Error(`unknown message type ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;
  if (!validSender(message, sender)) {
    sendResponse({ ok: false, error: "request rejected: invalid extension sender" });
    return;
  }
  if (message.type === "lbp-open-options") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }
  handle(message, sender)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({
      ok: false,
      error: String(error.message || error),
      conflict: error.isConflict === true,
      state: error.conflictState || null
    }));
  return true;
});
