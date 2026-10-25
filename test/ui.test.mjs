import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { buildEducation } from '../src/sql/learning.mjs';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const educationScript = await readFile(new URL('../public/education.js', import.meta.url), 'utf8');
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('UI state did not settle');
}
function setup({ inspection = false, bound = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317', runScripts: 'outside-only' });
  const calls = [];
  let generated = null;
  dom.window.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body });
    let value;
    if (url === '/api/health') value = { ok: true, apiVersion: 'intent-plan-v1', capabilities: { recordContext: true, intentPlan: true } };
    else if (url === '/api/model') value = { configured: true, baseUrl: 'https://model.example/v1', model: 'test' };
    else if (url === '/api/mysql/connections') value = { connections: [{ id: 'c1', user: 'reader', host: '127.0.0.1', port: 3306, database: 'menagerie', allowedTables: ['pet'], hasPassword: true }] };
    else if (url === '/api/learning/explain') value = { education: buildEducation({ sql: body.sql, params: body.params, semantic: body.queryId && generated?.queryId === body.queryId && generated.sql === body.sql ? generated.semantic : undefined }) };
    else if (url === '/api/mysql/connections/c1/schema') value = { tables: [{ name: 'pet', columns: [{ name: 'name', type: 'varchar(20)', nullable: true }, { name: 'species', type: 'varchar(20)', nullable: true }] }] };
    else if (url === '/api/mysql/connections/c1/preview') value = { queryId: 'manual-1', sql: body.sql, params: body.params, rowLimit: 100, learning: body.learning ? [{ title: '查询意图', text: '读取宠物名称' }] : [] };
    else if (url === '/api/chat/propose') {
      const inspecting = inspection && calls.filter(call => call.url === '/api/chat/propose').length === 1;
      value = { kind: inspecting ? 'inspection' : 'query', source: inspecting ? 'schema-inspection' : 'intent-plan', queryId: 'preview-1', sql: inspecting ? 'SELECT DISTINCT species FROM pet LIMIT 100' : bound ? 'SELECT name FROM pet WHERE species = ? LIMIT 100' : 'SELECT name FROM pet LIMIT 100', params: bound && !inspecting ? ['dog'] : [], rowLimit: 100, semantic: inspecting ? null : { intent: '读取宠物名称', table: 'pet', outputs: [{ column: 'name', alias: 'name', userTerm: '名字' }], filters: bound ? [{ column: 'species', operator: '=', value: 'dog', userTerm: '狗', source: '已确认读取的实际字段值' }] : [], rowLimit: 100, review: 'passed' }, learning: body.learning ? [{ title: '查询意图', text: '读取宠物名称' }] : [] };
    }
    else if (url === '/api/mysql/confirm') value = { sql: 'SELECT name FROM pet LIMIT 100', columns: ['name'], rows: [{ name: '<img src=x onerror=alert(1)>' }], rowCount: 1, rowLimit: 100, limitReached: false, samplesAvailable: inspection, inspectionQuestion: inspection ? '宠物叫什么名字？' : null };
    else if (url === '/api/mysql/cancel') value = { ok: true };
    else throw new Error(`Unexpected test request: ${url}`);
    if (value.sql && body?.learning) value.education = buildEducation(value);
    if (url === '/api/chat/propose') generated = value;
    return { ok: true, json: async () => value };
  };
  dom.window.eval(educationScript);
  dom.window.eval(script);
  return { dom, calls, document: dom.window.document };
}
async function enterWorkspace(dom) {
  const document = dom.window.document;
  await waitFor(() => !document.getElementById('enter-workspace').disabled);
  document.getElementById('enter-workspace').click();
  await waitFor(() => !document.getElementById('workspace-view').hidden);
}
function submit(dom, id) { dom.window.document.getElementById(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); }
async function generate(dom, learning = false) {
  const document = dom.window.document;
  document.getElementById('learning').checked = learning;
  document.getElementById('chat-question').value = '宠物叫什么名字？';
  document.getElementById('share-schema').checked = true;
  submit(dom, 'chat-form');
  await waitFor(() => document.getElementById('query-sql').value.includes('SELECT'));
}

