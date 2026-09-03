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

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function markerCount(text, marker) {
    return String(text || "").split(marker).length - 1;
  }

  function composerMatches(text) {
    const actual = composerText();
    const expected = String(text || "");
    if (markerCount(actual, "<LBP_RESULT>") !== 1 || markerCount(actual, "</LBP_RESULT>") !== 1) {
      return false;
    }
    return normalizedText(actual) === normalizedText(expected);
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

  async function insertResult(text, options = {}) {
    const composer = findComposer();
    const requireEmpty = options.requireEmpty === true;
    if (composer) {
      if (requireEmpty && composerText(composer).trim()) {
        return { inserted: false, reason: "composer_not_empty" };
      }
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const current = composer.value || "";
        const next = current ? `${current}\n\n${text}` : text;
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(composer, next);
        else composer.value = next;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
        return { inserted: true };
      }
      try {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        const prefix = composerText(composer).trim() ? "\n\n" : "";
        document.execCommand("insertText", false, prefix + text);
        composer.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: prefix + text
        }));
        return { inserted: composerText(composer).includes("<LBP_RESULT>") };
      } catch (_) {
        // Clipboard fallback below.
      }
    }
    await navigator.clipboard.writeText(text);
    return { inserted: false, reason: "composer_unavailable", copied: true };
  }

  async function submitComposer(expectedText = null) {
    if (expectedText !== null && !composerMatches(expectedText)) {
      return { submitted: false, reason: "composer_changed" };
    }
    if (!canSubmit()) return { submitted: false, reason: "send_not_ready" };
    const button = findSendButton(findComposer());
    if (!button) return { submitted: false, reason: "send_button_missing" };
    // Close the last mutation window between the caller's match check and click.
    if (expectedText !== null && !composerMatches(expectedText)) {
      return { submitted: false, reason: "composer_changed" };
    }
    button.click();
    return { submitted: true };
  }

  function allMessageHosts() {
    return Array.from(document.querySelectorAll('[data-message-author-role]'));
  }

  return Object.freeze({
    id: "chatgpt",
    providerHost: () => location.hostname,
    findTaskHosts: () => Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')),
    findResultHosts: () => Array.from(document.querySelectorAll('[data-message-author-role="user"]')),
    findLastMessageHost: () => {
      const hosts = allMessageHosts();
      return hosts.length ? hosts[hosts.length - 1] : null;
    },
    composerText,
    isGenerating,
    canSubmit,
    composerMatches,
    waitUntilIdle,
    insertResult,
    submitComposer
  });
})();
