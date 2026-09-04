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
}
global.HTMLTextAreaElement = FakeTextArea;
global.HTMLInputElement = FakeInput;
global.HTMLButtonElement = FakeButton;

function makeBlock(text) {
  return { tagName: 'PRE', textContent: text, innerText: text, hidden: false };
}

function makeHost(role, blocks, id) {
  const host = {
    role,
    blocks,
    attrs: new Map([['data-message-author-role', role]]),
    get textContent() { return this.blocks.map((b) => b.textContent).join('\n'); },
    get innerText() { return this.textContent; },
    getAttribute(name) { return this.attrs.get(name) ?? null; },
    closest() { return null; },
    querySelectorAll(selector) { return selector === 'pre' ? this.blocks : []; }
  };
  if (id) host.attrs.set('data-message-id', id);
  return host;
}

const send = new FakeButton();
const form = {
  querySelector(selector) {
    return selector.includes('send-button') || selector.includes('Send prompt') || selector.includes('Send message')
      ? send : null;
  }
};
const composer = { innerText: '', textContent: '', closest: (tag) => (tag === 'form' ? form : null) };
let allMessages = [];

global.document = {
  querySelector(selector) {
    if (selector === '#prompt-textarea') return composer;
    return null;
  },
  querySelectorAll(selector) {
    return selector === '[data-message-author-role]' ? allMessages : [];
  }
};
global.navigator = { clipboard: { writeText: async () => {} } };
global.location = { hostname: 'chatgpt.com' };

vm.runInThisContext(fs.readFileSync('extension/protocol.js', 'utf8'), { filename: 'protocol.js' });
vm.runInThisContext(fs.readFileSync('extension/adapters/chatgpt.js', 'utf8'), { filename: 'chatgpt.js' });
const LBP = globalThis.LBP;
const adapter = globalThis.LBP_PROVIDER_ADAPTER;

// --- Protocol freeze ---------------------------------------------------------

section('protocol freeze');

check('LBP 1.2 and 1.3 are the supported runtime versions', () => {
  assert.deepEqual([...LBP.SUPPORTED_TASK_VERSIONS].sort(), ['1.2', '1.3']);
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

check('mcp.mutate requires 1.3', () => {
  assert.throws(() => LBP.normalizeTask({
    protocol: 'lbp', version: '1.2', id: 'mutate-on-12',
    operation: { type: 'mcp.mutate', server: 'workspace', calls: [{ id: 'a', tool: 'apply_patch', arguments: {} }] }
  }), /requires LBP 1\.3/);
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

check('turn ids prefer the stable provider id', () => {
  const host = makeHost('assistant', [makeBlock('x')], 'abc-123');
  const identity = adapter.turnId(host);
  assert.equal(identity.id, 'msg:abc-123');
  assert.equal(identity.stable, true);
});

check('turn ids fall back to a content hash and say so', () => {
  const identity = adapter.turnId(makeHost('assistant', [makeBlock('unstable content')]));
  assert.ok(identity.id.startsWith('text:'));
  assert.equal(identity.stable, false);
});

check('latest turns are resolved per role', () => {
  allMessages = [
    makeHost('user', [makeBlock('first')], 'u1'),
    makeHost('assistant', [makeBlock(TASK_TEXT)], 'a1'),
    makeHost('user', [makeBlock('second')], 'u2')
  ];
  const turns = adapter.latestTurns();
  assert.equal(turns.user.id, 'msg:u2');
  assert.equal(turns.assistant.id, 'msg:a1');
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

check('a click alone is not a submission: acknowledgement requires a new turn', async () => {
  composer.innerText = pureText;
  composer.textContent = pureText;
  allMessages = [makeHost('user', [makeBlock('earlier')], 'u1')];
  const before = send.clicked;
  const outcome = await adapter.submitAndAwaitAcknowledgement(RESULT, 400);
  assert.equal(send.clicked, before + 1);
  assert.equal(outcome.submitted, false);
  assert.equal(outcome.reason, 'no_provider_acknowledgement');
});

check('acknowledgement succeeds when the exact result appears as a new user turn', async () => {
  composer.innerText = pureText;
  composer.textContent = pureText;
  allMessages = [makeHost('user', [makeBlock('earlier')], 'u1')];
  const pending = adapter.submitAndAwaitAcknowledgement(RESULT, 3000);
  setTimeout(() => { allMessages = [...allMessages, makeHost('user', [makeBlock(pureText)], 'u-new')]; }, 250);
  const outcome = await pending;
  assert.equal(outcome.submitted, true);
  assert.equal(outcome.turnId, 'msg:u-new');
});

check('a DIFFERENT result appearing does not count as acknowledgement', async () => {
  composer.innerText = pureText;
  composer.textContent = pureText;
  allMessages = [makeHost('user', [makeBlock('earlier')], 'u1')];
  const pending = adapter.submitAndAwaitAcknowledgement(RESULT, 700);
  setTimeout(() => {
    const other = LBP.resultEnvelope({ ...RESULT, status: 'error' });
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

check('workflow bootstrap is inserted as a foldable code block', () => {
  const coordinator = fs.readFileSync('extension/coordinator.js', 'utf8');
  assert.ok(coordinator.includes('"```text"'));
  assert.ok(coordinator.includes('"<LBP_WORKFLOW>"'));
  assert.ok(coordinator.includes('"```"'));
});

check('protocol payload disclosure hides the provider code wrapper once', () => {
  const presentation = withoutComments(fs.readFileSync('extension/presentation.js', 'utf8'));
  assert.equal(/wrapper\.insertBefore\(shell,\s*block\)/.test(presentation), false);
  assert.ok(/container\.parentElement\?\.insertBefore\(shell,\s*container\)/.test(presentation));
  assert.ok(/container\.classList\.toggle\("lbp-protocol-collapsed",\s*!expanded\)/.test(presentation));
  // Disclosures are rebuilt every pass rather than reconciled in place, which is
  // what stopped a provider re-render from leaving two shells for one payload.
  // The behaviour itself is covered by payload_disclosure_test.js.
  assert.ok(/for \(const stale of host\.querySelectorAll\("\.lbp-payload-disclosure"\)\) stale\.remove\(\)/
    .test(presentation), 'stale disclosures must be cleared each pass');
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

  // Five action buttons can be visible; three fixed columns truncated labels.
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
  const options = fs.readFileSync('extension/options.html', 'utf8')
    + fs.readFileSync('extension/options.js', 'utf8');
  const visible = [presentation, options].join('\n');
  assert.equal(/Round trip|round trip|Auto-advance|Current round trip|Continue another \d+/.test(visible), false);
  assert.ok(presentation.includes('Current step'));
  assert.ok(presentation.includes('Continue to next checkpoint'));
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
