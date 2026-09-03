const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

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

const send = new FakeButton();
const form = {
  querySelector(selector) {
    if (selector.includes('send-button') || selector.includes('Send prompt') || selector.includes('Send message')) return send;
    return null;
  }
};
const composer = {
  innerText: '',
  textContent: '',
  closest(tag) { return tag === 'form' ? form : null; }
};
const assistant1 = { role: 'assistant' };
const user1 = { role: 'user' };
let allMessages = [assistant1, user1];

global.document = {
  querySelector(selector) {
    if (selector === '#prompt-textarea') return composer;
    if (selector.includes('stop-button') || selector.includes('Stop generating') || selector.includes('Stop streaming')) return null;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === '[data-message-author-role]') return allMessages;
    if (selector === '[data-message-author-role="assistant"]') return allMessages.filter(x => x.role === 'assistant');
    if (selector === '[data-message-author-role="user"]') return allMessages.filter(x => x.role === 'user');
    return [];
  }
};

global.navigator = { clipboard: { writeText: async () => {} } };
global.location = { hostname: 'chatgpt.com' };

vm.runInThisContext(fs.readFileSync('extension/protocol.js', 'utf8'), { filename: 'protocol.js' });
vm.runInThisContext(fs.readFileSync('extension/adapters/chatgpt.js', 'utf8'), { filename: 'chatgpt.js' });
const adapter = globalThis.LBP_PROVIDER_ADAPTER;

const observe = globalThis.LBP.normalizeTask({
  protocol: 'lbp',
  version: '1.2',
  id: 'observe-1',
  operation: {
    type: 'mcp.observe',
    server: 'workspace',
    calls: [
      { id: 'a', tool: 'read_file', arguments: { path: '/tmp/a' } },
      { id: 'b', tool: 'run_command', arguments: { command: 'cargo test' } }
    ]
  }
});
assert.equal(observe.version, '1.2');
assert.equal(observe.operation.calls.length, 2);
assert.throws(() => globalThis.LBP.normalizeTask({
  protocol: 'lbp', id: 'bad-observe', operation: {
    type: 'mcp.observe', server: 'workspace',
    calls: [{ id: 'same', tool: 'read_file', arguments: {} }, { id: 'same', tool: 'read_file', arguments: {} }]
  }
}), /unique/);
assert.throws(() => globalThis.LBP.normalizeTask({
  protocol: 'lbp', id: 'forged', operation: { type: 'mcp.call', server: 'workspace', tool: 'run_command', classification: 'verify', arguments: {} }
}), /derives classification/);

const legacySingle = globalThis.LBP.normalizeTask({
  protocol: 'lbp', version: '1.1', id: 'legacy-single',
  operations: [{ type: 'mcp.call', server: 'workspace', tool: 'read_file', arguments: { path: '/tmp/a' }, mutating: false, required: true }]
});
assert.equal(legacySingle.version, '1.2');
assert.equal(legacySingle.operation.tool, 'read_file');
assert.equal(Object.prototype.hasOwnProperty.call(legacySingle.operation, 'mutating'), false);
assert.throws(() => globalThis.LBP.normalizeTask({
  protocol: 'lbp', version: '1.1', id: 'legacy-many',
  operations: [
    { type: 'mcp.call', server: 'workspace', tool: 'read_file', arguments: {} },
    { type: 'mcp.call', server: 'workspace', tool: 'read_file', arguments: {} }
  ]
}), /exactly one/);

const envelope = '```text\n<LBP_RESULT>\n{"task_id":"t1","status":"ok"}\n</LBP_RESULT>\n```';
composer.innerText = '```text\n\n<LBP_RESULT>\n  {"task_id":"t1","status":"ok"}\n</LBP_RESULT>\n```';
assert.equal(adapter.composerMatches(envelope), true, 'whitespace normalization should preserve a single exact envelope');

composer.innerText = `${envelope}\nuser draft`;
assert.equal(adapter.composerMatches(envelope), false, 'extra user text must fail');
composer.innerText = `${envelope}\n${envelope}`;
assert.equal(adapter.composerMatches(envelope), false, 'two result envelopes must fail');

composer.innerText = envelope;
assert.equal(adapter.findLastMessageHost(), user1, 'last-message lookup must include user turns');
allMessages = [user1, assistant1];
assert.equal(adapter.findLastMessageHost(), assistant1, 'latest assistant should be recognized only when actually last overall');

(async () => {
  composer.innerText = envelope;
  const result = await adapter.submitComposer(envelope);
  assert.equal(result.submitted, true);
  assert.equal(send.clicked, 1);
  composer.innerText = `${envelope} changed`;
  const denied = await adapter.submitComposer(envelope);
  assert.equal(denied.submitted, false);
  assert.equal(send.clicked, 1, 'changed composer must not click Send');
  console.log('browser_smoke_test.js: PASS');
})().catch((err) => { console.error(err); process.exit(1); });
