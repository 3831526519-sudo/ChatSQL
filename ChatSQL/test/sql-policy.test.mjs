import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReadQuery } from '../src/sql/policy.mjs';

const scope = { database: 'menagerie', allowedTables: ['pet', 'event'] };

test('adds the default row limit to a scoped SELECT', () => {
  const result = prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet WHERE species = ?', params: ['dog'] });
  assert.equal(result.sql, 'SELECT `name` FROM `pet` WHERE `species` = ? LIMIT 100');
  assert.equal(result.rowLimit, 100);
  assert.deepEqual(result.tables, ['pet']);
});

test('keeps a valid requested limit under the hard cap', () => {
  const result = prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet LIMIT 25' });
  assert.equal(result.rowLimit, 25);
  assert.equal(result.sql, 'SELECT `name` FROM `pet` LIMIT 25');
});

test('allows joins only when every referenced table is authorized', () => {
  const result = prepareReadQuery({ ...scope, sql: 'SELECT pet.name, event.type FROM pet JOIN event ON pet.name = event.name' });
  assert.deepEqual(new Set(result.tables), new Set(['pet', 'event']));
  assert.equal(result.rowLimit, 100);
});

test('rejects write statements and multiple statements', () => {
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'DELETE FROM pet' }), /Only one SELECT/);
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet; SELECT type FROM event' }), /Only one SELECT/);
});

test('rejects wildcards, out-of-scope tables, and cross-database reads', () => {
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT * FROM pet' }), /Wildcard/);
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT name FROM mysql.user' }), /Cross-database|not authorized/);
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT name FROM customer' }), /not authorized/);
});

test('rejects file output, locking reads, and risky functions', () => {
  assert.throws(() => prepareReadQuery({ ...scope, sql: "SELECT name INTO OUTFILE 'x' FROM pet" }), /SELECT INTO/);
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet FOR UPDATE' }), /Locking/);
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT SLEEP(2) FROM pet' }), /function/);
});

test('enforces parameter count and literal bounded LIMIT', () => {
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet WHERE species = ?', params: [] }), /Expected 1/);
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet LIMIT 1001' }), /cannot exceed 1000/);
  assert.throws(() => prepareReadQuery({ ...scope, sql: 'SELECT name FROM pet LIMIT ?' , params: [10] }), /LIMIT must use integer literals/);
});
