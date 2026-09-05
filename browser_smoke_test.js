// Browser-side regression suite for Local MCP Bridge v0.9.2.
//
// Covers the protocol validator and the provider adapter. The invariants here
// are the ones that must hold before the coordinator is allowed to trust the
// DOM at all -- protocol version freeze, strict pure-result identification, and
// one-task-per-assistant-turn.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push({ name, fn });
}
function section(name) {
  pending.push({ section: name });
}
async function run() {
  for (const entry of pending) {
    if (entry.section) { console.log(`\n${entry.section}`); continue; }
    await entry.fn();
    passed += 1;
    console.log(`  ok  ${entry.name}`);
  }
  console.log(`\nbrowser smoke test: ${passed} checks passed\n`);
}

// --- Minimal DOM double ------------------------------------------------------

class FakeTextArea {}
class FakeInput {}
class FakeButton {
  constructor() { this.disabled = false; this.attrs = new Map(); this.clicked = 0; }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  click() { this.clicked += 1; }
  // The submit control doubles as the voice button when there is nothing to
  // send; its sprite id is how they are told apart without reading a label.
  querySelector(selector) {
    return this.voice && String(selector).includes('voice') ? {} : null;
  }
}
global.HTMLTextAreaElement = FakeTextArea;
global.HTMLInputElement = FakeInput;
global.HTMLButtonElement = FakeButton;

function makeBlock(text, nested = []) {
  // `nested` models ChatGPT's real shape: the markdown <pre> WRAPS a second
  // CodeMirror <pre> carrying the same text.
  return {
    tagName: 'PRE',
    textContent: text,
    innerText: text,
    hidden: false,
    nested,
    contains(other) { return other === this || this.nested.includes(other); },
    querySelector() { return null; }
  };
}

// A ChatGPT-shaped nest: the outer block and the inner one the DOM would also
// return from querySelectorAll('pre').
function makeNestedBlocks(text) {
  const inner = makeBlock(text);
  const outer = makeBlock(text, [inner]);
  return [outer, inner];
}

function makeHost(role, blocks, id, { proseBefore = '', proseAfter = '' } = {}) {
  const host = {
    role,
    blocks,
    proseBefore,
    proseAfter,
    attrs: new Map([['data-message-author-role', role]]),
    // The real DOM counts nested nodes' text once, not once per <pre>.
    get textContent() {
      const blockText = this.blocks
        .filter((b) => !this.blocks.some((o) => o !== b && o.contains?.(b)))
        .map((b) => b.textContent)
        .join('\n');
      return [this.proseBefore, blockText, this.proseAfter].filter(Boolean).join('\n');
    },
    get innerText() { return this.textContent; },
    getAttribute(name) { return this.attrs.get(name) ?? null; },
    closest() { return null; },
    querySelectorAll(selector) { return selector === 'pre' ? this.blocks : []; }
  };
  if (id) host.attrs.set('data-message-id', id);
  return host;
}

const send = new FakeButton();
// ChatGPT localizes every aria-label. `locale` switches the double between an
// English UI (labels match) and a translated one (they do not), which is the
// case that stopped the chain in real use.
let locale = 'en';
let nativeSubmits = 0;
const form = {
  requestSubmit() { nativeSubmits += 1; },
  querySelector(selector) {
    const labelled = selector.includes('send-button') || selector.includes('Send prompt')
      || selector.includes('Send message') || selector.includes('type="submit"');
    if (labelled) return locale === 'en' ? send : null;
    if (selector.includes('composer-submit-button-color')) return send;
    return null;
  }
};
class FakeKeyboardEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}
global.KeyboardEvent = FakeKeyboardEvent;

const composer = {
  innerText: '', textContent: '',
  keys: [],
  closest: (tag) => (tag === 'form' ? form : null),
  focus() {},
  dispatchEvent(event) {
    if (event instanceof FakeKeyboardEvent) this.keys.push(`${event.type}:${event.key}`);
    return true;
  }
};
let allMessages = [];

// Minimal capture-phase event plumbing, enough for the pre-send hook.
const listeners = new Map();
global.document = {
  querySelector(selector) {
    if (selector === '#prompt-textarea') return composer;
    return null;
  },
  querySelectorAll(selector) {
    return selector === '[data-message-author-role]' ? allMessages : [];
  },
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    listeners.get(type)?.delete(fn);
  },
  dispatchEvent(event) {
    for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
    return true;
  }
};
global.Event = class { constructor(type) { this.type = type; this.target = null; } };
global.InputEvent = global.Event;
// Enough contenteditable plumbing for writeComposer's replace-all path.
global.window = {
  getSelection: () => ({ removeAllRanges() {}, addRange() {} })
};
document.createRange = () => ({ selectNodeContents() {}, collapse() {} });
document.execCommand = (_cmd, _ui, text) => {
  composer.innerText = text;
  composer.textContent = text;
  return true;
};
global.navigator = { clipboard: { writeText: async () => {} } };
global.location = { hostname: 'chatgpt.com' };

vm.runInThisContext(fs.readFileSync('extension/protocol.js', 'utf8'), { filename: 'protocol.js' });
vm.runInThisContext(fs.readFileSync('extension/adapters/chatgpt.js', 'utf8'), { filename: 'chatgpt.js' });
const LBP = globalThis.LBP;
const adapter = globalThis.LBP_PROVIDER_ADAPTER;

// --- Protocol freeze ---------------------------------------------------------

section('protocol freeze');

check('LBP 1.2, 1.3 and 1.3.1 are the supported runtime versions', () => {
  assert.deepEqual([...LBP.SUPPORTED_TASK_VERSIONS].sort(), ['1.2', '1.3', '1.3.1']);
});

