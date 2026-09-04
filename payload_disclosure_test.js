// Protocol payload disclosure.
//
// Renders real message DOM through the real ChatGPT adapter and the real
// presentation layer, then checks the folding rules:
//   - exactly one disclosure per payload, no matter how often the provider
//     re-renders the message (a task was showing up twice);
//   - payloads are folded once the reply has finished streaming;
//   - a result submitted as the user's own turn is folded the same way, and is
//     marked so it can be styled on the provider's blue bubble.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) {
  console.log('\npayload disclosure test: SKIPPED (npm install --no-save jsdom)\n');
  process.exit(0);
}

let passed = 0;
const queue = [];
const check = (name, fn) => queue.push({ name, fn });

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const win = dom.window;
for (const k of ['document','Node','Element','HTMLElement','HTMLButtonElement','HTMLInputElement',
                 'HTMLTextAreaElement','Event','InputEvent','MutationObserver','getComputedStyle']) global[k] = win[k];
global.window = win;
global.navigator = win.navigator;
global.location = { hostname: 'chatgpt.com', pathname: '/c/x' };
global.crypto = { randomUUID: () => 'u' };
global.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, payload: {} }), id: 't' }
};

let generating = false;
globalThis.LBP_COORDINATOR = {
  state: () => null, stateStatus: () => ({ kind: 'ok' }),
  status: () => ({ kind: 'connected', text: 'Connected', detail: '', busy: false }),
  identity: () => ({ bridgeVersion: '0.9.2', lbpVersion: '1.3' }),
  interaction: () => ({ mode: 'manual', max_round_trips: 12, status_surface: 'panel', show_protocol_payloads: false }),
  taskViews: () => new Map(), setInteraction() {}, updateInteraction: async () => {},
  enable: async () => {}, stop: async () => {}, continueCheckpoint: async () => {},
  redeliverResult: async () => {}, addContextSource: async () => {}, removeContextSource: async () => {},
  chooseContextFolder: async () => ({ cancelled: true }), configuredContextSources: async () => []
};

vm.runInThisContext(fs.readFileSync('extension/protocol.js', 'utf8'), { filename: 'protocol.js' });
vm.runInThisContext(fs.readFileSync('extension/adapters/chatgpt.js', 'utf8'), { filename: 'chatgpt.js' });
const realAdapter = globalThis.LBP_PROVIDER_ADAPTER;
// isGenerating is driven by a provider stop button we are not rendering here.
globalThis.LBP_PROVIDER_ADAPTER = Object.freeze({ ...realAdapter, isGenerating: () => generating });
vm.runInThisContext(fs.readFileSync('extension/presentation.js', 'utf8'), { filename: 'presentation.js' });

const TASK = `<LBP_TASK>
${JSON.stringify({ protocol: 'lbp', version: '1.3', id: 'lbp-1',
  title: 'Read README header',
  operation: { type: 'mcp.observe', server: 'workspace',
    calls: [{ id: 'a', tool: 'read_file', arguments: { path: '/repo/README.md' } }] } }, null, 2)}
</LBP_TASK>`;
const RESULT = globalThis.LBP.resultEnvelope({
  protocol: 'lbp', task_id: 'lbp-1', status: 'ok', operation: { classification: 'read_only' }
});
const WORKFLOW = '<LBP_WORKFLOW>\nLocal MCP Bridge is active for this chat.\n</LBP_WORKFLOW>';

function addTurn(role, text, id) {
  const host = win.document.createElement('div');
  host.setAttribute('data-message-author-role', role);
  host.setAttribute('data-message-id', id);
  const wrap = win.document.createElement('div');
  const pre = win.document.createElement('pre');
  pre.textContent = text;
  wrap.appendChild(pre);
  host.appendChild(wrap);
  win.document.body.appendChild(host);
  return host;
}

const P = globalThis.LBP_PRESENTATION;
P.ensureUi();

const userWorkflow = addTurn('user', WORKFLOW, 'u1');
const assistantTask = addTurn('assistant', TASK, 'a1');
const userResult = addTurn('user', RESULT, 'u2');

