import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Navigation did not settle');
}
function setup(model, connected, hash = '', compatible = true) {
  const dom = new JSDOM(html, { url: `http://127.0.0.1:4317/${hash}`, runScripts: 'outside-only' });
  const state = { model, connected };
  const calls = [];
  dom.window.fetch = async (url, options = {}) => {
    calls.push(url);
    let value;
    if (url === '/api/health') value = compatible ? { ok: true, apiVersion: 'intent-plan-v1', capabilities: { recordContext: true, intentPlan: true } } : { ok: true };
    else if (url === '/api/model') value = { configured: state.model, model: 'test', baseUrl: 'https://model.example/v1' };
    else if (url === '/api/mysql/connections') value = { connections: state.connected ? [{ id: 'c1', user: 'reader', host: '127.0.0.1', port: 3306, database: 'test', allowedTables: ['t'], hasPassword: false }] : [] };
    else throw new Error('Unexpected request');
    return { ok: true, json: async () => value };
  };
  dom.window.eval(script);
  return { dom, state, calls, document: dom.window.document };
}
test('stale backend is blocked even with database and model configured', async () => {
  const { dom, document, calls } = setup(true, true, '#workspace', false);
  try {
    await waitFor(() => document.getElementById('entry-status').textContent.includes('旧版本'));
    assert.equal(document.getElementById('enter-workspace').disabled, true);
    assert.equal(document.getElementById('workspace-view').hidden, true);
    const before = calls.length;
    document.getElementById('model-form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
    await waitFor(() => document.getElementById('model-status').textContent.includes('重启'));
    assert.equal(calls.length, before);
  } finally { dom.window.close(); }
});
for (const [model, database] of [[false, false], [true, false], [false, true]]) {
  test(`workspace is gated when model=${model}, database=${database}`, async () => {
    const { dom, document } = setup(model, database, '#workspace');
    try {
      await waitFor(() => document.getElementById('entry-status').textContent.includes('请先'));
      assert.equal(document.getElementById('workspace-view').hidden, true);
      assert.equal(document.getElementById('settings-view').hidden, false);
      assert.equal(document.getElementById('enter-workspace').disabled, true);
      assert.equal(dom.window.location.hash, '#settings');
    } finally { dom.window.close(); }
  });
}
test('ready configuration does not automatically open workspace; enter and return are separate views', async () => {
  const { dom, document, calls } = setup(true, true);
  try {
    await waitFor(() => !document.getElementById('enter-workspace').disabled);
    assert.equal(document.getElementById('workspace-view').hidden, true);
    document.getElementById('enter-workspace').click();
    await waitFor(() => !document.getElementById('workspace-view').hidden);
    assert.equal(document.getElementById('settings-view').hidden, true);
    assert.equal(dom.window.location.hash, '#workspace');
    document.getElementById('chat-question').value = 'keep my question';
    document.getElementById('back-settings').click();
    assert.equal(document.getElementById('workspace-view').hidden, true);
    assert.equal(document.getElementById('settings-view').hidden, false);
    assert.equal(document.getElementById('chat-question').value, 'keep my question');
    assert(!calls.includes('/api/chat/propose'));
    assert(!calls.includes('/api/mysql/confirm'));
  } finally { dom.window.close(); }
});
test('entry rechecks server state and refuses a model cleared elsewhere', async () => {
  const { dom, document, state } = setup(true, true);
  try {
    await waitFor(() => !document.getElementById('enter-workspace').disabled);
    state.model = false;
    document.getElementById('enter-workspace').click();
    await waitFor(() => document.getElementById('model-ready').textContent.includes('待配置'));
    assert.equal(document.getElementById('workspace-view').hidden, true);
    assert.equal(document.getElementById('enter-workspace').disabled, true);
  } finally { dom.window.close(); }
});
