import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMysqlConfig } from '../src/mysql/connector.mjs';

const valid = {
  host: '127.0.0.1', port: 3306, user: 'agent_readonly', password: 'local-only',
  database: 'menagerie', allowedTables: ['pet', 'event', 'pet'],
};

test('normalizes connection values and deduplicates authorized tables', () => {
  const config = validateMysqlConfig(valid);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3306);
  assert.equal(config.database, 'menagerie');
  assert.deepEqual(config.allowedTables, ['pet', 'event']);
  assert.equal(config.password, 'local-only');
});

test('rejects a missing default database instead of broadening scope', () => {
  assert.throws(() => validateMysqlConfig({ ...valid, database: '' }), /default database/);
});

test('rejects invalid ports and unsafe control characters', () => {
  assert.throws(() => validateMysqlConfig({ ...valid, port: 70000 }), /port/);
  assert.throws(() => validateMysqlConfig({ ...valid, host: 'localhost\nexample' }), /host/);
  assert.throws(() => validateMysqlConfig({ ...valid, allowedTables: ['pet\n, users'] }), /table list/);
});

test('empty table authorization remains empty', () => {
  assert.deepEqual(validateMysqlConfig({ ...valid, allowedTables: [] }).allowedTables, []);
});