const shells = () => [...win.document.querySelectorAll('.lbp-payload-disclosure')];
const inHost = h => [...h.querySelectorAll('.lbp-payload-disclosure')];
const collapsed = h => [...h.querySelectorAll('.lbp-protocol-container')]
  .every(n => n.classList.contains('lbp-protocol-collapsed'));

console.log('\npayload disclosure');

check('one disclosure per payload', () => {
  P.applyPayloadVisibility();
  assert.equal(shells().length, 3, `expected 3 disclosures, got ${shells().length}`);
  assert.equal(inHost(assistantTask).length, 1);
});

check('repeated passes never duplicate a disclosure', () => {
  // This is the reported bug: the provider re-renders a message and the sidebar
  // inserted a second shell beside the new container.
  for (let i = 0; i < 5; i += 1) P.applyPayloadVisibility();
  assert.equal(inHost(assistantTask).length, 1, 'task disclosure duplicated');
  assert.equal(shells().length, 3);
});

check('a provider re-render still yields exactly one disclosure', () => {
  const wrap = assistantTask.querySelector('div');
  wrap.innerHTML = '';
  const pre = win.document.createElement('pre');
  pre.textContent = TASK;
  wrap.appendChild(pre);
  P.applyPayloadVisibility();
  assert.equal(inHost(assistantTask).length, 1, 'duplicate after re-render');
});

check('payloads are folded once the reply has finished', () => {
  generating = false;
  P.applyPayloadVisibility();
  assert.ok(collapsed(assistantTask), 'finished task payload must be folded');
  assert.ok(collapsed(userWorkflow), 'workflow instructions must be folded');
  assert.ok(collapsed(userResult), 'result payload must be folded');
});

check('the streaming reply stays open while it is still typing', () => {
  generating = true;
  P.applyPayloadVisibility();
  assert.equal(collapsed(assistantTask), false, 'streaming payload should stay visible');
  generating = false;
  P.applyPayloadVisibility();
  assert.ok(collapsed(assistantTask), 'and fold again once typing stops');
});

check('the disclosure toggle expands and re-folds one payload', () => {
  const toggle = inHost(assistantTask)[0].querySelector('.lbp-payload-toggle');
  assert.equal(toggle.textContent, 'Show payload');
  toggle.dispatchEvent(new win.Event('click', { bubbles: true }));
  assert.equal(collapsed(assistantTask), false, 'toggle did not expand');
  inHost(assistantTask)[0].querySelector('.lbp-payload-toggle')
    .dispatchEvent(new win.Event('click', { bubbles: true }));
  assert.ok(collapsed(assistantTask), 'toggle did not re-fold');
});

check('workflow instructions read as instructions, not a payload', () => {
  const shell = inHost(userWorkflow)[0];
  assert.equal(shell.dataset.lbpPayloadKind, 'workflow');
  assert.equal(shell.querySelector('.lbp-payload-toggle').textContent, 'Show instructions');
  assert.equal(shell.querySelector('.lbp-payload-disclosure-title').textContent,
    'Local MCP workflow attached');
});

check('a result turn is marked as the user\'s own so it can sit on the blue bubble', () => {
  const shell = inHost(userResult)[0];
  assert.equal(shell.dataset.lbpPayloadKind, 'result');
  assert.equal(shell.dataset.lbpAuthor, 'user');
  const css = fs.readFileSync('extension/style.css', 'utf8');
  assert.ok(css.includes('.lbp-payload-disclosure[data-lbp-author="user"]'),
    'result disclosures need their own styling on the user bubble');
});

check('the assistant task is still discoverable for registration', () => {
  // Folding is presentation only: it must never hide a task from the coordinator.
  const state = globalThis.LBP_PROVIDER_ADAPTER.assistantTaskState(assistantTask);
  assert.equal(state.kind, 'one', `adapter saw ${state.kind}`);
  assert.equal(state.task.id, 'lbp-1');
});

(async () => {
  for (const { name, fn } of queue) { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  console.log(`\npayload disclosure test: ${passed} checks passed\n`);
})().catch(e => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
