import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMysqlConnector, validateMysqlConfig } from './mysql/connector.mjs';
import { prepareReadQuery, QueryPolicyError } from './sql/policy.mjs';
import { Approvals } from './sql/approvals.mjs';
import { explainQuery, buildEducation } from './sql/learning.mjs';

import { createProvider } from './model/provider.mjs';
import { proposeQuery } from './model/agent.mjs';
import { RecordContext } from './model/records.mjs';
const recordContext = new RecordContext();

let modelProvider = null;
let generating = false;
const connections = new Map();
const pendingQueries = new Approvals();
const maxBodyBytes = 32 * 1024;
const port = Number(process.env.CHATSQL_PORT || 4317);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json'), { status: 415 });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

function publicConnection(id, config) {
  return {
    id,
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    allowedTables: config.allowedTables,
    wholeDatabase: config.wholeDatabase,
    shareRecords: config.shareRecords,
    hasPassword: config.password.length > 0,
  };
}

function checkLocalRequest(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!(host === `127.0.0.1:${port}` || host === `localhost:${port}`)) {
    json(res, 403, { error: 'Local requests only' });
    return false;
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) {
    json(res, 403, { error: 'Cross-origin request rejected' });
    return false;
  }
  return true;
}

async function handler(req, res) {
  if (!checkLocalRequest(req, res)) return;
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const page = await readFile(new URL('../public/index.html', import.meta.url));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      return res.end(page);
    }

    if (req.method === 'GET' && url.pathname === '/education.js') {
      const asset = await readFile(new URL('../public/education.js', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(asset);
    }

    if (req.method === 'GET' && url.pathname === '/app.js') {
      const asset = await readFile(new URL('../public/app.js', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(asset);
    }

    if (req.method === 'GET' && url.pathname === '/app.css') {
      const asset = await readFile(new URL('../public/app.css', import.meta.url));
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(asset);
    }

    if (req.method === 'GET' && url.pathname === '/test') {
      const page = await readFile(new URL('../public/test.html', import.meta.url));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      });
      return res.end(page);
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, service: 'chatsql-api', apiVersion: 'intent-plan-v1', modelRequestRevision: 'json-review-v2', capabilities: { recordContext: true, wholeDatabase: true, intentPlan: true, education: 'education-v2' } });
    }

    if (req.method === 'POST' && url.pathname === '/api/learning/explain') {
      const input = await readJson(req);
      if (!input || typeof input.sql !== 'string' || input.sql.length > 20000 || !Array.isArray(input.params ?? []) || (input.params || []).length > 200) return json(res, 400, { error: '请提供单条 SQL 和有效参数数组' });
      const params = input.params ?? [];
      const snapshot = input.queryId ? pendingQueries.peek(input.queryId) : null;
      const matches = snapshot && connections.has(snapshot.connectionId) && snapshot.plan.sql === input.sql && JSON.stringify(snapshot.plan.params) === JSON.stringify(params);
      const plan = matches ? snapshot.plan : { sql: input.sql, params, source: 'learning-only' };
      return json(res, 200, { education: buildEducation(plan), queryIdMatches: !!matches });
    }

    if (req.method === 'GET' && url.pathname === '/api/model') {
      return json(res, 200, modelProvider?.publicView() || { configured: false });
    }
    if (req.method === 'POST' && url.pathname === '/api/model') {
      modelProvider = createProvider(await readJson(req));
      return json(res, 200, { ...modelProvider.publicView(), note: '配置已保存到进程内存；尚未验证云端调用' });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/model') {
      modelProvider = null;
      return json(res, 200, { configured: false });
    }
    if (req.method === 'POST' && url.pathname === '/api/chat/propose') {
      if (!modelProvider) return json(res, 409, { error: '请先配置模型 API' });
      if (generating) return json(res, 429, { error: '上一条问题仍在生成，请稍后再试' });
      const input = await readJson(req);
      if (input.shareSchema !== true) return json(res, 400, { error: '请先授权把表结构与问题发送给所配置的模型服务商' });
      const entry = connections.get(input.connectionId);
      if (!entry) return json(res, 404, { error: '请先选择一个有效数据源' });
      generating = true;
      try {
        const proposal = await proposeQuery({ provider: modelProvider, connector: entry.connector, database: entry.config.database, question: input.question, learning: input.learning === true, defaultLimit: input.defaultLimit ?? 100, recordContext, connectionId: input.connectionId, shareRecords: entry.config.shareRecords });
        if (proposal.kind === 'clarification') return json(res, 200, proposal);
        if (connections.get(input.connectionId) !== entry) return json(res, 409, { error: '数据源已被移除，请重新选择' });
        proposal.plan.trace = proposal.trace;
        const queryId = pendingQueries.issue(input.connectionId, proposal.plan);
        return json(res, 200, { kind: proposal.kind, queryId, ...proposal.plan, learning: proposal.learning, education: proposal.education, trace: proposal.trace, expiresInSeconds: 300 });
      } finally { generating = false; }
    }

    if (req.method === 'POST' && url.pathname === '/api/mysql/test') {
      const config = validateMysqlConfig(await readJson(req));
      const connector = createMysqlConnector(config);
      try {
        const result = await connector.test();
        return json(res, 200, { ok: true, database: result.databaseName, serverVersion: result.serverVersion });
      } finally {
        await connector.close();
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/mysql/connections') {
      const config = validateMysqlConfig(await readJson(req));
      const connector = createMysqlConnector(config);
      try {
        const result = await connector.test();
        const id = randomUUID();
        connections.set(id, { config, connector });
        return json(res, 201, { ok: true, connection: publicConnection(id, config), serverVersion: result.serverVersion });
      } catch (error) {
        await connector.close().catch(() => {});
        throw error;
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/mysql/connections') {
      return json(res, 200, {
        connections: [...connections.entries()].map(([id, entry]) => publicConnection(id, entry.config)),
      });
    }

    const schemaMatch = url.pathname.match(/^\/api\/mysql\/connections\/([0-9a-f-]+)\/schema$/i);
    if (req.method === 'GET' && schemaMatch) {
      const entry = connections.get(schemaMatch[1]);
      if (!entry) return json(res, 404, { error: 'Connection not found' });
      const tables = await entry.connector.getAuthorizedSchema();
      return json(res, 200, { connectionId: schemaMatch[1], database: entry.config.database, tables });
    }

    const previewMatch = url.pathname.match(new RegExp('^/api/mysql/connections/([0-9a-f-]+)/preview$', 'i'));
    // url.pathname.match(/^\\/api\\/mysql\\/connections\\/([0-9a-f-]+)\\/preview$/i);
    if (req.method === 'POST' && previewMatch) {
      const entry = connections.get(previewMatch[1]);
      if (!entry) return json(res, 404, { error: 'Connection not found' });
      const input = await readJson(req);
      const schema = await entry.connector.getAuthorizedSchema();
      const plan = prepareReadQuery({
        sql: input.sql,
        params: input.params ?? [],
        database: entry.config.database,
        allowedTables: schema.map(table => table.name),
        schema,
        defaultLimit: input.defaultLimit ?? 100,
      });
      plan.source = 'manual-sql';
      if (entry.config.shareRecords && typeof input.inspectionQuestion === 'string' && input.inspectionQuestion.trim() && input.inspectionQuestion.length <= 4000) plan.inspectionQuestion = input.inspectionQuestion.trim();
      const queryId = pendingQueries.issue(previewMatch[1], plan);
      return json(res, 200, { queryId, sql: plan.sql, params: plan.params, tables: plan.tables, rowLimit: plan.rowLimit, source: plan.source, expiresInSeconds: 300, education: input.learning === true ? buildEducation(plan) : null, learning: input.learning === true ? explainQuery(plan) : [] });
    }

    if (req.method === 'POST' && url.pathname === '/api/mysql/confirm') {
      const input = await readJson(req);
      if (input.confirm !== true) return json(res, 400, { error: 'Explicit confirmation is required' });
      const pending = pendingQueries.consume(input.queryId);
      if (!pending) {
        return json(res, 410, { error: 'Query preview expired or already used; preview it again' });
      }
      const entry = connections.get(pending.connectionId);
      if (!entry) return json(res, 404, { error: 'Connection was removed before confirmation' });
      const result = await entry.connector.queryReadOnly(pending.plan.sql, pending.plan.params);
      if (entry.config.shareRecords) recordContext.remember(pending.connectionId, result);
      return json(res, 200, { connectionId: pending.connectionId, ...result, samplesAvailable: entry.config.shareRecords, source: pending.plan.source, semantic: pending.plan.semantic || null, trace: pending.plan.trace || [], inspectionQuestion: pending.plan.inspectionQuestion || null });
    }

    if (req.method === 'POST' && url.pathname === '/api/mysql/cancel') {
      const input = await readJson(req);
      pendingQueries.cancel(input.queryId);
      return json(res, 200, { ok: true });
    }

    const deleteMatch = url.pathname.match(/^\/api\/mysql\/connections\/([0-9a-f-]+)$/i);
    if (req.method === 'DELETE' && deleteMatch) {
      const entry = connections.get(deleteMatch[1]);
      if (!entry) return json(res, 404, { error: 'Connection not found' });
      connections.delete(deleteMatch[1]);
      pendingQueries.removeConnection(deleteMatch[1]);
      recordContext.remove(deleteMatch[1]);
      await entry.connector.close();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : error instanceof TypeError || error instanceof QueryPolicyError ? 400 : 500;
    if (status !== 400 && status !== 413 && status !== 415) {
      console.error('[chatsql] request failed', String(error.code || 'MYSQL_ERROR'));
    }
    const message = status === 400 || status === 413 || status === 415 || status === 502
      ? error.message
      : '操作失败；请检查数据源、模型设置或本机服务状态';
    return json(res, status, { error: message });
  }
}

const server = createServer(handler);
server.listen(port, '127.0.0.1', () => {
  console.log(`ChatSQL API listening on http://127.0.0.1:${port}`);
});

async function shutdown() {
  server.close();
  await Promise.all([...connections.values()].map(({ connector }) => connector.close().catch(() => {})));
  connections.clear();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
