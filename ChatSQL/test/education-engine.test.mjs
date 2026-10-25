import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEducation, scanSql } from '../src/sql/learning.mjs';
import { Approvals } from '../src/sql/approvals.mjs';
const teach = (sql, params = [], extra = {}) => buildEducation({ sql, params, ...extra });
const find = (doc, id) => doc.glossary.find(item => item.id === id);

test('actor projection explains actual SQL roles, reasons, contrast, order and limitations', () => {
  const sql = 'SELECT first_name, last_name\nFROM actor\nLIMIT 100;';
  const doc = teach(sql);
  assert.equal(doc.version, 'education-v2'); assert.equal(doc.status, 'supported');
  assert.deepEqual(doc.writingOrder, ['SELECT', 'FROM', 'LIMIT']);
  assert.deepEqual(doc.logicalOrder, ['FROM', 'SELECT', 'LIMIT']);
  assert.match(doc.orderNote, /不是数据库物理执行计划/);
  assert.equal(doc.clauses[0].sql, 'SELECT first_name, last_name');
  for (const clause of doc.clauses) { assert.equal(sql.slice(clause.range.start, clause.range.end), clause.sql); assert(clause.what); assert(clause.why); }
  assert.match(doc.clauses[0].what, /first_name.*last_name/);
  assert.match(doc.clauses.find(item => item.id === 'limit').what, /100/);
  assert(doc.clauses[0].comparison);
  assert(find(doc, 'comma')); assert(find(doc, 'terminator'));
  assert(doc.warnings.some(warning => warning.includes('没有 ORDER BY')));
  assert(!doc.clauses.some(item => item.id === 'where' || item.id === 'group-by'));
});
test('trusted plan intent is separated from grammar and business assumptions', () => {
  const doc = teach('SELECT name FROM pet WHERE species = ? LIMIT 100', ['dog'], { semantic: { intent: '查询狗的名字', rowLimit: 100, outputs: [{ column: 'name', userTerm: '名字' }], filters: [{ column: 'species', operator: '=', value: 'dog', userTerm: '狗', source: '实际样例' }] } });
  assert.equal(doc.overview, '查询狗的名字');
  assert(doc.clauses.find(item => item.id === 'where').details.some(text => text.includes('实际样例')));
});
test('DISTINCT is output-combination deduplication, not sorting or first-column deduplication', () => {
  const doc = teach('SELECT DISTINCT first_name, last_name FROM actor LIMIT 100');
  const distinct = doc.clauses.find(item => item.id === 'distinct');
  assert.match(distinct.what, /组合/); assert(distinct.pitfalls.some(text => text.includes('不是只对第一列')));
  assert(doc.logicalOrder.indexOf('DISTINCT') > doc.logicalOrder.indexOf('SELECT'));
  assert.equal(doc.sql.slice(distinct.range.start, distinct.range.end), 'DISTINCT');
});
for (const [sql, phrase] of [
  ['SELECT COUNT(*) AS n FROM actor LIMIT 100', '统计符合条件的行'],
  ['SELECT COUNT(first_name) AS n FROM actor LIMIT 100', '不为 NULL'],
  ['SELECT COUNT(DISTINCT first_name) AS n FROM actor LIMIT 100', '去重后计数'],
]) test(`count semantics: ${sql}`, () => {
  const doc = teach(sql), count = find(doc, 'function-count');
  assert(count); assert.match(count.text, new RegExp(phrase.replaceAll('*', '\\*')));
  assert(count.details.some(text => text.includes('返回 0')));
  assert(doc.warnings.some(text => text.includes('不代表只统计')));
});
test('SELECT star, COUNT star and multiplication are different actual contexts', () => {
  assert(find(teach('SELECT * FROM actor LIMIT 100'), 'select-star'));
  assert(!find(teach('SELECT COUNT(*) FROM actor LIMIT 100'), 'select-star'));
  assert.match(find(teach('SELECT length * 2 AS doubled FROM film LIMIT 100'), 'arithmetic-*').text, /乘法/);
});
test('grouping, HAVING and multiple sort keys explain their actual roles', () => {
  const doc = teach('SELECT rating, AVG(length) AS average_length FROM film WHERE length > ? GROUP BY rating HAVING AVG(length) > ? ORDER BY average_length DESC, rating ASC LIMIT 10', [50, 100]);
  assert.equal(doc.status, 'supported');
  assert(doc.clauses.find(item => item.id === 'group-by').what.includes('rating'));
  assert(doc.clauses.find(item => item.id === 'having').why.includes('聚合'));
  assert(doc.clauses.find(item => item.id === 'order-by').what.includes('DESC'));
  assert(find(doc, 'function-avg').details.some(text => text.includes('NULL')));
  assert(doc.logicalOrder.indexOf('WHERE') < doc.logicalOrder.indexOf('GROUP BY'));
});
test('LIKE patterns resolve each actual parameter and explain percent/underscore only in context', () => {
  const doc = teach('SELECT title FROM film WHERE title LIKE ? OR title LIKE ? LIMIT 100', ['A%', 'B_']);
  const likes = doc.glossary.filter(item => item.id === 'like');
  assert.equal(likes.length, 2);
  assert(likes[0].details.some(text => text.includes('A%'))); assert(likes[1].details.some(text => text.includes('B_')));
  assert.match(likes[0].text, /零个或多个.*一个字符/);
  assert(!find(teach("SELECT '100%_ FROM' AS note FROM film LIMIT 100"), 'like'));
  assert(!find(teach('SELECT length % 2 AS remainder FROM film LIMIT 100'), 'like'));
});
test('LIKE pattern parameter is not confused with a parameter in its left-hand function', () => {
  const doc = teach('SELECT title FROM film WHERE COALESCE(title, ?) LIKE ? LIMIT 100', ['fallback', 'A%']);
  const like = find(doc, 'like');
  assert(like.details.some(text => text.includes('A%')));
  assert(!like.details.some(text => text.includes('fallback')));
});
test('parameter numbers and provided NULL remain distinct from missing values', () => {
  const doc = teach('SELECT name FROM pet WHERE species = ? AND death IS ? LIMIT 100', ['dog', null]);
  assert.deepEqual(doc.parameters.map(item => item.value), ['dog', null]);
  assert(doc.parameters.every(item => item.provided));
  assert(teach('SELECT name FROM pet WHERE species = ? LIMIT 100').warnings.some(text => text.includes('参数位置')));
});
test('NULL checks and ordinary equality to NULL are not confused', () => {
  assert.match(find(teach('SELECT name FROM pet WHERE death IS NULL LIMIT 100'), 'null').text, /IS NULL/);
  assert.match(find(teach('SELECT name FROM pet WHERE death = NULL LIMIT 100'), 'null').text, /UNKNOWN/);
});
test('AND OR parentheses and NOT explain boolean precedence', () => {
  const doc = teach('SELECT title FROM film WHERE NOT (length > ? AND rental_rate > ?) OR rating = ? LIMIT 100', [50, 2, 'G']);
  assert(find(doc, 'boolean-AND')); assert(find(doc, 'boolean-OR')); assert(find(doc, 'parentheses'));
  assert(find(doc, 'boolean-AND').details.some(text => text.includes('AND 高于 OR')));
});
test('keywords inside quoted identifiers, literal strings and comments cannot create false clauses', () => {
  const sql = "SELECT first_name AS `FROM`, 'WHERE GROUP BY' AS note FROM actor /* WHERE fake */ LIMIT 100;";
  const doc = teach(sql);
  assert.equal(doc.status, 'supported');
  assert.deepEqual(doc.clauses.map(item => item.id), ['select', 'from', 'limit']);
  assert.equal(doc.clauses.find(item => item.id === 'from').range.start, sql.indexOf('FROM actor'));
  assert(scanSql(sql).filter(token => token.upper === 'WHERE').length === 0);
});
test('decimal points do not become qualified-column dot lessons', () => {
  assert(!find(teach('SELECT ROUND(length, 2.0) FROM film LIMIT 100'), 'qualification'));
  assert(find(teach('SELECT f.title FROM film f LIMIT 100'), 'qualification'));
});
test('known scalar functions explain actual calls while unknown functions are not invented', () => {
  const doc = teach('SELECT LOWER(title), LENGTH(title), COALESCE(description, title), custom_function(title) FROM film LIMIT 100');
  assert.match(find(doc, 'function-length').text, /字节数不一定等于字符数/);
  assert.match(find(doc, 'function-coalesce').text, /第一个非 NULL|缺失值提供回退/);
  assert.match(find(doc, 'function-custom_function').text, /没有.*内置/);
});
test('join explanation uses actual join type and does not claim foreign-key facts', () => {
  const doc = teach('SELECT a.actor_id, fa.film_id FROM actor a LEFT JOIN film_actor fa ON a.actor_id = fa.actor_id LIMIT 100');
  const from = doc.clauses.find(item => item.id === 'from');
  assert(from.details.some(text => text.includes('保留左侧行')));
  assert(from.pitfalls.some(text => text.includes('没有外键证据')));
});
for (const sql of ['SELECT name FROM pet; SELECT title FROM film', 'WITH p AS (SELECT name FROM pet) SELECT name FROM p', 'SELECT name FROM pet UNION SELECT name FROM pet', 'SELECT name FROM pet WHERE name IN (SELECT name FROM pet)', 'DELETE FROM pet', 'SELECT nonsense syntax FROM']) test(`unsupported teaching is explicit: ${sql}`, () => {
  const doc = teach(sql);
  assert.equal(doc.status, 'unsupported'); assert(doc.message); assert.deepEqual(doc.clauses, []);
});
test('education fingerprint changes when SQL or parameter values change', () => {
  assert.notEqual(teach('SELECT name FROM pet WHERE species = ?', ['dog']).fingerprint, teach('SELECT name FROM pet WHERE species = ?', ['cat']).fingerprint);
});
test('peek copies a live approval without consuming or extending its expiration', () => {
  let now = 0; const approvals = new Approvals(() => now);
  const id = approvals.issue('c', { sql: 'SELECT name FROM pet LIMIT 100', params: [] });
  approvals.peek(id).plan.sql = 'changed';
  assert.match(approvals.peek(id).plan.sql, /^SELECT/);
  now = 299999; assert(approvals.peek(id));
  now = 300000; assert.equal(approvals.peek(id), null); assert.equal(approvals.consume(id), null);
  const second = approvals.issue('c', {}); approvals.peek(second); assert(approvals.consume(second));
});
