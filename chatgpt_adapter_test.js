// Focused provider-adapter test: automatic LBP result delivery must drive the
// actual ChatGPT send control and require provider acknowledgement before success.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (_) {
  console.log('\nchatgpt adapter test: SKIPPED (npm install --no-save jsdom)\n');
  process.exit(0);
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const win = dom.window;
for (const k of ['document','Node','Element','HTMLElement','HTMLButtonElement','HTMLInputElement',
                 'HTMLTextAreaElement','Event','InputEvent','KeyboardEvent','MutationObserver']) global[k] = win[k];
global.window = win;
global.navigator = win.navigator;
global.location = { hostname: 'chatgpt.com', pathname: '/c/x' };

vm.runInThisContext(fs.readFileSync('extension/protocol.js', 'utf8'), { filename: 'protocol.js' });
vm.runInThisContext(fs.readFileSync('extension/adapters/chatgpt.js', 'utf8'), { filename: 'chatgpt.js' });
const A = globalThis.LBP_PROVIDER_ADAPTER;

const result = {
  protocol: 'lbp', version: '1.3', bridge_version: '0.9.2', task_id: 'task-submit-1',
  title: 'Submit result', status: 'ok',
  operation: { type: 'mcp.observe', server: 'workspace', calls: [] },
  applied_mutations: [], outputs: []
};
const envelope = globalThis.LBP.resultEnvelope(result);
const delivery = {
  result,
  task_id: result.task_id,
  delivery_id: 'd-jsdom-submit-1',
  result_digest: 'sha256-jsdom-submit-1',
  conversation_id: 'conv-jsdom-submit'
};
const deliveredText = A.deliveryText(result, delivery);

const form = win.document.createElement('form');
const textarea = win.document.createElement('textarea');
textarea.id = 'prompt-textarea';
textarea.value = deliveredText;
const button = win.document.createElement('button');
button.type = 'submit';
button.setAttribute('data-testid', 'send-button');
form.append(textarea, button);
win.document.body.appendChild(form);

let requestSubmitCalls = 0;
let clickCalls = 0;
button.click = () => {
  clickCalls += 1;
  setTimeout(() => {
    const host = win.document.createElement('div');
    host.setAttribute('data-message-author-role', 'user');
    host.setAttribute('data-message-id', 'provider-user-result-1');
    // Real ChatGPT can render a long user result without <pre><code>.
    const bubble = win.document.createElement('div');
    bubble.textContent = A.deliveryMarker(delivery);
    host.appendChild(bubble);
    win.document.body.appendChild(host);
    textarea.value = '';
  }, 10);
};
form.requestSubmit = () => { requestSubmitCalls += 1; };

(async () => {
  console.log('\nchatgpt adapter submission');
  const submitted = await A.submitAndAwaitAcknowledgement(delivery, 2000);
  assert.equal(submitted.submitted, true, JSON.stringify(submitted));
  assert.equal(clickCalls, 1, 'actual send button should be the primary path');
  assert.equal(requestSubmitCalls, 0, 'requestSubmit fallback unexpectedly used');
  assert.equal(submitted.turnId, 'provider-user-result-1');
  assert.equal(submitted.delivery_id, delivery.delivery_id);
  assert.equal(envelope.includes('<LBP_RESULT>'), true);
  console.log('  ✓ send-button click + delivery-marker acknowledgement');
})();