test('arrow fills editor only; run opens confirmation and explicit confirmation executes once', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom); await generate(dom, true);
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 0);
    assert.equal(document.getElementById('query-preview').open, false);
    assert.match(document.getElementById('learning-content').textContent, /读取宠物名称/);
    assert.equal(document.getElementById('learning-panel').hidden, false);
    document.getElementById('confirm-query').click();
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 0);
    submit(dom, 'query-form');
    await waitFor(() => document.getElementById('query-preview').open);
    assert.match(document.getElementById('preview-meta').textContent, /100/);
    document.getElementById('confirm-query').click();
    await waitFor(() => document.getElementById('query-results').querySelector('table'));
    document.getElementById('confirm-query').click();
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 1);
    assert.equal(calls.find(call => call.url === '/api/mysql/confirm').body.confirm, true);
    assert.equal(document.getElementById('query-results').querySelector('img'), null);
    assert.match(document.getElementById('query-results').textContent, /<img/);
  } finally { dom.window.close(); }
});
test('editing question invalidates the generated proposal; learning off has no tutorial', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom); await generate(dom);
    assert.equal(document.getElementById('learning-content').textContent, '');
    assert.equal(document.getElementById('learning-panel').hidden, true);
    document.getElementById('chat-question').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(document.getElementById('query-preview').open, false);
    document.getElementById('confirm-query').click();
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 0);
    assert.equal(calls.filter(call => call.url === '/api/mysql/cancel').length, 1);
  } finally { dom.window.close(); }
});
test('table tabs come from authorized schema and load explicit-column SQL without reading records', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom);
    await waitFor(() => document.querySelector('[data-table="pet"]'));
    document.querySelector('[data-table="pet"]').click();
    assert.equal(document.getElementById('query-results').hidden, true);
    assert.match(document.getElementById('table-content').textContent, /pet · 表结构/);
    document.querySelector('#table-content button').click();
    assert.match(document.getElementById('query-sql').value, /SELECT `name`, `species`/);
    assert.equal(document.getElementById('line-numbers').textContent, '1\n2');
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 0);
    document.getElementById('result-tab').click();
    assert.equal(document.getElementById('query-results').hidden, false);
  } finally { dom.window.close(); }
});
test('learning toggle opens left pane and explains existing SQL without model or query execution', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom); await generate(dom);
    const learning = document.getElementById('learning');
    learning.checked = true;
    learning.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await waitFor(() => document.getElementById('learning-content').textContent.includes('读取宠物名称'));
    assert(document.getElementById('studio-layout').classList.contains('with-learning'));
    assert.equal(calls.filter(call => call.url === '/api/chat/propose').length, 1);
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 0);
    learning.checked = false;
    learning.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(document.getElementById('learning-panel').hidden, true);
    assert.equal(document.getElementById('learning-content').textContent, '');
  } finally { dom.window.close(); }
});
test('whole-database authorization removes table-list requirement and requires risk acceptance', async () => {
  const { dom, document } = setup();
  try {
    const whole = document.getElementById('whole-database');
    const tables = document.querySelector('[name="allowedTables"]');
    assert.equal(tables.required, true);
    whole.checked = true; whole.dispatchEvent(new dom.window.Event('change'));
    assert.equal(tables.disabled, true);
    assert.equal(tables.required, false);
    assert.equal(document.getElementById('risk-accepted').required, true);
    whole.checked = false; whole.dispatchEvent(new dom.window.Event('change'));
    assert.equal(tables.required, true);
  } finally { dom.window.close(); }
});
test('inspection confirmation automatically resumes translation but never executes final SQL', async () => {
  const { dom, document, calls } = setup({ inspection: true });
  try {
    await enterWorkspace(dom); await generate(dom);
    assert.match(document.getElementById('query-sql').value, /DISTINCT species/);
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 0);
    submit(dom, 'query-form');
    await waitFor(() => document.getElementById('query-preview').open);
    assert.equal(calls.filter(call => call.url.endsWith('/preview')).length, 0);
    document.getElementById('confirm-query').click();
    await waitFor(() => calls.filter(call => call.url === '/api/chat/propose').length === 2 && document.getElementById('query-sql').value.includes('SELECT name'));
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 1);
    assert.equal(document.getElementById('query-preview').open, false);
  } finally { dom.window.close(); }
});
test('parameters and meaning remain visible; run uses the reviewed snapshot instead of a manual replacement', async () => {
  const { dom, document, calls } = setup({ bound: true });
  try {
    await enterWorkspace(dom); await generate(dom);
    assert.match(document.getElementById('parameter-summary').textContent, /第 1 个.*dog/);
    assert.equal(document.getElementById('query-params').closest('details'), null);
    assert.match(document.getElementById('plan-summary').textContent, /species = "dog"/);
    submit(dom, 'query-form');
    await waitFor(() => document.getElementById('query-preview').open);
    assert.match(document.getElementById('preview-meta').textContent, /dog/);
    assert.equal(calls.filter(call => call.url.endsWith('/preview')).length, 0);
    document.getElementById('confirm-query').click();
    await waitFor(() => calls.some(call => call.url === '/api/mysql/confirm'));
    assert.equal(calls.find(call => call.url === '/api/mysql/confirm').body.queryId, 'preview-1');
  } finally { dom.window.close(); }
});
test('editing SQL invalidates semantic review and is clearly marked as manual SQL', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom); await generate(dom);
    document.getElementById('query-sql').value = 'SELECT species FROM pet LIMIT 100';
    document.getElementById('query-sql').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(document.getElementById('plan-summary').hidden, true);
    submit(dom, 'query-form');
    await waitFor(() => document.getElementById('query-preview').open);
    assert.equal(calls.filter(call => call.url.endsWith('/preview')).length, 1);
    assert.match(document.getElementById('plan-summary').textContent, /手工 SQL/);
  } finally { dom.window.close(); }
});
test('education shows actual clause cards, explanations, contrasts and both orders instead of summary-only text', async () => {
  const { dom, document } = setup();
  try {
    await enterWorkspace(dom); await generate(dom, true);
    const panel = document.getElementById('learning-content');
    assert(panel.querySelector('[data-lesson-clause="select"]'));
    assert.match(panel.textContent, /为什么在这里使用/);
    assert.match(panel.textContent, /你写下来的顺序/);
    assert.match(panel.textContent, /逻辑顺序/);
    assert.match(panel.textContent, /不是数据库物理执行计划/);
    assert([...panel.querySelectorAll('summary')].some(summary => summary.textContent.includes('对比写法')));
    assert.equal(panel.querySelectorAll('.education-nav button').length, 4);
  } finally { dom.window.close(); }
});
test('clause locate and editor caret synchronize without rewriting SQL or consuming approval', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom); await generate(dom, true);
    const editor = document.getElementById('query-sql'), sql = editor.value;
    const callsBefore = calls.length;
    document.querySelector('[data-lesson-clause="from"] .lesson-locate').click();
    assert.equal(editor.value.slice(editor.selectionStart, editor.selectionEnd), 'FROM pet');
    assert.equal(document.querySelector('[data-lesson-clause="from"]').getAttribute('aria-current'), 'true');
    editor.setSelectionRange(sql.indexOf('LIMIT'), sql.indexOf('LIMIT'));
    editor.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'ArrowRight' }));
    assert.equal(document.querySelector('[data-lesson-clause="limit"]').getAttribute('aria-current'), 'true');
    assert.equal(editor.value, sql); assert.equal(calls.length, callsBefore);
    submit(dom, 'query-form'); await waitFor(() => document.getElementById('query-preview').open);
    document.getElementById('confirm-query').click(); await waitFor(() => calls.some(call => call.url === '/api/mysql/confirm'));
    assert.equal(calls.find(call => call.url === '/api/mysql/confirm').body.queryId, 'preview-1');
  } finally { dom.window.close(); }
});
test('learning toggle requests only pure explanation and does not cancel or replace the pending SQL', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom); await generate(dom);
    document.getElementById('learning').checked = true;
    document.getElementById('learning').dispatchEvent(new dom.window.Event('change'));
    await waitFor(() => document.querySelector('[data-lesson-clause="select"]'));
    assert.equal(calls.filter(call => call.url === '/api/learning/explain').length, 1);
    assert.equal(calls.filter(call => call.url.endsWith('/preview') || call.url === '/api/mysql/cancel' || call.url === '/api/mysql/confirm').length, 0);
    assert.equal(calls.filter(call => call.url === '/api/chat/propose').length, 1);
  } finally { dom.window.close(); }
});
test('editing invalidates old lesson ranges immediately; detached locate buttons cannot select stale code', async () => {
  const { dom, document } = setup();
  try {
    await enterWorkspace(dom); await generate(dom, true);
    const oldLocate = document.querySelector('[data-lesson-clause="from"] .lesson-locate');
    const editor = document.getElementById('query-sql'); editor.value = 'SELECT species FROM pet LIMIT 10';
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    editor.setSelectionRange(0, 0); oldLocate.click();
    assert.equal(editor.selectionStart, 0);
    assert.equal(document.querySelectorAll('[data-lesson-clause]').length, 0);
    assert.match(document.getElementById('learning-content').textContent, /修改|失效/);
  } finally { dom.window.close(); }
});
test('late education responses cannot overwrite lessons after SQL changes', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom); await generate(dom);
    const previousFetch = dom.window.fetch;
    let finish;
    dom.window.fetch = async (url, options) => {
      if (url !== '/api/learning/explain') return previousFetch(url, options);
      const input = JSON.parse(options.body);
      return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ education: buildEducation(input) }) }); });
    };
    document.getElementById('learning').checked = true;
    document.getElementById('learning').dispatchEvent(new dom.window.Event('change'));
    await waitFor(() => typeof finish === 'function');
    const editor = document.getElementById('query-sql'); editor.value = 'SELECT species FROM pet LIMIT 10';
    editor.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    finish(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(document.querySelectorAll('[data-lesson-clause]').length, 0);
    assert.equal(editor.value, 'SELECT species FROM pet LIMIT 10');
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 0);
  } finally { dom.window.close(); }
});
test('education text is rendered safely even when SQL literals contain HTML-like input', () => {
  const { dom, document } = setup();
  try {
    const container = document.createElement('div');
    const doc = buildEducation({ sql: "SELECT '<img src=x onerror=alert(1)>' AS note FROM pet LIMIT 100", params: [] });
    dom.window.ChatSqlEducation.render(container, doc);
    assert.equal(container.querySelector('img'), null);
    assert.match(container.textContent, /<img/);
  } finally { dom.window.close(); }
});
test('cancel run and escape never execute; editor reset restores generated SQL', async () => {
  const { dom, document, calls } = setup();
  try {
    await enterWorkspace(dom); await generate(dom);
    document.getElementById('query-sql').value = 'SELECT species FROM pet';
    document.getElementById('reset-sql').click();
    assert.equal(document.getElementById('query-sql').value, 'SELECT name FROM pet LIMIT 100');
    submit(dom, 'query-form');
    await waitFor(() => document.getElementById('query-preview').open);
    document.getElementById('query-preview').dispatchEvent(new dom.window.Event('cancel', { cancelable: true }));
    assert.equal(document.getElementById('query-preview').open, false);
    assert.equal(calls.filter(call => call.url === '/api/mysql/confirm').length, 0);
    const labels = [...document.querySelectorAll('#workspace-view button')].map(button => button.textContent);
    assert(!labels.some(label => /Submit|Run Code|提交答案/.test(label)));
  } finally { dom.window.close(); }
});