check('LBP 1.1 is rejected, not coerced', () => {
  assert.throws(() => LBP.normalizeTask({
    protocol: 'lbp', version: '1.1', id: 'legacy',
    operation: { type: 'mcp.call', server: 'workspace', tool: 'read_file', arguments: {} }
  }), /1\.1 is historical/);
});

check('legacy task envelopes are no longer scanned', () => {
  assert.deepEqual(LBP.ENVELOPES.map((e) => e.start), ['<LBP_TASK>']);
});

check('version defaults to 1.2', () => {
  const task = LBP.normalizeTask({
    protocol: 'lbp', id: 'default-version',
    operation: { type: 'mcp.call', server: 'workspace', tool: 'read_file', arguments: {} }
  });
  assert.equal(task.version, '1.2');
});

check('mcp.mutate accepts 1.3 and 1.3.1 task semantics but rejects 1.2', () => {
  for (const version of ['1.3', '1.3.1']) {
    const task = LBP.normalizeTask({
      protocol: 'lbp', version, id: `mutate-on-${version}`,
      operation: { type: 'mcp.mutate', server: 'workspace', calls: [{ id: 'a', tool: 'apply_patch', arguments: {} }] }
    });
    assert.equal(task.version, version);
    assert.equal(task.operation.type, 'mcp.mutate');
  }
  assert.throws(() => LBP.normalizeTask({
    protocol: 'lbp', version: '1.2', id: 'mutate-on-12',
    operation: { type: 'mcp.mutate', server: 'workspace', calls: [{ id: 'a', tool: 'apply_patch', arguments: {} }] }
  }), /requires LBP 1\.3 or 1\.3\.1/);
});

check('LBP 1.3 task plan and outputs normalize', () => {
  const task = LBP.normalizeTask({
    protocol: 'lbp', version: '1.3', id: 'planned',
    plan: {
      id: 'stabilize-v092',
      revision: 1,
      title: 'Stabilize Local MCP Bridge v0.9.2',
      items: [{ id: 'p1', phase: 'plan', title: 'Audit current implementation' }],
      context: {
        resources: [{ kind: 'workspace', label: 'local-mcp-bridge' }],
        constraints: ['LBP 1.3']
      }
    },
    plan_item_id: 'p1',
    outputs: [{ id: 'report', label: 'Regression report', kind: 'report', ref: '/tmp/report.txt' }],
    operation: { type: 'mcp.list_tools', server: 'workspace' }
  });
  assert.equal(task.plan.id, 'stabilize-v092');
  assert.equal(task.plan.items[0].status, 'pending');
  assert.equal(task.outputs[0].status, undefined);
});

check('plan metadata is rejected on LBP 1.2 tasks', () => {
  assert.throws(() => LBP.normalizeTask({
    protocol: 'lbp', version: '1.2', id: 'planned-12',
    plan: { id: 'p', revision: 1, items: [{ id: 'a', title: 'A' }] },
    plan_item_id: 'a',
    operation: { type: 'mcp.list_tools', server: 'workspace' }
  }), /requires LBP 1\.3/);
});

check('single-element operations[] still normalizes; longer arrays do not', () => {
  const single = LBP.normalizeTask({
    protocol: 'lbp', version: '1.2', id: 'legacy-single',
    operations: [{ type: 'mcp.call', server: 'workspace', tool: 'read_file', arguments: { path: '/tmp/a' }, mutating: false }]
  });
  assert.equal(single.operation.tool, 'read_file');
  assert.equal(Object.prototype.hasOwnProperty.call(single.operation, 'mutating'), false);
  assert.throws(() => LBP.normalizeTask({
    protocol: 'lbp', version: '1.2', id: 'legacy-many',
    operations: [
      { type: 'mcp.call', server: 'workspace', tool: 'read_file', arguments: {} },
      { type: 'mcp.call', server: 'workspace', tool: 'read_file', arguments: {} }
    ]
  }), /exactly one/);
});

check('model-authored authority fields are rejected', () => {
  assert.throws(() => LBP.normalizeTask({
    protocol: 'lbp', id: 'forged',
    operation: { type: 'mcp.call', server: 'workspace', tool: 'run_command', classification: 'verify', arguments: {} }
  }), /derives classification/);
});

check('observe/mutate call ids must be unique and bounded', () => {
  assert.throws(() => LBP.normalizeTask({
    protocol: 'lbp', id: 'dupe',
    operation: {
      type: 'mcp.observe', server: 'workspace',
      calls: [{ id: 's', tool: 'read_file', arguments: {} }, { id: 's', tool: 'read_file', arguments: {} }]
    }
  }), /unique/);
  assert.throws(() => LBP.normalizeTask({
    protocol: 'lbp', id: 'too-many',
    operation: {
      type: 'mcp.observe', server: 'workspace',
      calls: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, tool: 'read_file', arguments: {} }))
    }
  }), /1\.\.8 calls/);
});

// --- Strict pure-result identification ---------------------------------------

section('pure-result identification');

const RESULT = { protocol: 'lbp', task_id: 't1', status: 'ok', operation: { classification: 'read_only' } };
const pureText = LBP.resultEnvelope(RESULT);
const DELIVERY = {
  result: RESULT,
  task_id: RESULT.task_id,
  delivery_id: 'd-browser-smoke-1',
  result_digest: 'sha256-browser-smoke'
};

check('a pure result envelope parses', () => {
  assert.ok(LBP.parsePureResultEnvelope(pureText));
});

check('semantic equality ignores key order and whitespace', () => {
  const reflowed = '```text\n<LBP_RESULT>\n' +
    JSON.stringify({ status: 'ok', operation: { classification: 'read_only' }, task_id: 't1', protocol: 'lbp' }) +
    '\n</LBP_RESULT>\n```';
  assert.ok(LBP.semanticallyEqual(LBP.parsePureResultEnvelope(reflowed), RESULT));
});

