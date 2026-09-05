// Sidebar reference test.
//
// Pins the rendered sidebar to the approved visual reference
// (docs/sidebar-reference.html). The reference is the source of truth for
// wording; this test renders the REAL extension/presentation.js in jsdom against
// a daemon state that reproduces the reference scenario, then asserts the
// visible text matches exactly.
//
// It exists because the sidebar wording drifted once already ("Current round
// trip" / "Round trip 3 of 12" / "Auto-advance" instead of "Current step" /
// "3/12 until checkpoint" / "Auto-continue"), and nothing caught it.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  // jsdom is the only dependency in this repository and it is needed solely to
  // render the sidebar for this comparison. Skip rather than fail a clean clone.
  console.log('\nsidebar reference test: SKIPPED (run `npm install --no-save jsdom` to enable)\n');
  process.exit(0);
}

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

// --- The approved reference -----------------------------------------------------

const REFERENCE = {
  pill: 'Connected · Bridge v0.9.2 · LBP 1.3',
  title: 'Progress',
  meta: { status: 'Active', mode: 'Auto', count: '3/12', checkpointAt: 'Checkpoint at 12' },
  steps: [
    { n: '1', title: 'Rotate repo hygiene token',      cls: 'done' },
    { n: '2', title: 'Load bridge config',             cls: 'done' },
    { n: '3', title: 'Freeze LBP to 1.3',              cls: 'current', tag: 'Current step',
      sub: 'Align tests · In progress' },
    { n: '4', title: 'Resolve identities & state',     sub: 'Pending', cls: 'pending' },
    { n: '5', title: 'Task registration',              sub: 'Pending', cls: 'pending' },
    { n: '6', title: 'Conservative mutation check',    sub: 'Pending', cls: 'pending' },
    { n: '7', title: 'Approval scopes & path policy',  sub: 'Pending', cls: 'pending' },
    { n: '8', title: 'Extension protocol validation',  sub: 'Pending', cls: 'pending' }
  ],
  footer: '3/12 until checkpoint',
  autoLabel: 'Auto-continue',
  sections: ['Outputs', 'Context'],
  contextChip: 'local-mcp-bridge',
  actions: ['Stop chain', 'Settings']
};

// --- Daemon state reproducing the reference scenario -------------------------------

const PLAN_ITEMS = REFERENCE.steps.map((step, index) => ({
  id: `p${index + 1}`,
  phase: 'execute',
  title: step.title,
  status: index < 2 ? 'completed' : index === 2 ? 'current' : 'pending'
}));

