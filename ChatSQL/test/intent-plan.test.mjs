import test from 'node:test';
import assert from 'node:assert/strict';
import { compileIntentPlan, compileInspection, EvidenceRequired } from '../src/sql/plan.mjs';
const schema = [{ name: 'pet', columns: [{ name: 'name', type: 'varchar(20)' }, { name: 'species', type: 'varchar(20)' }, { name: 'age', type: 'int' }] }];
const scope = { question: '查询狗的名字', database: 'menagerie', schema, defaultLimit: 100 };
const intent = { intent: '查询狗的名字', table: 'pet', outputs: [{ column: 'name', userTerm: '名字' }], filters: [{ column: 'species', operator: '=', value: 'dog', userTerm: '狗', evidence: 'observed' }] };
const samples = [{ tables: ['pet'], columns: ['species'], rows: [{ species: 'dog' }, { species: 'cat' }] }];

test('compiler binds observed values and attaches their provenance to the same plan', () => {
  const plan = compileIntentPlan(intent, { ...scope, samples });
  assert.equal(plan.sql, 'SELECT `name` FROM `pet` WHERE `species` = ? LIMIT 100');
  assert.deepEqual(plan.params, ['dog']);
  assert.equal(plan.semantic.filters[0].source, '已确认读取的实际字段值');
  assert.deepEqual(plan.semantic.filters[0].parameterIndexes, [1]);
});
test('missing enum evidence yields a typed requirement, never an invented value', () => {
  assert.throws(() => compileIntentPlan(intent, scope), error => error instanceof EvidenceRequired && error.table === 'pet' && error.column === 'species');
});
for (const value of ['犬', 'D01', 'canine']) test(`stored encoding ${value} is supplied through evidence, not hardcoded dog logic`, () => {
  const plan = compileIntentPlan({ ...intent, filters: [{ ...intent.filters[0], value }] }, { ...scope, samples: [{ tables: ['pet'], columns: ['species'], rows: [{ species: value }] }] });
  assert.deepEqual(plan.params, [value]);
  assert.equal(plan.sql.includes(value), false);
});
test('values from another connection/table or truncated content cannot establish evidence', () => {
  assert.throws(() => compileIntentPlan(intent, { ...scope, samples: [{ ...samples[0], tables: ['other'] }] }), EvidenceRequired);
  assert.throws(() => compileIntentPlan(intent, { ...scope, samples: [{ ...samples[0], truncatedColumns: ['species'] }] }), EvidenceRequired);
});
test('user literal values are bound and SQL injection text remains a value', () => {
  const value = "x' OR 1=1 --";
  const plan = compileIntentPlan({ ...intent, filters: [{ column: 'name', operator: '=', value, userTerm: value, evidence: 'user' }] }, { ...scope, question: `查询名字等于${value}` });
  assert.deepEqual(plan.params, [value]);
  assert.equal(plan.sql.includes('OR 1=1'), false);
});
test('fake user evidence, unsupported operators and extra requirements fail closed', () => {
  assert.throws(() => compileIntentPlan({ ...intent, filters: [{ ...intent.filters[0], evidence: 'user' }] }, scope), EvidenceRequired);
  assert.throws(() => compileIntentPlan({ ...intent, filters: [{ ...intent.filters[0], userTerm: '已付款' }] }, scope), /新增需求/);
  assert.throws(() => compileIntentPlan({ ...intent, filters: [{ ...intent.filters[0], operator: 'OR' }] }, scope));
  assert.throws(() => compileIntentPlan({ ...intent, joins: ['other'] }, scope));
});
test('unknown table and column cannot be compiled', () => {
  assert.throws(() => compileIntentPlan({ ...intent, table: 'invented' }, scope), /未授权/);
  assert.throws(() => compileIntentPlan({ ...intent, outputs: [{ column: 'invented', userTerm: '名字' }] }, scope), /字段/);
});
test('explicit numeric comparisons and ordering compile with typed parameters', () => {
  const plan = compileIntentPlan({ intent: '年龄大于18并按年龄降序', table: 'pet', outputs: [{ column: 'name', userTerm: '名字' }], filters: [{ column: 'age', operator: '>', value: 18, userTerm: '18', evidence: 'user' }], orderBy: [{ column: 'age', direction: 'DESC', userTerm: '年龄降序' }] }, { ...scope, question: '查询年龄大于18的名字，按年龄降序' });
  assert.deepEqual(plan.params, [18]); assert.match(plan.sql, /ORDER BY `age` DESC/);
});
test('business thresholds cannot be inferred from observed sample values', () => {
  assert.throws(() => compileIntentPlan({ ...intent, filters: [{ column: 'age', operator: '>=', value: 18, userTerm: '成年', evidence: 'observed' }] }, { ...scope, question: '成年宠物的名字', samples: [{ tables: ['pet'], columns: ['age'], rows: [{ age: 18 }] }] }), /业务阈值/);
});
test('count and grouped aggregates require valid grouping', () => {
  const grouped = { intent: '每种宠物的数量', table: 'pet', outputs: [{ column: 'species', userTerm: '种类' }, { column: '*', aggregate: 'COUNT', alias: 'total', userTerm: '数量' }], groupBy: ['species'] };
  const plan = compileIntentPlan(grouped, { ...scope, question: '按种类统计数量' });
  assert.match(plan.sql, /COUNT\(\*\)/); assert.match(plan.sql, /GROUP BY/);
  assert.throws(() => compileIntentPlan({ ...grouped, groupBy: [] }, { ...scope, question: '按种类统计数量' }), /分组/);
});
test('row limits stay bounded and may not silently add a requested top-N', () => {
  assert.throws(() => compileIntentPlan({ ...intent, limit: 1001 }, { ...scope, samples }));
  assert.throws(() => compileIntentPlan({ ...intent, limit: 3 }, { ...scope, samples }), /未要求/);
  assert.equal(compileIntentPlan({ ...intent, limit: 3 }, { ...scope, question: '查询3只狗的名字', samples }).rowLimit, 3);
});
test('inspection SQL is built from schema identifiers, with explicit DISTINCT and LIMIT', () => {
  assert.match(compileInspection({ table: 'pet', column: 'species' }, scope).sql, /^SELECT DISTINCT `species` FROM `pet` LIMIT 100$/);
  assert.throws(() => compileInspection({ table: 'pet', column: 'invented' }, scope));
});