check('a human countermand around a result envelope is NOT a pure result', () => {
  // The bug this guards: a message that merely CONTAINS a result envelope used
  // to count as a bridge turn, so the human turn never rotated the chain and the
  // chain approval survived the countermand.
  assert.equal(LBP.parsePureResultEnvelope('Stop. Delete nothing else.\n' + pureText), null);
  assert.equal(LBP.parsePureResultEnvelope(pureText + '\n\nAlso do the other thing.'), null);
});

check('two result envelopes are not a pure result', () => {
  assert.equal(LBP.parsePureResultEnvelope(pureText + '\n' + pureText), null);
});

check('a schema-invalid result is not a pure result', () => {
  assert.equal(LBP.parsePureResultEnvelope('<LBP_RESULT>\n{"task_id":"t1"}\n</LBP_RESULT>'), null);
  assert.equal(LBP.parsePureResultEnvelope('<LBP_RESULT>\n{"protocol":"lbp","task_id":"t1","status":"weird","operation":{}}\n</LBP_RESULT>'), null);
});

check('a forged result for a real task id still has to match semantically', () => {
  const forged = LBP.parsePureResultEnvelope(LBP.resultEnvelope({ ...RESULT, status: 'error' }));
  assert.ok(forged);
  assert.equal(LBP.semanticallyEqual(forged, RESULT), false);
});

// --- Adapter turn semantics ---------------------------------------------------

section('provider adapter');

const TASK_TEXT = `<LBP_TASK>
{
  "protocol": "lbp",
  "version": "1.2",
  "id": "task-1",
  "operation": { "type": "mcp.list_tools", "server": "workspace" }
}
</LBP_TASK>`;

check('exactly one task in an assistant turn is accepted', () => {
  const host = makeHost('assistant', [makeBlock(TASK_TEXT)], 'a1');
  assert.equal(adapter.assistantTaskState(host).kind, 'one');
});

check('assistant prose plus one complete task is accepted without modifying prose', () => {
  const host = makeHost('assistant', [makeBlock(TASK_TEXT)], 'a1-prose', {
    proseBefore: 'I will inspect the README first.',
    proseAfter: 'Then I will wait for the bridge result.'
  });
  const before = host.textContent;
  const state = adapter.assistantTaskState(host);
  assert.equal(state.kind, 'one');
  assert.equal(state.task.id, 'task-1');
  assert.equal(host.textContent, before, 'task parsing must not modify assistant prose');
});

check('assistant prose plus one plaintext task falls back to whole-turn text', () => {
  const host = makeHost('assistant', [], 'a1-plain', {
    proseBefore: `I will inspect the README first.\n${TASK_TEXT}\nThen I will wait for the bridge result.`
  });
  const state = adapter.assistantTaskState(host);
  assert.equal(state.kind, 'one');
  assert.equal(state.task.id, 'task-1');
});

check('malformed whole rendered turn is rejected even if a nested code block looks valid', () => {
  const host = makeHost('assistant', [makeBlock(TASK_TEXT)], 'a1-noisy');
  const noisyTurnText = `<LBP_TASK>
{
  "protocol"
:
  "lbp"
  "id": "broken"
}
</LBP_TASK>`;
  Object.defineProperty(host, 'innerText', { configurable: true, get: () => noisyTurnText });
  Object.defineProperty(host, 'textContent', { configurable: true, get: () => noisyTurnText });
  const state = adapter.assistantTaskState(host);
  assert.equal(state.kind, 'malformed', `whole rendered turn must be authoritative: ${state.kind}`);
});

check('partial task blocks are ignored until the assistant turn is complete', () => {
  const partial = 'Normal explanation\n<LBP_TASK>\n{ "protocol": "lbp", "id": "not-ready"';
  const host = makeHost('assistant', [makeBlock(partial)], 'a-partial');
  assert.equal(adapter.assistantTaskState(host).kind, 'none');
});

check('two tasks in SEPARATE code blocks of one turn are rejected', () => {
  // The whole assistant response is one unit. Splitting across code blocks used
  // to yield two independently runnable tasks.
  const second = TASK_TEXT.replace('task-1', 'task-2');
  const host = makeHost('assistant', [makeBlock(TASK_TEXT), makeBlock(second)], 'a2');
  const state = adapter.assistantTaskState(host);
  assert.equal(state.kind, 'multiple');
  assert.equal(state.count, 2);
});

check('the SAME task rendered twice is one task, not a multi-task reply', () => {
  // The provider re-renders a message as it streams and after it settles, so the
  // same task can end up in two code blocks. Treating that as a multi-task reply
  // stopped the chain and the task was silently never picked up.
  const host = makeHost('assistant', [makeBlock(TASK_TEXT), makeBlock(TASK_TEXT)], 'a-dup');
  const state = adapter.assistantTaskState(host);
  assert.equal(state.kind, 'one', `duplicated render reported as ${state.kind}`);
  assert.equal(state.task.id, 'task-1');
});

check('ChatGPT nests a second <pre> inside the code block; that is ONE payload', () => {
  // The real ChatGPT DOM is <pre class="overflow-visible"> wrapping
  // <pre class="cm-content">. Both matched querySelectorAll('pre') with identical
  // text, so one task looked like two: two disclosure headers in the message,
  // and blocks.length === 2 -- which made pureResultIn refuse a valid result and
  // left the chain waiting for a turn that had already arrived.
  const host = makeHost('assistant', makeNestedBlocks(TASK_TEXT), 'a-nested');
  assert.equal(adapter.protocolBlocks(host).length, 1, 'the inner <pre> is not a second payload');
  assert.equal(adapter.assistantTaskState(host).kind, 'one');
});