// Two finished steps at 14:02:11 and 14:02:12 local time, as the reference shows.
const DAY = new Date(); DAY.setHours(14, 2, 11, 0);
const FINISHED_AT = [DAY.getTime(), DAY.getTime() + 1000, 0];
const stamp = (ms) => new Date(ms).toLocaleTimeString([], {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

const STATE = {
  schema: 2,
  conversation_id: 'conv-' + '0'.repeat(32),
  revision: 12,
  enabled: true,
  workflow_attached: true,
  mode: 'auto_continue',
  checkpoint_size: 12,
  phase: 'executing',
  active_chain: {
    chain_id: 'chain-1', human_turn_id: 'msg:u1', window: 0,
    window_limit: 12, window_task_count: 3, total_task_count: 3
  },
  current_task_id: 't3',
  current_registration: 'r3',
  plan: { id: 'plan-1', revision: 1, title: 'Stabilize', items: PLAN_ITEMS, begun: true, chain_id: 'chain-1' },
  recent_tasks: PLAN_ITEMS.slice(0, 3).map((item, index) => ({
    registration_id: `r${index + 1}`, task_id: `t${index + 1}`, title: item.title,
    sequence: index + 1, window: 0, window_position: index + 1,
    plan_item_id: item.id,
    execution_status: index < 2 ? 'completed' : 'running',
    delivery_status: index < 2 ? 'submitted' : 'none',
    updated_at: Math.floor(FINISHED_AT[index] / 1000)
  })),
  outputs: [],
  context: { sources: [{ id: 's1', kind: 'folder', label: 'local-mcp-bridge', origin: 'user', accessible: true }], constraints: [] },
  owner: null
};

// --- Boot the real presentation layer in jsdom ---------------------------------------

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const win = dom.window;
for (const key of ['document', 'Node', 'Element', 'HTMLElement', 'HTMLButtonElement',
                   'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'InputEvent',
                   'MutationObserver', 'getComputedStyle']) {
  global[key] = win[key];
}
global.window = win;
global.requestAnimationFrame = win.requestAnimationFrame.bind(win);
global.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
global.navigator = win.navigator;
global.location = { hostname: 'chatgpt.com', pathname: '/c/x' };
global.crypto = { randomUUID: () => 'uuid-0000' };
global.chrome = {
  storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
  runtime: { sendMessage: async () => ({ ok: true, payload: {} }), id: 'test' }
};

const INTERACTION = { mode: 'auto_continue', max_round_trips: 12, status_surface: 'panel' };
const taskViews = new Map([
  ['t1', { status: 'completed' }],
  ['t2', { status: 'completed' }],
  ['t3', { status: 'running', detail: 'Align tests' }]
]);

globalThis.LBP_COORDINATOR = {
  state: () => STATE,
  stateStatus: () => ({ kind: 'ready' }),
  status: () => ({ kind: 'connected', text: 'Connected', detail: '', busy: false }),
  identity: () => ({ bridgeVersion: '0.9.2', lbpVersion: '1.3' }),
  interaction: () => INTERACTION,
  taskViews: () => taskViews,
  setInteraction() {}, updateInteraction: async () => {},
  enable: async () => {}, stop: async () => {},
  redeliverResult: async () => {}, addContextSource: async () => {},
  removeContextSource: async () => {}, chooseContextFolder: async () => ({ cancelled: true }),
  configuredContextSources: async () => []
};

vm.runInThisContext(fs.readFileSync('extension/protocol.js', 'utf8'), { filename: 'protocol.js' });
globalThis.LBP_PROVIDER_ADAPTER = { messageHosts: () => [], protocolBlocks: () => [], sourceText: () => '' };
vm.runInThisContext(fs.readFileSync('extension/presentation.js', 'utf8'), { filename: 'presentation.js' });

globalThis.LBP_PRESENTATION.ensureUi();
globalThis.LBP_PRESENTATION.render();

const root = win.document.querySelector('.lbp-global-status');
const txt = (sel, scope = root) => (scope.querySelector(sel)?.textContent || '').trim();
const all = (sel, scope = root) => [...scope.querySelectorAll(sel)];

// --- Assertions ------------------------------------------------------------------------

console.log('\nsidebar matches the approved reference');

check('transport pill text', () => {
  assert.equal(txt('.lbp-connection-text') || txt('.lbp-connection'), REFERENCE.pill);
});

check('panel title', () => {
  assert.equal(txt('.lbp-progress-title'), REFERENCE.title);
});

check('meta row: Active · Auto · 3/12 · Checkpoint at 12', () => {
  assert.equal(txt('.lbp-meta-status'), REFERENCE.meta.status);
  assert.equal(txt('.lbp-meta-mode'), REFERENCE.meta.mode);
  assert.equal(txt('.lbp-meta-count'), REFERENCE.meta.count);
  assert.equal(txt('.lbp-checkpoint-at'), REFERENCE.meta.checkpointAt);
});

check('eight steps, in daemon plan order', () => {
  const steps = all('.lbp-step');
  assert.equal(steps.length, REFERENCE.steps.length, `expected 8 steps, got ${steps.length}`);
  steps.forEach((step, index) => {
    const want = REFERENCE.steps[index];
    assert.equal(txt('.lbp-num', step), want.n);
    assert.equal(txt('.lbp-step-title', step), want.title);
    assert.ok(step.className.includes(want.cls),
      `step ${want.n} class "${step.className}" should include "${want.cls}"`);
    if (want.sub) {
      assert.equal(txt('.lbp-sub', step), want.sub,
        `step ${want.n} sub should be exactly "${want.sub}"`);
    }
  });
});

check('a finished step reads "Completed - HH:MM:SS", not a delivery status', () => {
  const steps = all('.lbp-step');
  assert.equal(txt('.lbp-sub', steps[0]), `Completed · ${stamp(FINISHED_AT[0])}`);
  assert.equal(txt('.lbp-sub', steps[1]), `Completed · ${stamp(FINISHED_AT[1])}`);
  // The old build showed "Completed · Submitted" here.
  assert.equal(txt('.lbp-sub', steps[0]).includes('Submitted'), false);
});

check('the current step is tagged "Current step", and only that step', () => {
  const tags = all('.lbp-current-tag');
  assert.equal(tags.length, 1, `expected exactly one current tag, got ${tags.length}`);
  assert.equal(tags[0].textContent.trim(), REFERENCE.steps[2].tag);
  assert.equal(txt('.lbp-step-title', tags[0].closest('.lbp-step')), REFERENCE.steps[2].title);
});

check('footer reads "3/12 until checkpoint"', () => {
  assert.equal(txt('.lbp-footer-meta'), REFERENCE.footer);
});

check('auto toggle is labelled "Auto-continue" and is on', () => {
  const label = all('.lbp-auto span').map((n) => n.textContent.trim()).find(Boolean);
  assert.equal(label, REFERENCE.autoLabel);
  assert.equal(root.querySelector('.lbp-switch-input').checked, true);
});

check('Outputs and Context sections are present', () => {
  const names = all('.lbp-section-name').map((n) => n.textContent.trim());
  for (const want of REFERENCE.sections) assert.ok(names.includes(want), `missing section ${want}`);
});

check('context chip shows the connected workspace', () => {
  const chips = all('.lbp-chip-label').map((n) => n.textContent.trim());
  assert.ok(chips.includes(REFERENCE.contextChip), `chips ${JSON.stringify(chips)}`);
});

check('action bar wording', () => {
  const labels = all('.lbp-action-label').map((n) => n.textContent.trim());
  for (const want of REFERENCE.actions) assert.ok(labels.includes(want), `missing action "${want}" in ${JSON.stringify(labels)}`);
  assert.equal(labels.includes('Hide protocol'), false, 'Hide protocol must not be present');
  assert.equal(labels.includes('Show protocol'), false, 'Show protocol must not be present');
});

check('the mode label and switch follow the configured mode, not the enabled flag', () => {
  // The reported bug: with the chat disabled, the sidebar rendered "Manual" and
  // an off switch no matter what the mode actually was -- so the sidebar
  // contradicted the settings page, and every click on Auto-continue was
  // painted straight back over.
  const original = { enabled: STATE.enabled, mode: STATE.mode };
  try {
    // `enabled` only means the model was given the instructions, so it must not
    // change the reported mode at all.
    STATE.enabled = false;
    STATE.mode = 'auto_continue';
    globalThis.LBP_PRESENTATION.render();
    assert.equal(txt('.lbp-meta-mode'), 'Auto', 'mode must report auto_continue regardless of enabled');
    assert.equal(root.querySelector('.lbp-switch-input').checked, true);

    STATE.mode = 'manual';
    globalThis.LBP_PRESENTATION.render();
    assert.equal(txt('.lbp-meta-mode'), 'Manual');
    assert.equal(root.querySelector('.lbp-switch-input').checked, false);
  } finally {
    STATE.enabled = original.enabled;
    STATE.mode = original.mode;
    globalThis.LBP_PRESENTATION.render();
  }
});

check('action labels are short enough not to truncate', () => {
  const labels = all('.lbp-action-label').map((n) => n.textContent.trim());
  assert.ok(labels.includes('Enable'), `expected a short "Enable" label, got ${JSON.stringify(labels)}`);
  assert.equal(labels.includes('Enable Local MCP'), false, 'long Enable label truncated in the action bar');
});

check('a stopped chain says so, and says why', () => {
  // The chain used to stop (e.g. on a duplicated task render) while the sidebar
  // still read "Active - waiting", giving no clue anything had gone wrong.
  const original = { phase: STATE.phase, reason: STATE.stopped_reason, plan: STATE.plan, tasks: STATE.recent_tasks };
  try {
    STATE.phase = 'stopped';
    STATE.stopped_reason = 'multiple_tasks_in_one_assistant_turn';
    STATE.plan = null;
    STATE.recent_tasks = [];
    globalThis.LBP_PRESENTATION.render();
    assert.equal(txt('.lbp-meta-status'), 'Stopped');
    assert.ok(txt('.lbp-timeline-empty').includes('more than one LBP task'),
      `empty state must explain the stop, got: ${txt('.lbp-timeline-empty')}`);
  } finally {
    Object.assign(STATE, { phase: original.phase, stopped_reason: original.reason,
      plan: original.plan, recent_tasks: original.tasks });
    globalThis.LBP_PRESENTATION.render();
  }
});

check('retired wording is gone from the rendered sidebar', () => {
  const rendered = root.textContent;
  for (const banned of ['Current round trip', 'Round trip', 'Auto-advance', 'Run again']) {
    assert.equal(rendered.includes(banned), false, `sidebar still renders "${banned}"`);
  }
});

console.log(`\nsidebar reference test: ${passed} checks passed\n`);
