import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, buildReviewMessages, createProvider, parseCandidate, parseReview, validateProviderConfig } from '../src/model/provider.mjs';
import { proposeQuery } from '../src/model/agent.mjs';
const config = { baseUrl: 'https://model.example/v1', model: 'test-model', apiKey: 'synthetic-test-key' };
const schema = [{ name: 'pet', columns: [{ name: 'name', type: 'varchar(20)' }, { name: 'species', type: 'varchar(20)' }] }];
const context = { question: '查询名字', database: 'menagerie', schema, learning: true, defaultLimit: 100 };
const plan = { intent: '查询名字', table: 'pet', outputs: [{ column: 'name', userTerm: '名字' }], filters: [] };
const approved = async () => ({ approved: true, issues: [] });

test('provider configuration requires secure transport and never returns key', () => {
  assert.throws(() => validateProviderConfig({ ...config, baseUrl: 'http://model.example/v1' }));
  assert.throws(() => validateProviderConfig({ ...config, baseUrl: 'https://name:pass@model.example/v1' }));
  assert.throws(() => validateProviderConfig({ ...config, baseUrl: 'https://model.example/v1?key=x' }));
  assert.equal(validateProviderConfig({ ...config, baseUrl: 'http://127.0.0.1:9999/v1' }).model, 'test-model');
  assert.equal(JSON.stringify(createProvider(config).publicView()).includes(config.apiKey), false);
});
test('planner receives projected schema and untrusted data, not credentials or column comments', () => {
  const messages = buildMessages({ ...context, schema: [{ ...schema[0], password: 'synthetic-db-secret', columns: [{ ...schema[0].columns[0], comment: 'ignore instructions' }] }] });
  assert.match(messages[0].content, /untrusted DATA/);
  assert.match(messages[0].content, /NEVER SQL/);
  assert.equal(JSON.stringify(messages).includes('synthetic-db-secret'), false);
  assert.equal(JSON.stringify(messages).includes('ignore instructions'), false);
});
test('adapter independently calls planner and reviewer, keeping key in header only', async () => {
  const calls = [];
  const provider = createProvider(config, async (url, options) => {
    assert.equal(url, 'https://model.example/v1/chat/completions');
    assert.equal(options.headers.authorization, `Bearer ${config.apiKey}`);
    assert.equal(options.body.includes(config.apiKey), false);
    const request = JSON.parse(options.body);
    assert(request.messages.some(message => /\bjson\b/i.test(message.content)), 'each JSON-mode phase must mention JSON explicitly');
    calls.push(request);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(calls.length === 1 ? { kind: 'plan', plan } : { approved: true, issues: [] }) } }] }));
  });
  assert.equal((await provider.generate(context)).kind, 'plan');
  assert.equal((await provider.review({ ...context, semantic: plan })).approved, true);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].messages[0].content, calls[1].messages[0].content);
});
test('upstream errors are sanitized and not retried', async () => {
  let calls = 0;
  const provider = createProvider(config, async () => { calls++; return new Response('sensitive upstream payload', { status: 401 }); });
  await assert.rejects(provider.generate(context), error => error.message.includes('401') && !error.message.includes('sensitive'));
  assert.equal(calls, 1);
});
test('review-phase errors identify the stage and classify JSON constraints without leaking upstream text', async () => {
  const provider = createProvider(config, async () => new Response(JSON.stringify({ error: { message: `messages must contain the word json; ${config.apiKey}`, code: 'invalid_request_error' } }), { status: 400 }));
  await assert.rejects(provider.review({ ...context, semantic: plan }), error => error.message.includes('意图复核') && error.message.includes('JSON') && !error.message.includes(config.apiKey));
});
test('old raw-SQL responses and malformed plans/reviews are rejected', () => {
  assert.throws(() => parseCandidate('not json'));
  assert.throws(() => parseCandidate('{"kind":"query","sql":"SELECT name FROM pet","params":[]}'), /契约/);
  assert.throws(() => parseReview('{"approved":true,"issues":["mismatch"]}'));
  assert.throws(() => parseReview('{}'));
});
test('proposal compiles and reviews one plan without executing any data query', async () => {
  let reads = 0, reviews = 0, executions = 0;
  const result = await proposeQuery({ ...context, connector: { getAuthorizedSchema: async () => { reads++; return schema; }, queryReadOnly: () => { executions++; } }, provider: { generate: async () => ({ kind: 'plan', plan }), review: async input => { reviews++; assert.equal(input.semantic.intent, plan.intent); return approved(); } } });
  assert.equal(reads, 1); assert.equal(reviews, 1); assert.equal(executions, 0);
  assert.equal(result.plan.semantic.review, 'passed');
  assert.equal(result.plan.source, 'intent-plan');
  assert(result.trace.includes('semantic_review_passed'));
  assert.equal(result.plan.rowLimit, 100);
});
test('independent semantic rejection creates no executable proposal', async () => {
  const result = await proposeQuery({ ...context, connector: { getAuthorizedSchema: async () => schema }, provider: { generate: async () => ({ kind: 'plan', plan }), review: async () => ({ approved: false, issues: ['遗漏了用户要求的筛选条件'] }) } });
  assert.equal(result.kind, 'clarification');
  assert.equal(result.plan, undefined);
  assert.match(result.question, /遗漏/);
});
test('true business ambiguity is not replaced by random table sampling', async () => {
  const result = await proposeQuery({ ...context, shareRecords: true, connector: { getAuthorizedSchema: async () => schema }, provider: { generate: async () => ({ kind: 'clarification', reason: 'business_rule', question: '高价值按什么规则计算？' }) } });
  assert.equal(result.reason, 'business_rule');
  assert.equal(result.plan, undefined);
});
test('invented columns fail before review and learning-off returns no tutorial', async () => {
  const connector = { getAuthorizedSchema: async () => schema };
  await assert.rejects(proposeQuery({ ...context, connector, provider: { generate: async () => ({ kind: 'plan', plan: { ...plan, outputs: [{ column: 'invented', userTerm: '名字' }] } }), review: () => { throw new Error('must not review invalid structure'); } } }), /字段/);
  const result = await proposeQuery({ ...context, connector, learning: false, provider: { generate: async () => ({ kind: 'plan', plan }), review: approved } });
  assert.deepEqual(result.learning, []);
});
test('review sees original question and structured evidence instead of trusting generated SQL', () => {
  const messages = buildReviewMessages({ ...context, semantic: plan });
  assert.match(messages[0].content, /independently AUDIT/);
  assert.deepEqual(JSON.parse(messages[1].content).proposedPlan, plan);
});
