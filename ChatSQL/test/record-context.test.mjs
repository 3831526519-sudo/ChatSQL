import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordContext } from '../src/model/records.mjs';
import { validateMysqlConfig } from '../src/mysql/connector.mjs';
import { proposeQuery } from '../src/model/agent.mjs';
const schema = [{ name: 'pet', columns: [{ name: 'name', type: 'varchar(20)' }, { name: 'species', type: 'varchar(20)' }] }];
const base = { host: 'localhost', user: 'reader', database: 'menagerie', allowedTables: [] };
const result = { sql: 'SELECT DISTINCT species FROM pet LIMIT 100', tables: ['pet'], columns: ['species', 'password'], rows: [{ species: 'dog', password: 'synthetic-sensitive' }, { species: 'cat', password: 'synthetic-sensitive' }] };
const intent = { intent: '查询狗的名字', table: 'pet', outputs: [{ column: 'name', userTerm: '名字' }], filters: [{ column: 'species', operator: '=', value: 'dog', userTerm: '狗', evidence: 'observed' }] };

test('whole-database and record sharing require explicit risk acceptance', () => {
  assert.throws(() => validateMysqlConfig({ ...base, wholeDatabase: true }), /风险/);
  assert.throws(() => validateMysqlConfig({ ...base, shareRecords: true }), /风险/);
  const config = validateMysqlConfig({ ...base, wholeDatabase: true, shareRecords: true, riskAccepted: true });
  assert.equal(config.wholeDatabase, true); assert.equal(config.shareRecords, true);
  assert.equal(config.database, 'menagerie'); assert.deepEqual(config.allowedTables, []);
});
test('confirmed context filters common sensitive columns and is connection isolated', () => {
  const records = new RecordContext(); records.remember('c1', result);
  const samples = records.get('c1', schema);
  assert.equal(samples[0].rows[0].species, 'dog');
  assert(!JSON.stringify(samples).includes('synthetic-sensitive'));
  assert.deepEqual(records.get('c2', schema), []); assert.deepEqual(records.get('c1', []), []);
});
test('record context is bounded, expires and is removable; truncated values are marked', () => {
  let now = 0; const records = new RecordContext(() => now);
  for (let i = 0; i < 8; i++) records.remember('c', { ...result, sql: `SELECT species FROM pet LIMIT ${100 + i}`, rows: Array.from({ length: 200 }, () => ({ species: 'x'.repeat(1000) })) });
  const samples = records.get('c', schema);
  assert.equal(samples.length, 4);
  assert(samples.every(sample => sample.rows.length <= 100 && sample.rows[0].species.length === 256 && sample.truncatedColumns.includes('species')));
  now = 900001; assert.deepEqual(records.get('c', schema), []);
  records.remember('c', result); records.remove('c'); assert.deepEqual(records.get('c', schema), []);
});
test('expressions aliased as original columns cannot fabricate observed field values', () => {
  const records = new RecordContext();
  records.remember('c', { ...result, sql: 'SELECT UPPER(species) AS species FROM pet LIMIT 100', rows: [{ species: 'DOG' }] });
  assert.deepEqual(records.get('c', schema), []);
  records.remember('c', { ...result, sql: 'SELECT species AS observed FROM pet LIMIT 100', columns: ['observed'], rows: [{ observed: 'dog' }] });
  assert.equal(records.get('c', schema)[0].rows[0].species, 'dog');
});
test('agent sees records only with consent and compiler requires their evidence', async () => {
  const records = new RecordContext(); records.remember('c', result);
  const seen = [];
  const provider = { generate: async input => { seen.push(input); return { kind: 'plan', plan: intent }; }, review: async () => ({ approved: true, issues: [] }) };
  const options = { provider, connector: { getAuthorizedSchema: async () => schema }, database: 'menagerie', question: '查询狗的名字', recordContext: records, connectionId: 'c' };
  assert.equal((await proposeQuery({ ...options, shareRecords: false })).reason, 'permission');
  const grounded = await proposeQuery({ ...options, shareRecords: true });
  assert.deepEqual(seen[0].samples, []);
  assert.equal(seen[1].samples[0].rows[0].species, 'dog');
  assert.deepEqual(grounded.plan.params, ['dog']);
});
test('data-value clarification uses typed references, never text matching or a random first table', async () => {
  const result = await proposeQuery({ provider: { generate: async () => ({ kind: 'clarification', reason: 'data_value', table: 'pet', column: 'species', question: '哪个字段值表示狗？' }) }, connector: { getAuthorizedSchema: async () => [{ name: 'unrelated', columns: [{ name: 'id', type: 'int' }] }, ...schema] }, database: 'menagerie', question: '狗的名字', shareRecords: true, recordContext: new RecordContext(), connectionId: 'c' });
  assert.equal(result.kind, 'inspection');
  assert.match(result.plan.sql, /SELECT DISTINCT `species` FROM `pet` LIMIT 100/);
  assert.equal(result.plan.inspectionQuestion, '狗的名字');
});
test('inspection cannot repeatedly read a field whose evidence is already available', async () => {
  const records = new RecordContext(); records.remember('c', result);
  const proposal = await proposeQuery({ provider: { generate: async () => ({ kind: 'inspection', table: 'pet', column: 'species' }) }, connector: { getAuthorizedSchema: async () => schema }, database: 'menagerie', question: '狗的名字', shareRecords: true, recordContext: records, connectionId: 'c' });
  assert.equal(proposal.reason, 'evidence_inconclusive');
  assert.equal(proposal.plan, undefined);
});
