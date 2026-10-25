import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';

test('local HTTP serves UI, rejects foreign origins and requires preview confirmation', async () => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, CHATSQL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', data => { output += data; if (output.includes('listening')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited: ${code}`)));
  });
  let timer;
  try {
    await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000); })]);
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.apiVersion, 'intent-plan-v1');
    assert.equal(health.capabilities.intentPlan, true);
    assert.equal(health.capabilities.education, 'education-v2');
    const home = await fetch(base);
    assert.match(await home.text(), /学习模式/);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    assert.equal((await fetch(base + '/education.js')).status, 200);
    assert.equal((await fetch(base + '/api/mysql/connections', { headers: { Origin: 'https://other.example' } })).status, 403);
    const send = data => fetch(base + '/api/mysql/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal((await send({ queryId: 'none' })).status, 400);
    assert.equal((await send({ queryId: 'none', confirm: true })).status, 410);
    const post = (path, data) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    const taught = await (await post('/api/learning/explain', { sql: 'SELECT first_name, last_name FROM actor LIMIT 100;', params: [] })).json();
    assert.equal(taught.education.version, 'education-v2');
    assert.equal(taught.education.status, 'supported');
    assert.equal(taught.queryIdMatches, false);
    assert.equal(taught.education.clauses[0].keyword, 'SELECT');
    const unsupported = await (await post('/api/learning/explain', { sql: 'DELETE FROM actor', params: [] })).json();
    assert.equal(unsupported.education.status, 'unsupported');
    assert.equal((await (await fetch(base + '/api/model')).json()).configured, false);
    assert.equal((await post('/api/chat/propose', { question: 'test' })).status, 409);
    const savedModel = await (await post('/api/model', { baseUrl: 'https://model.example/v1', model: 'test', apiKey: 'synthetic-test-key' })).json();
    assert.equal(savedModel.configured, true);
    assert.equal(JSON.stringify(savedModel).includes('synthetic-test-key'), false);
    assert.equal((await post('/api/chat/propose', { question: 'test', shareSchema: false })).status, 400);
    assert.equal((await post('/api/chat/propose', { question: 'test', shareSchema: true, connectionId: 'missing' })).status, 404);
    await fetch(base + '/api/model', { method: 'DELETE' });
    assert.equal((await (await fetch(base + '/api/model')).json()).configured, false);
    const connections = await (await fetch(base + '/api/mysql/connections')).json();
    assert.deepEqual(connections.connections, []);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  }
});