check('a nested-<pre> result turn is still recognised as a pure result', () => {
  const host = makeHost('user', makeNestedBlocks(pureText), 'u-nested');
  const parsed = adapter.pureResultIn(host);
  assert.ok(parsed, 'a nested render must not defeat pure-result detection');
  assert.equal(parsed.task_id, 't1');
});

check('two DIFFERENT tasks in one reply are still rejected', () => {
  const second = TASK_TEXT.replace('task-1', 'task-2');
  const host = makeHost('assistant', [makeBlock(TASK_TEXT), makeBlock(second)], 'a-two');
  const state = adapter.assistantTaskState(host);
  assert.equal(state.kind, 'multiple');
  assert.equal(state.count, 2);
});

check('an assistant turn with no task reports none', () => {
  assert.equal(adapter.assistantTaskState(makeHost('assistant', [makeBlock('just prose')], 'a3')).kind, 'none');
});

check('a malformed task is reported, never silently skipped', () => {
  const host = makeHost('assistant', [makeBlock('<LBP_TASK>\n{ not json\n</LBP_TASK>')], 'a4');
  assert.equal(adapter.assistantTaskState(host).kind, 'malformed');
});

check('turn ids prefer the stable provider id', async () => {
  const host = makeHost('assistant', [makeBlock('x')], 'abc-123');
  const identity = await adapter.turnId(host, { conversationId: 'conv-browser-smoke' });
  assert.equal(identity.id, 'abc-123');
  assert.equal(identity.stable, true);
  assert.equal(identity.source, 'data-message-id');
});

check('turn ids fall back to SHA-256 over conversation, role and text', async () => {
  const identity = await adapter.turnId(makeHost('assistant', [makeBlock('unstable content')]), {
    conversationId: 'conv-browser-smoke'
  });
  assert.ok(identity.id.startsWith('hash:'));
  assert.equal(identity.stable, false);
  assert.equal(identity.source, 'sha256');
});

check('provider turns are enumerated per role by provider id', async () => {
  allMessages = [
    makeHost('user', [makeBlock('first')], 'u1'),
    makeHost('assistant', [makeBlock(TASK_TEXT)], 'a1'),
    makeHost('user', [makeBlock('second')], 'u2')
  ];
  const turns = await adapter.providerTurns({ conversationId: 'conv-browser-smoke' });
  assert.deepEqual(turns.user.map((turn) => turn.id), ['u1', 'u2']);
  assert.deepEqual(turns.assistant.map((turn) => turn.id), ['a1']);
});

check('a user turn containing extra text is not a bridge result turn', () => {
  const host = makeHost('user', [makeBlock('please stop'), makeBlock(pureText)], 'u3');
  assert.equal(adapter.pureResultIn(host), null);
});

check('a user turn that is exactly one result envelope is a bridge result turn', () => {
  const host = makeHost('user', [makeBlock(pureText)], 'u4');
  assert.ok(adapter.pureResultIn(host));
});

// --- Composer -----------------------------------------------------------------

section('composer');

check('composerMatches is semantic once the strict parse has passed', () => {
  composer.innerText = pureText;
  composer.textContent = pureText;
  assert.equal(adapter.composerMatches(RESULT), true);
  assert.equal(adapter.composerMatches({ ...RESULT, status: 'error' }), false);
});

check('a composer holding a draft alongside the result does not match', () => {
  composer.innerText = 'my own draft\n' + pureText;
  composer.textContent = composer.innerText;
  assert.equal(adapter.composerMatches(RESULT), false);
});

check('one send fires the pre-send hook exactly once', async () => {
  // Enter fires keydown AND submit; a click fires click AND submit. The hook ran
  // two or three times per send, so the workflow bootstrap was prepended two or
  // three times into the same message.
  let fired = 0;
  const detach = adapter.onBeforeUserSend(() => { fired += 1; });
  composer.innerText = 'a genuine human prompt';
  composer.textContent = composer.innerText;

  const key = new global.Event('keydown', { bubbles: true });
  key.key = 'Enter';
  Object.defineProperty(key, 'target', { value: composer });
  document.dispatchEvent(key);
  const submit = new global.Event('submit', { bubbles: true });
  Object.defineProperty(submit, 'target', { value: form });
  document.dispatchEvent(submit);

  assert.equal(fired, 1, `pre-send hook fired ${fired} times for one send`);
  detach();
});

check('a pure result turn never triggers the pre-send hook', () => {
  let fired = 0;
  const detach = adapter.onBeforeUserSend(() => { fired += 1; });
  composer.innerText = pureText;
  composer.textContent = pureText;
  const submit = new global.Event('submit', { bubbles: true });
  Object.defineProperty(submit, 'target', { value: form });
  document.dispatchEvent(submit);
  assert.equal(fired, 0, 'a bridge result turn must not be treated as a human send');
  detach();
});

check('a click alone is not a submission: acknowledgement requires a new turn', async () => {
  composer.innerText = adapter.deliveryText(RESULT, DELIVERY);
  composer.textContent = composer.innerText;
  allMessages = [makeHost('user', [makeBlock('earlier')], 'u1')];
  const before = nativeSubmits;
  const outcome = await adapter.submitAndAwaitAcknowledgement(DELIVERY, 400);
  assert.equal(nativeSubmits, before + 1);
  assert.equal(outcome.submitted, false);
  assert.equal(outcome.reason, 'no_provider_acknowledgement');
});

check('acknowledgement succeeds when only the delivery marker appears as a new user turn', async () => {
  composer.innerText = adapter.deliveryText(RESULT, DELIVERY);
  composer.textContent = composer.innerText;
  allMessages = [makeHost('user', [makeBlock('earlier')], 'u1')];
  const pending = adapter.submitAndAwaitAcknowledgement(DELIVERY, 3000);
  setTimeout(() => {
    allMessages = [...allMessages, makeHost('user', [makeBlock(adapter.deliveryMarker(DELIVERY))], 'u-new')];
  }, 250);
  const outcome = await pending;
  assert.equal(outcome.submitted, true);
  assert.equal(outcome.turnId, 'u-new');
  assert.equal(outcome.delivery_id, DELIVERY.delivery_id);
});

