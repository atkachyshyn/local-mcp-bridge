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
  let insertedBridgeResult = null;
  let insertedBridgeDelivery = null;
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[type="submit"]'
  ];
  const STOP_SELECTORS = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop streaming"]'
  ];

  function logTransport(event, detail = {}) {
    try { console.debug("[LBP transport]", event, detail); } catch (_) { /* debug only */ }
  }

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

    // Locale-independent fallback.
    //
    // Every aria-label above is English. ChatGPT localizes them, so on a
    // Ukrainian UI nothing matched: findSendButton returned null, canSubmit()
    // was therefore false, and the chain stopped dead with the result sitting in
    // the composer waiting for a human to press Enter. The submit control
    // carries a stable, untranslated class instead. It doubles as the voice
    // button when there is nothing to send -- identified by its sprite id, which
    // is not localized either -- so both guards are required before we click it.
    if (!composerText(composer).trim()) return null;
    const candidate = form.querySelector("button.composer-submit-button-color");
    if (!(candidate instanceof HTMLButtonElement)) return null;
    if (candidate.querySelector('use[href*="voice"], use[href*="microphone"]')) return null;
    return candidate;
  }

  // The last resort, and the one the person has been doing by hand: Enter in the
  // composer. Locale-proof and markup-proof -- it needs no button at all.
  function pressEnter(composer) {
    if (!composer) return false;
    const init = {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true
    };
    composer.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      try { composer.dispatchEvent(new KeyboardEvent(type, init)); } catch (_) { return false; }
    }
    return true;
  }

  function isGenerating() {
    return STOP_SELECTORS.some((selector) => document.querySelector(selector));
  }

  // Submittable does not mean "we found an English button". A composer with
  // content, inside a form, on an idle provider, can always be submitted -- by
  // button if we can identify one, by Enter if we cannot.
  function canSubmit() {
    const composer = findComposer();
    if (!composer || isGenerating()) return false;
    if (!composerText(composer).trim()) return false;
    const button = findSendButton(composer);
    if (button) {
      return !button.disabled && button.getAttribute("aria-disabled") !== "true";
    }
    return Boolean(composer.closest("form"));
  }

  // --- Provider turns ---------------------------------------------------------

  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;
  const BLOCK_TEXT_TAGS = new Set([
    "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "FIGCAPTION", "FIGURE",
    "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
    "LI", "MAIN", "OL", "P", "PRE", "SECTION", "TABLE", "TBODY", "TD",
    "TFOOT", "TH", "THEAD", "TR", "UL"
  ]);
  const SKIP_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "SVG"]);

  function normalizeText(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  function semanticText(node) {
    if (!node) return "";
    if (node.nodeType === TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== ELEMENT_NODE) {
      return String(node.innerText || node.textContent || "");
    }
    const tag = String(node.tagName || "").toUpperCase();
    if (SKIP_TEXT_TAGS.has(tag)) return "";
    if (tag === "BR") return "\n";
    if ((node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) && "value" in node) {
      return node.value || "";
    }
    if (!node.childNodes || typeof node.childNodes[Symbol.iterator] !== "function") {
      return String(node.innerText || node.textContent || "");
    }
    const text = Array.from(node.childNodes).map(semanticText).join("");
    return BLOCK_TEXT_TAGS.has(tag) ? `\n${text}\n` : text;
  }

  function sourceText(node) {
    if (!node) return "";
    return normalizeText(semanticText(node));
  }

  function renderedNodeText(node) {
    if (!node) return "";
    return normalizeText(String(node.innerText || node.textContent || ""));
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text || "")));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // A stable provider turn id. ChatGPT exposes data-message-id on every rendered
  // turn; when it is missing we fall back to a content hash, which is stable for
  // the same rendered text but explicitly marked so callers can treat it as
  // weaker evidence.
  async function turnId(host, { conversationId = "" } = {}) {
    const providerId = host?.getAttribute?.("data-message-id")
      || host?.closest?.("[data-message-id]")?.getAttribute("data-message-id")
      || null;
    if (providerId) return { id: providerId, stable: true, source: "data-message-id" };
    const role = host?.getAttribute?.("data-message-author-role") || "";
    const text = sourceText(host).trim();
    if (!text) return null;
    const hash = await sha256Hex([conversationId, role, text].join("\0"));
    return { id: `hash:${hash}`, stable: false, source: "sha256" };
  }

  function messageHosts() {
    return Array.from(document.querySelectorAll("[data-message-author-role]"));
  }

  async function providerTurns({ conversationId = "" } = {}) {
    const all = [];
    for (const host of messageHosts()) {
      const role = host.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") continue;
      const identity = await turnId(host, { conversationId });
      if (!identity?.id) continue;
      all.push({ role, host, ...identity });
    }
    return {
      all,
      user: all.filter((turn) => turn.role === "user"),
      assistant: all.filter((turn) => turn.role === "assistant")
    };
  }

  async function latestTurns(options = {}) {
    const turns = await providerTurns(options);
    return {
      user: turns.user[turns.user.length - 1] || null,
      assistant: turns.assistant[turns.assistant.length - 1] || null
    };
  }

  // ChatGPT can render a code block as an outer markdown <pre> that wraps a
  // second content <pre>. Keep only the outermost node when a caller needs a
  // code-block view.
  function protocolBlocks(host) {
    const all = Array.from(host?.querySelectorAll?.("pre") || []);
    return all.filter((node) => !all.some((other) => other !== node && other.contains(node)));
  }

  // ChatGPT does not always render USER fenced content as <pre><code>. Long
  // user turns may live in its own collapsible-message surface. For a STRICT
  // pure LBP result only, identify the smallest descendant whose semantic text
  // is exactly the result envelope. Assistant prose never uses this fallback.
  function rawPureResultBlock(host) {
    if (!host || host.getAttribute?.("data-message-author-role") !== "user") return null;
    const nodes = [host, ...Array.from(host.querySelectorAll?.("pre, code, div, p, span") || [])];
    const valid = [];
    for (const node of nodes) {
      const text = sourceText(node).trim();
      if (!text.includes("<LBP_RESULT>") || !text.includes("</LBP_RESULT>")) continue;
      const parsed = globalThis.LBP.parsePureResultEnvelope(text);
      if (parsed) valid.push({ node, parsed, textLength: text.length });
    }
    if (!valid.length) return null;
    valid.sort((a, b) => {
      if (a.node.contains?.(b.node)) return 1;
      if (b.node.contains?.(a.node)) return -1;
      return a.textLength - b.textLength;
    });
    return valid[0];
  }

  function taskSources(host) {
    const blockSources = [];
    const seen = new Set();
    for (const block of protocolBlocks(host)) {
      const text = renderedNodeText(block);
      if (!text.includes("<LBP_TASK>") || seen.has(text)) continue;
      seen.add(text);
      blockSources.push({ text, source: "code_block" });
    }

    const wholeTurn = sourceText(host);
    const turnSources = wholeTurn.includes("<LBP_TASK>") && !seen.has(wholeTurn)
      ? [{ text: wholeTurn, source: "turn" }]
      : [];
    return { blockSources, turnSources };
  }

  function extractTasksFromSources(host, sources) {
    const found = [];
    for (const source of sources) {
      found.push(...globalThis.LBP.extractTasks(source.text)
        .map((task) => ({ task, host, source: source.source })));
    }
    return found;
  }

  function tasksIn(host) {
    const { blockSources, turnSources } = taskSources(host);
    const blockTasks = extractTasksFromSources(host, blockSources);
    if (blockTasks.length) return blockTasks;
    return extractTasksFromSources(host, turnSources);
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
    if (malformed.length) return { kind: "malformed", error: malformed[0].task.__parse_error };
    if (valid.length === 1) {
      return {
        kind: "one",
        task: valid[0].task,
        fingerprint: globalThis.LBP.canonicalJson(valid[0].task)
      };
    }
    return { kind: "none" };
  }

  // A user turn is a bridge result only if it is a STRICT pure result envelope.
  // A message that merely contains one alongside other text is a human turn.
  function pureResultIn(host) {
    if (!host) return null;
    const whole = globalThis.LBP.parsePureResultEnvelope(sourceText(host));
    if (whole) return whole;
    const blocks = protocolBlocks(host);
    if (blocks.length === 1) {
      const before = sourceText(host).replace(sourceText(blocks[0]), "").trim();
      if (!before) {
        const parsed = globalThis.LBP.parsePureResultEnvelope(sourceText(blocks[0]));
        if (parsed) return parsed;
      }
    }
    return rawPureResultBlock(host)?.parsed || null;
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

  // Whether the composer holds the result we are about to send.
  //
  // Deliberately more forgiving than composerMatches: purity decides whether an
  // INCOMING turn is a bridge turn, but here we already know what we put in the
  // box and only need to confirm it survived. Requiring purity meant a composer
  // the provider had touched at all -- a stray newline, the workflow bootstrap --
  // failed the check, no send was clicked, and the result sat there for the user
  // to submit by hand.
  function composerHoldsResult(expectedResult) {
    if (composerMatches(expectedResult)) return true;
    const text = composerText();
    if (!text.includes("<LBP_RESULT>")) return false;
    return globalThis.LBP.extractResults(text)
      .filter((value) => value && !value.__parse_error)
      .some((value) => globalThis.LBP.semanticallyEqual(value, expectedResult));
  }

  function normalizeDelivery(result, delivery = {}) {
    const deliveryId = delivery.delivery_id || delivery.deliveryId;
    const taskId = delivery.task_id || delivery.taskId || result?.task_id;
    if (typeof deliveryId !== "string" || !deliveryId.trim()) {
      throw new Error("delivery_id is required for result delivery");
    }
    if (typeof taskId !== "string" || !taskId.trim()) {
      throw new Error("task_id is required for result delivery");
    }
    return {
      result,
      task_id: taskId.trim(),
      delivery_id: deliveryId.trim(),
      result_digest: delivery.result_digest || delivery.resultDigest || null,
      conversation_id: delivery.conversation_id || delivery.conversationId || null
    };
  }

  function deliveryMarker(delivery) {
    const taskId = delivery.task_id || delivery.taskId || delivery.result?.task_id;
    const deliveryId = delivery.delivery_id || delivery.deliveryId;
    return `LBP result \u00b7 task=${taskId} \u00b7 delivery=${deliveryId}`;
  }

  function textContainsDelivery(text, delivery) {
    const normalized = String(text || "");
    const taskId = delivery.task_id || delivery.taskId || delivery.result?.task_id;
    const deliveryId = delivery.delivery_id || delivery.deliveryId;
    return Boolean(
      taskId && deliveryId
      && normalized.includes(`task=${taskId}`)
      && normalized.includes(`delivery=${deliveryId}`)
    );
  }

  function deliveryText(result, delivery) {
    const normalized = normalizeDelivery(result, delivery);
    return `${deliveryMarker(normalized)}\n\n${globalThis.LBP.resultEnvelope(result)}`;
  }

  function composerHoldsDelivery(delivery) {
    return textContainsDelivery(composerText(), delivery);
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

  // Replaces the composer's whole content. Every caller must have established
  // that what is being replaced is ours to replace -- this destroys a draft.
  // Clipboard access can be unavailable (no permission, not a secure context).
  // It is a fallback, so it must never throw and take the caller down with it.
  async function copyToClipboard(text) {
    try {
      await globalThis.navigator?.clipboard?.writeText?.(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  function writeComposer(composer, next, { allowOverwriteOf = null } = {}) {
    if (allowOverwriteOf !== null) {
      const current = composerText(composer).trim();
      if (current && current !== String(allowOverwriteOf).trim()) return false;
    }
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
  async function insertResult(result, delivery, options = {}) {
    const normalizedDelivery = normalizeDelivery(result, delivery);
    const text = deliveryText(result, normalizedDelivery);
    const composer = findComposer();
    if (!composer) {
      logTransport("composer_found", { found: false });
      await copyToClipboard(text);
      return { inserted: false, reason: "composer_unavailable", copied: true };
    }
    logTransport("composer_found", { found: true });

    // NEVER overwrite something the person typed.
    //
    // writeComposer selects the whole composer and replaces it, and this guard
    // used to be optional (`requireEmpty`), which two of the three call sites
    // passed as false. A draft in the box was silently destroyed and the bridge
    // result was sent in its place, so the person's question never existed as a
    // message and the reply they got answered something they never asked.
    //
    // The only content we may replace is our own: an empty box, or one that
    // already holds this exact delivery marker/result.
    const current = composerText(composer).trim();
    if (current && !composerHoldsDelivery(normalizedDelivery) && !composerHoldsResult(result)) {
      await copyToClipboard(text);
      return { inserted: false, reason: "composer_not_empty", copied: true };
    }
    void options;
    composer.focus();
    writeComposer(composer, text);
    if (composerHoldsDelivery(normalizedDelivery)) {
      insertedBridgeResult = result;
      insertedBridgeDelivery = normalizedDelivery;
      logTransport("result_inserted", {
        task_id: normalizedDelivery.task_id,
        delivery_id: normalizedDelivery.delivery_id
      });
      return { inserted: true };
    }
    await copyToClipboard(text);
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

    // One send fires several DOM events: Enter produces keydown AND submit, a
    // click produces click AND submit. Without coalescing, the callback ran two
    // or three times for a single send, which prepended the workflow bootstrap
    // two or three times into the same message.
    let lastNotify = 0;
    function notify(event) {
      const text = composerText().trim();
      if (!text) return;
      // Never arm a new human chain for a result that this adapter inserted.
      // Rich-editor normalization can make strict parsing fail while the exact
      // semantic result is no longer inline, so bind this to the delivery marker.
      if (insertedBridgeDelivery && composerHoldsDelivery(insertedBridgeDelivery)) return;
      if (insertedBridgeResult && composerHoldsResult(insertedBridgeResult)) return;
      if (composerResult()) return;
      const now = Date.now();
      if (now - lastNotify < 400) return;
      lastNotify = now;
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
  // whose ordinary visible text contains the expected delivery marker. The full
  // result body may become a provider attachment and disappear from rendered DOM.
  async function waitUntilSubmittable(delivery, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const composer = findComposer();
      if (!composerHoldsDelivery(delivery)) return { ready: false, reason: "composer_changed" };
      if (composer && !isGenerating()) {
        const form = composer.closest("form");
        const button = findSendButton(composer);
        const buttonReady = !button || (!button.disabled && button.getAttribute("aria-disabled") !== "true");
        if (form && buttonReady) return { ready: true, composer, form, button };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { ready: false, reason: "send_not_ready" };
  }

  function dispatchSubmit(strategy, form, button, composer) {
    if (strategy === "button" && button) {
      try {
        logTransport("send_button_clicked", {});
        button.click();
        return true;
      } catch (_) { return false; }
    }
    if (strategy === "requestSubmit") {
      try {
        if (typeof form?.requestSubmit !== "function") return false;
        if (button && button.form === form && !button.disabled) form.requestSubmit(button);
        else form.requestSubmit();
        return true;
      } catch (_) { return false; }
    }
    if (strategy === "enter") return pressEnter(composer);
    return false;
  }

  async function acknowledgementFromNewUserTurn(delivery, before) {
    const turns = await providerTurns({ conversationId: delivery.conversation_id || "" });
    for (const turn of turns.user) {
      if (!turn.id || before.has(turn.id)) continue;
      if (textContainsDelivery(sourceText(turn.host), delivery)) {
        logTransport("result_user_turn_observed", {
          turn_id: turn.id,
          task_id: delivery.task_id || null,
          delivery_id: delivery.delivery_id || null
        });
        return {
          submitted: true,
          turnId: turn.id,
          delivery_id: delivery.delivery_id,
          result_digest: delivery.result_digest || null
        };
      }
    }
    return null;
  }

  async function waitForProviderAcknowledgement(delivery, before, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const acknowledged = await acknowledgementFromNewUserTurn(delivery, before);
      if (acknowledged) return acknowledged;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return null;
  }

  async function submitAndAwaitAcknowledgement(delivery, timeoutMs = 20000) {
    if (!composerHoldsDelivery(delivery)) return { submitted: false, reason: "composer_changed" };

    const before = new Set(
      (await providerTurns({ conversationId: delivery.conversation_id || "" })).user
        .map((turn) => turn.id)
    );

    const readiness = await waitUntilSubmittable(delivery, Math.min(6000, timeoutMs));
    if (!readiness.ready) return { submitted: false, reason: readiness.reason };
    if (!composerHoldsDelivery(delivery)) return { submitted: false, reason: "composer_changed" };

    // ChatGPT's React composer currently reacts more reliably to the actual send
    // button click than to requestSubmit(). Use progressively weaker fallbacks,
    // and require a real new user turn before declaring success.
    const strategies = readiness.button
      ? ["button", "requestSubmit", "enter"]
      : ["requestSubmit", "enter"];
    const perAttempt = Math.max(900, Math.min(3500, Math.floor(timeoutMs / strategies.length)));

    for (const strategy of strategies) {
      if (!composerHoldsDelivery(delivery)) {
        const ack = await waitForProviderAcknowledgement(delivery, before, 1200);
        if (ack) { insertedBridgeResult = null; insertedBridgeDelivery = null; return ack; }
        return { submitted: false, reason: "composer_changed" };
      }
      if (!dispatchSubmit(strategy, readiness.form, readiness.button, readiness.composer)) continue;
      logTransport("send_attempt", { strategy });
      const ack = await waitForProviderAcknowledgement(delivery, before, perAttempt);
      if (ack) { insertedBridgeResult = null; insertedBridgeDelivery = null; return ack; }
      if (!composerHoldsDelivery(delivery)) {
        const lateAck = await waitForProviderAcknowledgement(
          delivery,
          before,
          Math.max(1000, timeoutMs - perAttempt)
        );
        if (lateAck) { insertedBridgeResult = null; insertedBridgeDelivery = null; return lateAck; }
        logTransport("delivery_timeout", { reason: "sent_without_observed_turn" });
        return { submitted: false, reason: "no_provider_acknowledgement" };
      }
    }

    const finalAck = await waitForProviderAcknowledgement(
      delivery, before, Math.max(1000, timeoutMs - perAttempt * strategies.length)
    );
    if (finalAck) { insertedBridgeResult = null; insertedBridgeDelivery = null; return finalAck; }
    logTransport("delivery_timeout", { reason: "no_provider_acknowledgement" });
    return { submitted: false, reason: "no_provider_acknowledgement" };
  }

  return Object.freeze({
    id: "chatgpt",
    providerHost: () => location.hostname,
    messageHosts,
    providerTurns,
    protocolBlocks,
    rawPureResultBlock,
    tasksIn,
    taskSources,
    turnId,
    latestTurns,
    assistantTaskState,
    pureResultIn,
    sourceText,
    renderedNodeText,
    composerText,
    composerResult,
    composerMatches,
    composerHoldsResult,
    deliveryMarker,
    deliveryText,
    textContainsDelivery,
    composerHoldsDelivery,
    isGenerating,
    canSubmit,
    waitUntilIdle,
    insertResult,
    prependComposerText,
    onBeforeUserSend,
    submitAndAwaitAcknowledgement
  });
})();
