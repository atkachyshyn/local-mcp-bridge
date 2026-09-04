// ChatGPT provider adapter.
//
// This file owns everything ChatGPT-specific and nothing else. It answers only
// questions about provider turns and the composer:
//
//   what is the latest user turn? the latest assistant turn?
//   does this assistant turn contain zero / one / many LBP tasks?
//   is generation complete? what is in the composer?
//   did the provider actually accept a submission?
//
// It never decides chain identity, task currentness, checkpoint scope, staleness
// or approval scope. Those are daemon-owned. DOM is evidence of provider turns,
// never execution authority.
globalThis.LBP_PROVIDER_ADAPTER = (() => {
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]'
  ];
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop streaming"]'
  ];

  function findComposer() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[data-testid="prompt-textarea"]') ||
      document.querySelector('div[contenteditable="true"][data-virtualkeyboard="true"]') ||
      document.querySelector('textarea[placeholder*="Message"]')
    );
  }

  function composerText(composer = findComposer()) {
    if (!composer) return "";
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return composer.value || "";
    }
    return composer.innerText || composer.textContent || "";
  }

  function findSendButton(composer = findComposer()) {
    if (!composer) return null;
    const form = composer.closest("form");
    if (!form) return null;
    for (const selector of SEND_SELECTORS) {
      const button = form.querySelector(selector);
      if (button instanceof HTMLButtonElement) return button;
    }
    return null;
  }

  function isGenerating() {
    return STOP_SELECTORS.some((selector) => document.querySelector(selector));
  }

  function canSubmit() {
    const composer = findComposer();
    const button = findSendButton(composer);
    return Boolean(button && !button.disabled && button.getAttribute("aria-disabled") !== "true" && !isGenerating());
  }

  // --- Provider turns ---------------------------------------------------------

  function sourceText(node) {
    return String(node?.textContent || node?.innerText || "");
  }

  // A stable provider turn id. ChatGPT exposes data-message-id on every rendered
  // turn; when it is missing we fall back to a content hash, which is stable for
  // the same rendered text but explicitly marked so callers can treat it as
  // weaker evidence.
  function turnId(host) {
    const id = host?.getAttribute?.("data-message-id")
      || host?.closest?.("[data-message-id]")?.getAttribute("data-message-id")
      || host?.id
      || null;
    if (id) return { id: `msg:${id}`, stable: true };
    const text = sourceText(host).trim().slice(0, 8192);
    if (!text) return null;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return { id: `text:${(hash >>> 0).toString(16).padStart(8, "0")}`, stable: false };
  }

  function messageHosts() {
    return Array.from(document.querySelectorAll("[data-message-author-role]"));
  }

  function protocolBlocks(host) {
    return Array.from(host?.querySelectorAll?.("pre") || []);
  }

  function tasksIn(host) {
    const found = [];
    for (const block of protocolBlocks(host)) {
      for (const task of globalThis.LBP.extractTasks(sourceText(block))) {
        found.push({ task, block });
      }
    }
    return found;
  }

  // The latest rendered turn of each role. Reconciliation works from the latest
  // turns rather than reconstructing history, because history is exactly what
  // virtualization removes.
  function latestTurns() {
    const hosts = messageHosts();
    let user = null;
    let assistant = null;
    for (let i = hosts.length - 1; i >= 0; i -= 1) {
      const host = hosts[i];
      const role = host.getAttribute("data-message-author-role");
      if (role === "user" && !user) user = host;
      if (role === "assistant" && !assistant) assistant = host;
      if (user && assistant) break;
    }
    return {
      user: user ? { host: user, ...(turnId(user) || {}) } : null,
      assistant: assistant ? { host: assistant, ...(turnId(assistant) || {}) } : null
    };
  }

  // The whole assistant response is one unit. Two tasks in two separate code
  // blocks of one message is still two tasks, and is rejected -- the caller gets
  // {kind:"multiple"} rather than a silently-chosen first task.
  function assistantTaskState(host) {
    if (!host) return { kind: "none" };
    const found = tasksIn(host);
    const malformed = found.filter((entry) => entry.task?.__parse_error);

    // The provider re-renders a message while and after it streams, which can
    // leave the same task in more than one code block. That is ONE task shown
    // twice, not a multi-task reply -- collapsing identical tasks first keeps
    // the one-task-per-turn rule meaningful while stopping a duplicated render
    // from wrongly killing the chain.
    const seen = new Set();
    const valid = [];
    for (const entry of found) {
      if (entry.task?.__parse_error) continue;
      const fingerprint = globalThis.LBP.canonicalJson(entry.task);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      valid.push(entry);
    }

    // Two genuinely different tasks in one reply is still a violation.
    if (valid.length > 1) return { kind: "multiple", count: valid.length };
    if (valid.length === 1) return { kind: "one", task: valid[0].task, block: valid[0].block };
    if (malformed.length) return { kind: "malformed", error: malformed[0].task.__parse_error };
    return { kind: "none" };
  }

  // A user turn is a bridge result only if it is a STRICT pure result envelope.
  // A message that merely contains one alongside other text is a human turn.
  function pureResultIn(host) {
    if (!host) return null;
    const whole = globalThis.LBP.parsePureResultEnvelope(sourceText(host));
    if (whole) return whole;
    const blocks = protocolBlocks(host);
    if (blocks.length !== 1) return null;
    const before = sourceText(host).replace(sourceText(blocks[0]), "").trim();
    if (before) return null;
    return globalThis.LBP.parsePureResultEnvelope(sourceText(blocks[0]));
  }

  // --- Composer ---------------------------------------------------------------

  function composerResult() {
    return globalThis.LBP.parsePureResultEnvelope(composerText());
  }

  // Semantic, not byte-for-byte: the composer reflows whitespace and re-indents,
  // so byte comparison produces false negatives. Strictness lives in the parse --
  // anything that is not exactly one envelope and nothing else fails to parse at
  // all and can never reach this comparison.
  function composerMatches(expectedResult) {
    const actual = composerResult();
    if (!actual) return false;
    return globalThis.LBP.semanticallyEqual(actual, expectedResult);
  }

  async function waitUntilIdle(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let stableSince = 0;
    while (Date.now() < deadline) {
      if (!isGenerating() && findComposer()) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 500) return true;
      } else {
        stableSince = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  function writeComposer(composer, next) {
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(composer, next);
      else composer.value = next;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, next);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: next }));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Insertion is verified SEMANTICALLY before it reports success -- what landed
  // in the composer must parse back to the exact result we meant to deliver.
  async function insertResult(result, options = {}) {
    const text = globalThis.LBP.resultEnvelope(result);
    const composer = findComposer();
    if (!composer) {
      await navigator.clipboard.writeText(text).catch(() => {});
      return { inserted: false, reason: "composer_unavailable", copied: true };
    }
    if (options.requireEmpty === true && composerText(composer).trim()) {
      return { inserted: false, reason: "composer_not_empty" };
    }
    composer.focus();
    writeComposer(composer, text);
    if (composerMatches(result)) return { inserted: true };
    await navigator.clipboard.writeText(text).catch(() => {});
    return { inserted: false, reason: "composer_verification_failed", copied: true };
  }

  function prependComposerText(text) {
    const composer = findComposer();
    const prefix = String(text || "").trim();
    if (!composer || !prefix) return { prepended: false, reason: "composer_unavailable" };
    const current = composerText(composer);
    const next = current.trim() ? `${prefix}\n\n${current}` : prefix;
    composer.focus();
    if (!writeComposer(composer, next)) return { prepended: false, reason: "composer_update_failed" };
    return { prepended: composerText(composer).includes(prefix.slice(0, 24)), text: next };
  }

  // --- Send and acknowledgement ------------------------------------------------

  // Fires when the user is about to send something that is NOT a pure bridge
  // result. This only ARMS the daemon; it never creates a chain, so a keydown
  // that is blocked or aborted costs nothing. The chain is created later, when
  // the provider has actually produced the turn.
  function onBeforeUserSend(callback) {
    if (typeof callback !== "function") throw new Error("onBeforeUserSend requires a callback");

    function notify(event) {
      const text = composerText().trim();
      if (!text) return;
      if (composerResult()) return;   // strict pure result -> bridge turn, not human
      callback({ event, text });
    }

    const submitHandler = (event) => {
      const composer = findComposer();
      if (!composer || event.target !== composer.closest("form")) return;
      notify(event);
    };
    const clickHandler = (event) => {
      const send = findSendButton(findComposer());
      if (!send || (event.target !== send && !send.contains?.(event.target))) return;
      notify(event);
    };
    const keyHandler = (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      const composer = findComposer();
      if (!composer || (event.target !== composer && !composer.contains?.(event.target))) return;
      notify(event);
    };

    document.addEventListener("submit", submitHandler, true);
    document.addEventListener("click", clickHandler, true);
    document.addEventListener("keydown", keyHandler, true);
    return () => {
      document.removeEventListener("submit", submitHandler, true);
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("keydown", keyHandler, true);
    };
  }

  // Clicking send is not proof of submission. Acknowledgement is a NEW user turn
  // whose content parses back to the exact result we submitted. Composer-clear is
  // secondary evidence only and never sufficient on its own -- the daemon
  // advances the checkpoint window on this signal, so it must mean what it says.
  async function submitAndAwaitAcknowledgement(result, timeoutMs = 20000) {
    if (!composerMatches(result)) return { submitted: false, reason: "composer_changed" };
    if (!canSubmit()) return { submitted: false, reason: "send_not_ready" };
    const button = findSendButton(findComposer());
    if (!button) return { submitted: false, reason: "send_button_missing" };

    const before = new Set(
      messageHosts()
        .filter((host) => host.getAttribute("data-message-author-role") === "user")
        .map((host) => turnId(host)?.id)
        .filter(Boolean)
    );

    if (!composerMatches(result)) return { submitted: false, reason: "composer_changed" };
    button.click();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const host of messageHosts()) {
        if (host.getAttribute("data-message-author-role") !== "user") continue;
        const identity = turnId(host);
        if (!identity || before.has(identity.id)) continue;
        const parsed = pureResultIn(host);
        if (parsed && globalThis.LBP.semanticallyEqual(parsed, result)) {
          return { submitted: true, turnId: identity.id, result: parsed };
        }
      }
    }
    return { submitted: false, reason: "no_provider_acknowledgement" };
  }

  return Object.freeze({
    id: "chatgpt",
    providerHost: () => location.hostname,
    messageHosts,
    protocolBlocks,
    tasksIn,
    turnId,
    latestTurns,
    assistantTaskState,
    pureResultIn,
    sourceText,
    composerText,
    composerResult,
    composerMatches,
    isGenerating,
    canSubmit,
    waitUntilIdle,
    insertResult,
    prependComposerText,
    onBeforeUserSend,
    submitAndAwaitAcknowledgement
  });
})();
