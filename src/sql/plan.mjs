import { prepareReadQuery } from './policy.mjs';
export class PlanError extends TypeError {}
export class EvidenceRequired extends PlanError {
  constructor(table, column) { super(`需要读取 ${table}.${column} 的实际取值后再确定筛选值`); this.table = table; this.column = column; }
}
const quote = value => '`' + value.replaceAll('`', '``') + '`';
const fail = message => { throw new PlanError(message); };
function onlyKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`${label} 格式不符合查询计划契约`);
}
function array(value, label, max = 20) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} 必须是最多 ${max} 项的数组`);
  return value;
}
export function compileIntentPlan(input, { question, schema, database, samples = [], defaultLimit = 100 }) {
  onlyKeys(input, ['intent', 'table', 'outputs', 'filters', 'groupBy', 'orderBy', 'distinct', 'limit'], '查询计划');
  if (typeof input.intent !== 'string' || !input.intent.trim() || input.intent.length > 1000) fail('查询计划缺少简明意图');
  const table = schema.find(table => table.name === input.table);
  if (!table) fail('查询计划使用了不存在或未授权的表');
  const column = name => {
    const found = table.columns.find(column => column.name === name);
    if (!found) fail(`不存在或未授权的字段：${table.name}.${String(name)}`);
    return found;
  };
  const term = value => {
    if (typeof value !== 'string' || !value.trim() || !question.includes(value)) fail('计划中的需求片段必须逐字来自用户问题，不能新增需求');
    return value;
  };
  const outputs = array(input.outputs, '返回项');
  if (!outputs.length) fail('至少选择一个返回项');
  const aggregateNames = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
  const outputLabels = new Set();
  const outputFacts = [];
  const select = outputs.map(output => {
    onlyKeys(output, ['column', 'aggregate', 'alias', 'userTerm'], '返回项');
    term(output.userTerm);
    const aggregate = output.aggregate || null;
    if (aggregate && !aggregateNames.has(aggregate)) fail('不支持的聚合函数');
    if (output.column !== '*' || aggregate !== 'COUNT') column(output.column);
    if (output.column === '*' && aggregate !== 'COUNT') fail('必须列出明确字段');
    if (['SUM', 'AVG'].includes(aggregate) && !/int|decimal|float|double|numeric|real|bit/i.test(column(output.column).type)) fail('求和或平均值需要数值字段');
    const alias = output.alias || (aggregate ? `${aggregate.toLowerCase()}_${output.column === '*' ? 'rows' : output.column}` : output.column);
    if (typeof alias !== 'string' || !alias || alias.length > 64 || /[\0\r\n]/.test(alias)) fail('返回项别名不合法');
    if (outputLabels.has(alias)) fail('返回列名重复，请使用不同别名');
    outputLabels.add(alias);
    outputFacts.push({ column: output.column, aggregate, alias, userTerm: output.userTerm });
    const expr = aggregate ? `${aggregate}(${output.column === '*' ? '*' : quote(output.column)})` : quote(output.column);
    return expr + (alias !== output.column || aggregate ? ` AS ${quote(alias)}` : '');
  });
  const params = [];
  const filterFacts = [];
  const filters = array(input.filters || [], '筛选条件');
  const conditions = filters.map(filter => {
    onlyKeys(filter, ['column', 'operator', 'value', 'userTerm', 'evidence'], '筛选条件');
    const metadata = column(filter.column);
    if (/binary|blob|json|geometry/i.test(metadata.type)) fail('首版不支持对二进制、JSON 或空间字段推断筛选值');
    term(filter.userTerm);
    const operator = filter.operator;
    if (!['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL'].includes(operator)) fail('首版仅支持明确列出的比较运算符与 AND 组合');
    if (['IS NULL', 'IS NOT NULL'].includes(operator)) {
      if (filter.value !== undefined && filter.value !== null) fail('空值条件不接受额外参数');
      filterFacts.push({ ...filter, value: null, source: '用户问题', parameterIndexes: [] });
      return `${quote(filter.column)} ${operator}`;
    }
    const values = operator === 'IN' ? array(filter.value, 'IN 参数', 50) : [filter.value];
    if (!values.length) fail('IN 条件不能为空');
    const indexes = [];
    const sources = [];
    for (const value of values) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && value.length > 1000) fail('不支持的参数值');
      const rawLiteral = operator === 'LIKE' && typeof value === 'string' ? value.replace(/^%|%$/g, '') : String(value);
      const literal = filter.evidence === 'user' && rawLiteral.length > 0 && question.includes(rawLiteral);
      const observed = filter.evidence === 'observed' && samples.some(sample => sample.tables.length === 1 && sample.tables[0] === table.name && sample.columns.includes(filter.column) && !sample.truncatedColumns?.includes(filter.column) && sample.rows.some(row => Object.is(row[filter.column], value)));
      if (!literal && !observed) throw new EvidenceRequired(table.name, filter.column);
      if (!['=', '!=', 'IN'].includes(operator) && !literal) fail('范围与模糊条件必须直接依据用户明确提供的值，不能从样例猜测业务阈值');
      if (/int|decimal|float|double|numeric|real|bit/i.test(metadata.type) && typeof value !== 'number') fail(`数值字段 ${filter.column} 需要数值参数`);
      if (/char|text|enum|set/i.test(metadata.type) && typeof value !== 'string') fail(`文本字段 ${filter.column} 需要文本参数`);
      params.push(value); indexes.push(params.length); sources.push(literal ? '用户问题中的明确值' : '已确认读取的实际字段值');
    }
    filterFacts.push({ column: filter.column, operator, value: filter.value, userTerm: filter.userTerm, source: [...new Set(sources)].join('、'), parameterIndexes: indexes });
    return `${quote(filter.column)} ${operator} ${operator === 'IN' ? '(' + values.map(() => '?').join(', ') + ')' : '?'}`;
  });
  const groupBy = array(input.groupBy || [], '分组字段');
  groupBy.forEach(column);
  const hasAggregate = outputFacts.some(output => output.aggregate);
  if (hasAggregate && outputFacts.some(output => !output.aggregate && !groupBy.includes(output.column))) fail('非聚合返回项必须出现在分组字段中');
  if (!hasAggregate && groupBy.length) fail('无聚合计算时请使用去重而不是不明确的分组');
  const orderBy = array(input.orderBy || [], '排序项');
  const order = orderBy.map(item => {
    onlyKeys(item, ['column', 'direction', 'userTerm'], '排序项'); term(item.userTerm);
    if (!outputLabels.has(item.column)) column(item.column);
    if (!['ASC', 'DESC'].includes(item.direction)) fail('排序方向只能为 ASC 或 DESC');
    return `${quote(item.column)} ${item.direction}`;
  });
  if (input.distinct !== undefined && typeof input.distinct !== 'boolean') fail('去重标志必须是布尔值');
  const limit = input.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('行数上限必须在 1–1000 之间');
  if (limit !== defaultLimit && !question.includes(String(limit))) fail('不能添加用户未要求的行数限制');
  const sql = `SELECT ${input.distinct ? 'DISTINCT ' : ''}${select.join(', ')} FROM ${quote(table.name)}` + (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '') + (groupBy.length ? ` GROUP BY ${groupBy.map(quote).join(', ')}` : '') + (order.length ? ` ORDER BY ${order.join(', ')}` : '') + ` LIMIT ${limit}`;
  const compiled = prepareReadQuery({ sql, params, database, schema, allowedTables: schema.map(table => table.name), defaultLimit });
  return { ...compiled, semantic: { version: 1, intent: input.intent, question, table: table.name, outputs: outputFacts, filters: filterFacts, groupBy, orderBy, distinct: input.distinct === true, rowLimit: limit, review: 'pending' } };
}
export function compileInspection({ table: tableName, column: columnName }, { database, schema }) {
  const table = schema.find(table => table.name === tableName);
  if (!table || !table.columns.some(column => column.name === columnName)) fail('辅助取值必须指定真实且已授权的表和字段');
  return prepareReadQuery({ sql: `SELECT DISTINCT ${quote(columnName)} FROM ${quote(tableName)} LIMIT 100`, params: [], database, schema, allowedTables: schema.map(table => table.name) });
}
