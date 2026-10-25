import test from 'node:test';
import assert from 'node:assert/strict';
import { Approvals } from '../src/sql/approvals.mjs';
import { prepareReadQuery } from '../src/sql/policy.mjs';
import { explainQuery } from '../src/sql/learning.mjs';
const scope = { database: 'menagerie', allowedTables: ['pet', 'event'] };

test('preview snapshots are immutable and consumable only once', () => {
  const approvals = new Approvals();
  const original = { sql: 'SELECT name FROM pet LIMIT 100', params: ['dog'] };
  const id = approvals.issue('connection', original);
  original.params[0] = 'cat';
  assert.equal(approvals.consume(id).plan.params[0], 'dog');
  assert.equal(approvals.consume(id), null);
});
test('expired, cancelled and removed-connection previews cannot execute', () => {
  let now = 0;
  const approvals = new Approvals(() => now);
  const id = approvals.issue('c', {});
  now = 300000;
  assert.equal(approvals.consume(id), null);
  const cancelled = approvals.issue('c', {});
  approvals.cancel(cancelled);
  assert.equal(approvals.consume(cancelled), null);
  const removed = approvals.issue('c', {});
  approvals.removeConnection('c');
  assert.equal(approvals.consume(removed), null);
});
test('canonical SQL retains LIMIT even after a trailing semicolon', () => {
  const plan = prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet;' });
  assert.match(plan.sql, /LIMIT 100$/);
  assert.equal(prepareReadQuery({ ...scope, sql: plan.sql }).sql, plan.sql);
});
for (const sql of [
  'SELECT name FROM pet -- comment',
  'SELECT name FROM pet UNION SELECT name FROM pet',
  'SELECT name FROM pet WHERE name IN (SELECT name FROM event)',
  'SELECT name FROM pet WHERE name = \'Fluffy\'',
  'SELECT custom_function(name) FROM pet',
  'SELECT @@version FROM pet',
  'SELECT name FROM pet /*! INTO OUTFILE \'x\' */',
]) test(`rejects unsupported SQL: ${sql}`, () => {
  assert.throws(() => prepareReadQuery({ ...scope, sql }));
});
test('configurable limits and teaching segments describe actual clauses', () => {
  const plan = prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet WHERE species = ? ORDER BY name', params: ['dog'], defaultLimit: 50 });
  assert.equal(plan.rowLimit, 50);
  const lessons = explainQuery(plan);
  assert(lessons.some(segment => segment.title.includes('WHERE')));
  assert(lessons.some(segment => segment.text.includes('LIMIT 50')));
  assert(!lessons.some(segment => segment.title.includes('GROUP BY')));
});