check('a result submitted with the workflow bootstrap is still acknowledged', async () => {
  // The first round trip carries the bootstrap alongside the result, so the
  // provider turn is not a PURE result. Requiring purity here left the result
  // sitting in the composer and the chain stalled.
  composer.innerText = adapter.deliveryText(RESULT, DELIVERY);
  composer.textContent = composer.innerText;
  allMessages = [makeHost('user', [makeBlock('earlier')], 'u1')];
  const pending = adapter.submitAndAwaitAcknowledgement(DELIVERY, 3000);
  setTimeout(() => {
    allMessages = [...allMessages,
      makeHost('user', [makeBlock('<LBP_WORKFLOW>\nactive\n</LBP_WORKFLOW>'), makeBlock(adapter.deliveryMarker(DELIVERY))], 'u-mixed')];
  }, 250);
  const outcome = await pending;
  assert.equal(outcome.submitted, true, `mixed turn not acknowledged: ${outcome.reason}`);
  assert.equal(outcome.turnId, 'u-mixed');
});

check('a draft in the composer is NEVER overwritten', async () => {
  // The extension destroyed a typed question: writeComposer selects the whole
  // composer and replaces it, and the guard was optional. The person's message
  // was replaced by the bridge result and sent, so their question never existed.
  const draft = 'what does the daemon do when a mutation is ambiguous?';
  composer.innerText = draft;
  composer.textContent = draft;
  const outcome = await adapter.insertResult(RESULT, DELIVERY);
  assert.equal(outcome.inserted, false, 'the extension overwrote a draft');
  assert.equal(outcome.reason, 'composer_not_empty');
  assert.equal(composer.innerText, draft, 'the draft text was modified');
  assert.equal(outcome.copied, true, 'the result should go to the clipboard instead');
});

check('an empty composer still accepts the result', async () => {
  composer.innerText = '';
  composer.textContent = '';
  const outcome = await adapter.insertResult(RESULT, DELIVERY);
  assert.equal(outcome.inserted, true, `refused an empty composer: ${outcome.reason}`);
  assert.ok(composer.innerText.includes(`delivery=${DELIVERY.delivery_id}`));
});

check('re-inserting the same result over itself is allowed', async () => {
  composer.innerText = adapter.deliveryText(RESULT, DELIVERY);
  composer.textContent = composer.innerText;
  const outcome = await adapter.insertResult(RESULT, DELIVERY);
  assert.equal(outcome.inserted, true, 'must be able to replace its own result');
});

check('a composer the provider touched still auto-submits', async () => {
  // The result is inserted, then something makes the composer text no longer a
  // PURE result -- a stray newline, the workflow bootstrap. The strict check
  // refused to click send, so the result just sat in the box for the user to
  // submit by hand.
  const touched = `<LBP_WORKFLOW>\nactive\n</LBP_WORKFLOW>\n\n${adapter.deliveryText(RESULT, DELIVERY)}`;
  composer.innerText = touched;
  composer.textContent = touched;
  assert.equal(adapter.composerMatches(RESULT), false, 'precondition: not a pure result');
  assert.equal(adapter.composerHoldsDelivery(DELIVERY), true, 'delivery marker must still be found');

  allMessages = [makeHost('user', [makeBlock('earlier')], 'u1')];
  const beforeClicks = send.clicked;
  const pending = adapter.submitAndAwaitAcknowledgement(DELIVERY, 2000);
  setTimeout(() => {
    allMessages = [...allMessages, makeHost('user', [makeBlock(adapter.deliveryMarker(DELIVERY))], 'u-sent')];
  }, 200);
  const outcome = await pending;
  assert.equal(send.clicked, beforeClicks + 1, 'ChatGPT send button was never clicked');
  assert.equal(outcome.submitted, true, `not submitted: ${outcome.reason}`);
});

check('a composer holding a DIFFERENT result is still refused', () => {
  const other = globalThis.LBP.resultEnvelope({ ...RESULT, task_id: 'someone-else' });
  composer.innerText = other;
  composer.textContent = other;
  assert.equal(adapter.composerHoldsDelivery(DELIVERY), false,
    'tolerance must not accept the wrong delivery');
});

check('a localized UI can still be submitted without a human pressing Enter', () => {
  // Reported: "again I have to press Enter." Every send selector we had was an
  // English aria-label. On a Ukrainian UI none matched, so findSendButton
  // returned null, canSubmit() was false, and the chain simply stopped with the
  // result sitting in the composer.
  locale = 'uk';
  composer.innerText = composer.textContent = 'anything';
  send.voice = false;
  try {
    assert.ok(adapter.canSubmit(), 'a translated UI must still be submittable');
  } finally {
    locale = 'en';
    composer.innerText = composer.textContent = '';
  }
});

check('an empty composer is never submittable', () => {
  composer.innerText = composer.textContent = '';
  assert.equal(adapter.canSubmit(), false);
});

