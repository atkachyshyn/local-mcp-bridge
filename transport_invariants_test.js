// v0.9.2 append-only transport contract.
//
// ChatGPT messages are the transport log. The extension may read settled turns,
// insert text into the composer, and submit through the provider, but it must not
// alter already-rendered provider message DOM to hide or decorate protocol text.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) {
  console.log('\ntransport invariants test: SKIPPED (npm install --no-save jsdom)\n');
  process.exit(0);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const win = dom.window;
for (const k of ['document','Node','Element','HTMLElement','HTMLButtonElement','HTMLInputElement',
                 'HTMLTextAreaElement','Event','InputEvent','KeyboardEvent','MutationObserver',
                 'getComputedStyle']) global[k] = win[k];
global.window = win;
global.requestAnimationFrame = win.requestAnimationFrame.bind(win);
global.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
global.navigator = win.navigator;
global.location = { hostname: 'chatgpt.com', pathname: '/c/x' };
global.crypto = { randomUUID: () => 'u' };
global.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, payload: {} }), id: 't' }
};

globalThis.LBP_COORDINATOR = {
  state: () => null, stateStatus: () => ({ kind: 'ready' }),
  status: () => ({ kind: 'connected', text: 'Connected', detail: '', busy: false }),
  identity: () => ({ bridgeVersion: '0.9.2', lbpVersion: '1.3' }),
  interaction: () => ({ mode: 'manual', max_round_trips: 12, status_surface: 'panel' }),
  taskViews: () => new Map(), updateInteraction: async () => {},
  enable: async () => {}, stop: async () => {},
  redeliverResult: async () => {}, addContextSource: async () => {}, removeContextSource: async () => {},
  chooseContextFolder: async () => ({ cancelled: true }), configuredContextSources: async () => []
};

vm.runInThisContext(fs.readFileSync('extension/protocol.js', 'utf8'), { filename: 'protocol.js' });
vm.runInThisContext(fs.readFileSync('extension/adapters/chatgpt.js', 'utf8'), { filename: 'chatgpt.js' });
vm.runInThisContext(fs.readFileSync('extension/presentation.js', 'utf8'), { filename: 'presentation.js' });

const TASK = `<LBP_TASK>\n${JSON.stringify({
  protocol: 'lbp', version: '1.3', id: 'lbp-1', title: 'Read README header',
  operation: { type: 'mcp.observe', server: 'workspace', calls: [
    { id: 'a', tool: 'read_file', arguments: { path: '/repo/README.md' } }
  ] }
}, null, 2)}\n</LBP_TASK>`;
const RESULT_OBJECT = {
  protocol: 'lbp', version: '1.3', bridge_version: '0.9.2',
  task_id: 'lbp-1', title: 'Read README header', status: 'ok',
  operation: { type: 'mcp.observe', server: 'workspace', calls: [] },
  applied_mutations: [], outputs: []
};
const RESULT = globalThis.LBP.resultEnvelope(RESULT_OBJECT);

function addTurn(role, id, parts) {
  const host = win.document.createElement('div');
  host.setAttribute('data-message-author-role', role);
  host.setAttribute('data-message-id', id);
  const markdown = win.document.createElement('div');
  markdown.className = 'markdown prose';
  for (const part of parts) {
    if (part.kind === 'p') {
      const p = win.document.createElement('p');
      p.textContent = part.text;
      markdown.appendChild(p);
    } else if (part.kind === 'code') {
      const pre = win.document.createElement('pre');
      const code = win.document.createElement('code');
      code.textContent = part.text;
      pre.appendChild(code);
      markdown.appendChild(pre);
    }
  }
  host.appendChild(markdown);
  // jsdom does not implement browser innerText block separation here: its
  // textContent concatenates <p>/<pre>/<p> with no newlines, which puts an
  // otherwise valid <LBP_TASK> tag mid-line. Real ChatGPT innerText preserves
  // those visible block boundaries, so model the settled provider turn exactly.
  Object.defineProperty(host, 'innerText', {
    configurable: true,
    get: () => parts.map((part) => part.text).join('\n')
  });
  win.document.body.appendChild(host);
  return host;
}

const tests = [];
function check(name, fn) { tests.push({ name, fn }); }

check('assistant prose plus a visible task parses from the settled turn', () => {
  const host = addTurn('assistant', 'a1', [
    { kind: 'p', text: 'I will inspect the README and then report back.' },
    { kind: 'code', text: TASK },
    { kind: 'p', text: 'Waiting for the local result.' }
  ]);
  const before = host.outerHTML;
  const task = globalThis.LBP_PROVIDER_ADAPTER.assistantTaskState(host);
  assert.equal(task.kind, 'one');
  assert.equal(task.task.id, 'lbp-1');
  assert.equal(host.outerHTML, before, 'parsing must not mutate the assistant message');
});

check('partial task blocks are ignored', () => {
  const host = addTurn('assistant', 'a-partial', [
    { kind: 'p', text: 'Still streaming.' },
    { kind: 'code', text: '<LBP_TASK>\n{"protocol":"lbp","id":"not-complete"' }
  ]);
  assert.equal(globalThis.LBP_PROVIDER_ADAPTER.assistantTaskState(host).kind, 'none');
});

check('normal ChatGPT code blocks are untouched by sidebar rendering', () => {
  const host = addTurn('assistant', 'a-code', [
    { kind: 'p', text: 'Here is an ordinary example.' },
    { kind: 'code', text: 'console.log("not an LBP block");' }
  ]);
  const before = host.outerHTML;
  globalThis.LBP_PRESENTATION.ensureUi();
  globalThis.LBP_PRESENTATION.render();
  assert.equal(host.outerHTML, before);
  assert.equal(win.document.querySelector('.lbp-payload-disclosure'), null);
  assert.equal(win.document.querySelector('.lbp-protocol-collapsed'), null);
});

check('pure visible user result remains semantically recoverable', () => {
  const host = addTurn('user', 'u1', [{ kind: 'code', text: RESULT }]);
  const before = host.outerHTML;
  const parsed = globalThis.LBP_PROVIDER_ADAPTER.pureResultIn(host);
  assert.ok(parsed);
  assert.equal(parsed.task_id, 'lbp-1');
  assert.equal(host.outerHTML, before, 'result parsing must not mutate the user message');
});

(async () => {
  console.log('\ntransport append-only invariants');
  let passed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`  ok  ${name}`); passed += 1; }
    catch (error) { console.error(`  fail ${name}\n${error.stack || error}`); process.exitCode = 1; break; }
  }
  console.log(`\ntransport invariants test: ${passed}/${tests.length} checks passed\n`);
})();