check('the voice control is never clicked; native form submission is used instead', async () => {
  // On a localized UI the visible control may currently be the voice button.
  // The adapter must not click it. requestSubmit remains the first fallback and
  // acknowledgement stops the strategy chain before synthetic Enter is tried.
  locale = 'uk';
  send.voice = true;
  const result = { protocol: 'lbp', task_id: 'enter-1', status: 'ok', operation: { classification: 'read_only' } };
  const delivery = { result, task_id: result.task_id, delivery_id: 'd-enter-1', result_digest: 'sha256-enter-1' };
  const text = adapter.deliveryText(result, delivery);
  composer.innerText = composer.textContent = text;
  composer.keys = [];
  allMessages = [makeHost('user', [makeBlock('earlier')], 'u-before-voice')];
  const clickedBefore = send.clicked;
  const submittedBefore = nativeSubmits;
  const originalRequestSubmit = form.requestSubmit;
  form.requestSubmit = () => {
    nativeSubmits += 1;
    setTimeout(() => {
      allMessages = [...allMessages, makeHost('user', [makeBlock(adapter.deliveryMarker(delivery))], 'u-voice-sent')];
      composer.innerText = composer.textContent = '';
    }, 20);
  };
  try {
    const outcome = await adapter.submitAndAwaitAcknowledgement(delivery, 2000);
    assert.equal(outcome.submitted, true, `requestSubmit fallback was not acknowledged: ${outcome.reason}`);
    assert.equal(send.clicked, clickedBefore, 'the voice control must not be clicked');
    assert.equal(nativeSubmits, submittedBefore + 1, 'native requestSubmit was not used');
    assert.equal(composer.keys.length, 0, 'synthetic Enter should not be needed after acknowledgement');
  } finally {
    form.requestSubmit = originalRequestSubmit;
    send.voice = false;
    locale = 'en';
    composer.innerText = composer.textContent = '';
  }
});

check('a DIFFERENT result appearing does not count as acknowledgement', async () => {
  composer.innerText = adapter.deliveryText(RESULT, DELIVERY);
  composer.textContent = composer.innerText;
  allMessages = [makeHost('user', [makeBlock('earlier')], 'u1')];
  const pending = adapter.submitAndAwaitAcknowledgement(DELIVERY, 700);
  setTimeout(() => {
    const other = adapter.deliveryMarker({ ...DELIVERY, delivery_id: 'd-other-delivery' });
    allMessages = [...allMessages, makeHost('user', [makeBlock(other)], 'u-other')];
  }, 200);
  const outcome = await pending;
  assert.equal(outcome.submitted, false);
});

// --- Legacy state must be gone -------------------------------------------------

section('legacy browser state');

check('chain_state.js is deleted', () => {
  assert.equal(fs.existsSync('extension/chain_state.js'), false);
});

check('no durable browser workflow state remains in the extension', () => {
  for (const file of ['extension/content.js', 'extension/coordinator.js', 'extension/presentation.js']) {
    const source = fs.readFileSync(file, 'utf8');
    for (const banned of ['lbp.auto-chain', 'lbp.chat-workflow', ':executed:', 'LBP_CHAIN_STATE']) {
      assert.equal(source.includes(banned), false, `${file} still references ${banned}`);
    }
  }
});

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

check('the browser never sends a chain id or a task body after registration', () => {
  // chain/window approval identity is derived by the daemon. The browser cannot
  // name it, so it cannot pin an old window to keep a lease alive.
  const background = withoutComments(fs.readFileSync('extension/background.js', 'utf8'));
  assert.equal(/chain_id/.test(background), false, 'background still puts chain_id on the wire');
  assert.equal(/registration:\s*message\.registration/.test(background), true);
  assert.equal(/\btask:\s*message\.task\b/.test(background), false, 'task bodies must not be resent');
  const coordinator = withoutComments(fs.readFileSync('extension/coordinator.js', 'utf8'));
  assert.equal(/chainId|chain_id/.test(coordinator), false);
});

check('manual mode still executes registered tasks', () => {
  const coordinator = withoutComments(fs.readFileSync('extension/coordinator.js', 'utf8'));
  assert.equal(
    /registration\.execution_status\s*===\s*["']registered["']\s*&&\s*daemonState\?\.mode\s*===\s*["']auto_continue["']/.test(coordinator),
    false,
    'registered task execution must not be gated on auto_continue'
  );
  assert.ok(/registration\.execution_status\s*===\s*["']registered["'][\s\S]*?runTask\(registration\)/.test(coordinator));
});

check('connected transport dot is explicitly green', () => {
  const presentation = fs.readFileSync('extension/presentation.js', 'utf8');
  const style = fs.readFileSync('extension/style.css', 'utf8');
  assert.ok(presentation.includes('lbp-connection-dot-${transportKind}'));
  assert.ok(/--lbp-green:\s*#7be876/.test(style));
  assert.ok(/\.lbp-connection-dot\s*\{[^}]*background:\s*var\(--lbp-green\)/.test(style));
});

check('workflow bootstrap is inserted as a visible code block', () => {
  const coordinator = fs.readFileSync('extension/coordinator.js', 'utf8');
  // A BARE fence, no language tag. A tagged fence leaked the info string into
  // the block as its first line of content, which broke semantic recognition as
  // well as looking wrong.
  assert.ok(coordinator.includes('"```"'));
  assert.equal(/```text/.test(coordinator), false, 'the language tag leaks into the rendered block');
  const protocol = fs.readFileSync('extension/protocol.js', 'utf8');
  assert.equal(/```text/.test(protocol), false, 'the result envelope must use a bare fence');
  assert.ok(coordinator.includes('"<LBP_WORKFLOW>"'));
  assert.ok(coordinator.includes('"```"'));
});

check('chat message presentation remains append-only and unmodified', () => {
  const adapterSource = withoutComments(fs.readFileSync('extension/adapters/chatgpt.js', 'utf8'));
  const presentation = withoutComments(fs.readFileSync('extension/presentation.js', 'utf8'));
  const style = fs.readFileSync('extension/style.css', 'utf8');

  for (const source of [adapterSource, presentation, style]) {
    for (const banned of [
      'lbp-payload-disclosure',
      'lbp-protocol-collapsed',
      'lbp-protocol-container',
      'payloadMount',
      'payloadBlocks',
      'nativeCollapsible',
      'Show payload',
      'Hide payload'
    ]) {
      assert.equal(source.includes(banned), false, `message mutation token remains: ${banned}`);
    }
  }
  assert.equal(/querySelectorAll\?\.\("p, li, div"\)/.test(adapterSource), false);
  assert.ok(/function taskSources\(host\)/.test(adapterSource));
  assert.ok(/renderedNodeText\(block\)/.test(adapterSource),
    'task detection must prefer exact code-block text');
  assert.ok(/const wholeTurn\s*=\s*sourceText\(host\)/.test(adapterSource),
    'task detection must keep whole-turn fallback for non-code-block rendering');
  assert.equal(/classList\.(?:add|remove|toggle)/.test(presentation), false,
    'presentation must not add/remove classes on provider messages');
});

check('result recovery is acknowledged before human-turn reconciliation', () => {
  const coordinator = withoutComments(fs.readFileSync('extension/coordinator.js', 'utf8'));
  assert.ok(/reconcileSubmittedResultTurn\(turns\)[\s\S]*reconcileTurns\(turns\)/.test(coordinator),
    'delivery-marker recovery must run before observe_user_turn');
  assert.ok(/currentPendingRegistrationFor\(\)/.test(coordinator),
    'manual-send recovery must resolve daemon current registration');
  assert.ok(/textContainsDelivery\(api\.sourceText\(turn\.host\),\s*delivery\)/.test(coordinator),
    'manual-send recovery must verify the visible delivery marker');
  assert.ok(/acknowledge_submission[\s\S]*turn_id:\s*turn\.id[\s\S]*delivery_id:\s*delivery\.delivery_id/.test(coordinator),
    'manual-send recovery must acknowledge by provider turn id and delivery id');
});

check('reload recovery replays stored results without a browser task ledger', () => {
  const coordinator = withoutComments(fs.readFileSync('extension/coordinator.js', 'utf8'));
  assert.ok(/function recoverPendingDelivery/.test(coordinator));
  assert.ok(/daemonState\?\.phase\s*!==\s*"result_ready"/.test(coordinator),
    'recovery must be limited to the result_ready delivery phase');
  assert.ok(/fetchStoredDelivery\(pending\.registrationId\)/.test(coordinator),
    'pending delivery must recover from the daemon journal after reload');
  assert.ok(/deliveryStatus === "inserted"[\s\S]*composerHoldsDelivery[\s\S]*submitResult/.test(coordinator),
    'auto retry should submit an inserted pending result without rewriting it');
});

check('unknown recovery UI distinguishes manual acknowledgement from auto recovery', () => {
  const presentation = fs.readFileSync('extension/presentation.js', 'utf8');
  assert.ok(presentation.includes('unknownRecovery && state.unknown_recovery === "auto_continue"'));
  assert.ok(presentation.includes('Auto-resume after result confirmation'));
  assert.ok(presentation.includes('Acknowledge and continue'));
  const autoBranch = presentation.indexOf('unknownRecovery && state.unknown_recovery === "auto_continue"');
  const manualButton = presentation.indexOf('Acknowledge and continue');
  assert.ok(autoBranch >= 0 && manualButton > autoBranch, 'manual acknowledge button must be in the fallback branch after auto mode');
});

check('unknown auto-recovery happens only after provider-confirmed result acknowledgement', () => {
  const coordinator = withoutComments(fs.readFileSync('extension/coordinator.js', 'utf8'));
  const start = coordinator.indexOf('async function reconcileSubmittedResultTurn');
  const end = coordinator.indexOf('function currentPendingRegistrationFor', start);
  assert.ok(start >= 0 && end > start, 'result reconciliation function is missing');
  const flow = coordinator.slice(start, end);
  const submitted = flow.indexOf('await stateCall("acknowledge_submission"');
  const unknown = flow.indexOf('await stateCall("acknowledge_unknown"');
  assert.ok(submitted >= 0 && unknown > submitted,
    'unknown recovery must occur only after provider-confirmed acknowledge_submission');
  assert.ok(flow.includes('pending.executionStatus === "unknown"'));
  assert.ok(flow.includes('daemonState?.unknown_recovery === "auto_continue"'));
  assert.ok(flow.includes('daemonState?.phase === "stopped"'));
  assert.ok(flow.includes('daemonState?.stopped_reason === "unknown_mutation_state"'));
});

check('interaction settings expose checkpoint size and unknown recovery without freeform policy', () => {
  const coordinator = fs.readFileSync('extension/coordinator.js', 'utf8');
  const content = fs.readFileSync('extension/content.js', 'utf8');
  const optionsHtml = fs.readFileSync('extension/options.html', 'utf8');
  const optionsJs = fs.readFileSync('extension/options.js', 'utf8');
  assert.ok(optionsHtml.includes('Checkpoint size'));
  assert.ok(optionsHtml.includes('id="interaction-unknown-recovery"'));
  assert.ok(optionsHtml.includes('max="100"'));
  assert.ok(coordinator.includes('unknown_recovery: next.unknown_recovery === "auto_continue"'));
  assert.ok(content.includes('unknown_recovery: raw.unknown_recovery === "auto_continue"'));
  assert.ok(optionsJs.includes('unknown_recovery'));
  assert.equal(optionsHtml.includes('server-freeform-write'), false);
  assert.equal(optionsJs.includes('freeform_write_tools'), false);
});

check('transport lifecycle has concise debug events', () => {
  const source = fs.readFileSync('extension/coordinator.js', 'utf8')
    + fs.readFileSync('extension/adapters/chatgpt.js', 'utf8');
  for (const event of [
    'assistant_turn_settled',
    'task_candidate_found',
    'task_registered',
    'task_execute_started',
    'result_ready',
    'composer_found',
    'result_inserted',
    'send_attempt',
    'send_button_clicked',
    'result_user_turn_observed',
    'result_acknowledged',
    'next_assistant_wait',
    'delivery_timeout'
  ]) {
    assert.ok(source.includes(`"${event}"`), `missing debug event ${event}`);
  }
});

check('sidebar uses the exact-reference shell instead of details sections', () => {
  const presentation = fs.readFileSync('extension/presentation.js', 'utf8');
  const style = fs.readFileSync('extension/style.css', 'utf8');
  assert.ok(/let outputsExpanded\s*=\s*false/.test(presentation));
  assert.ok(/let contextExpanded\s*=\s*false/.test(presentation));
  for (const token of [
    'lbp-connection', 'lbp-panel', 'lbp-progress-title-row',
    'lbp-meta-row', 'lbp-timeline', 'lbp-checkpoint-footer',
    'lbp-outputs', 'lbp-context', 'lbp-actions'
  ]) {
    assert.ok(presentation.includes(token), `missing ${token}`);
  }
  // The reference mock is a 2x asset (941px canvas, 37px title). Porting its
  // literal pixel values made the real sidebar twice its intended size.
  // The reference mock is a 2x asset (941px canvas, 37px title). Porting its
  // literal pixel values made the sidebar twice its intended size. The panel is
  // a readable fraction of that, not the mock's own width.
  const width = style.match(/--lbp-panel-width:\s*min\((\d+(?:\.\d+)?)px/);
  assert.ok(width, 'panel width must be declared');
  const px = Number(width[1]);
  assert.ok(px >= 400 && px <= 620, `panel width ${px}px is outside the readable 400-620px range`);
  assert.equal(/min\(884px/.test(style), false, '2x mock width must not come back');

  // Outputs and Context must be able to grow. Pinning them to fixed row heights
  // made expand/collapse look dead: the content toggled but had nowhere to go.
  assert.ok(/grid-template-rows:\s*minmax\([\d.]+px,\s*1fr\)\s*auto\s*auto\s*auto/.test(style),
    'panel rows for Outputs/Context/actions must be auto so sections can expand');

  // Four action buttons can be visible; three fixed columns truncated labels.
  assert.ok(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\([\d.]+px,\s*1fr\)\)/.test(style),
    'action bar must wrap rather than truncate button labels');
});

check('sidebar icons are real SVG, not rotated pseudo-element bars', () => {
  const presentation = fs.readFileSync('extension/presentation.js', 'utf8');
  const style = fs.readFileSync('extension/style.css', 'utf8');
  // The old CSS-hack icons collapsed into an "x" for the section carets and put
  // a diagonal slash through the gear once rendered at real size.
  assert.ok(presentation.includes('ICON_PATHS'), 'icons must be drawn as inline SVG');
  for (const name of ['chevron', 'caret', 'bookmark', 'plus', 'folder', 'settings', 'stop']) {
    assert.ok(new RegExp(`\\b${name}:`).test(presentation), `missing icon: ${name}`);
  }
  for (const dead of ['.lbp-chevron-up::before', '.lbp-down::before',
                      '.lbp-plus::before', '.lbp-icon-settings::after']) {
    assert.equal(style.includes(dead), false, `stale pseudo-element icon rule: ${dead}`);
  }
});

check('sidebar terminology uses steps and checkpoints', () => {
  const presentation = fs.readFileSync('extension/presentation.js', 'utf8');
  const coordinator = fs.readFileSync('extension/coordinator.js', 'utf8');
  const options = fs.readFileSync('extension/options.html', 'utf8')
    + fs.readFileSync('extension/options.js', 'utf8');
  const visible = [presentation, options].join('\n');
  assert.equal(/Round trip|round trip|Auto-advance|Current round trip|Continue another \d+/.test(visible), false);
  assert.ok(presentation.includes('Current step'));
  assert.equal(presentation.includes('Continue to next checkpoint'), false);
  assert.equal(coordinator.includes('request_continue'), false);
  assert.equal(coordinator.includes('continueCheckpoint'), false);
  assert.ok(presentation.includes('until checkpoint'));
  assert.ok(presentation.includes('Auto-continue'));
});

check('sidebar waits for authoritative conversation state', () => {
  const presentation = fs.readFileSync('extension/presentation.js', 'utf8');
  const coordinator = fs.readFileSync('extension/coordinator.js', 'utf8');
  assert.ok(coordinator.includes('stateStatus'));
  assert.ok(presentation.includes('State unavailable'));
  assert.ok(presentation.includes('Loading...'));
  assert.equal(/state\?\.(phase|mode)|state\?\.active_chain/.test(presentation), false);
  assert.ok(/if \(!state\)\s*\{/.test(presentation));
});

check('context addition is routed through daemon-owned actions', () => {
  const presentation = fs.readFileSync('extension/presentation.js', 'utf8');
  const coordinator = fs.readFileSync('extension/coordinator.js', 'utf8');
  const background = fs.readFileSync('extension/background.js', 'utf8');
  assert.ok(presentation.includes('lbp-plus'));
  assert.ok(/Choose folder(?:\.\.\.|…)/.test(presentation));
  assert.ok(/Add configured workspace(?:\.\.\.|…)/.test(presentation));
  assert.ok(presentation.includes('Folder is outside the currently allowed MCP roots.'));
  assert.ok(coordinator.includes('add_context_source'));
  assert.ok(coordinator.includes('remove_context_source'));
  assert.ok(background.includes('/v1/context/choose-folder'));
  assert.ok(background.includes('/v1/context/workspaces'));
});

check('conversation identity is SHA-256 and per-tab when provisional', () => {
  const background = fs.readFileSync('extension/background.js', 'utf8');
  assert.ok(background.includes('SHA-256'));
  assert.equal(background.includes('0x811c9dc5'), false, 'FNV-1a conversation identity must be gone');
  assert.ok(background.includes('prov-'));
});

run().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
