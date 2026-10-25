import sqlParser from 'node-sql-parser';
const { Parser } = sqlParser;
const parser = new Parser();
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
const functions = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'LOWER', 'UPPER', 'LENGTH', 'COALESCE', 'ROUND', 'ABS', 'YEAR', 'MONTH', 'DAY', 'DATEDIFF']);
export class QueryPolicyError extends Error {}
function fail(message) { throw new QueryPolicyError(message); }
function walk(node, callback, parent = null) {
  if (!node || typeof node !== 'object') return;
  callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, callback, node));
    else if (value && typeof value === 'object') walk(value, callback, node);
  }
}
export function prepareReadQuery({ sql, params = [], database, allowedTables, schema, defaultLimit = DEFAULT_LIMIT }) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 20000) fail('SQL is required and must be under 20000 characters');
  if (!Array.isArray(params) || params.length > 200 || params.some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v))) fail('Invalid query parameters');
  if (!database || !Array.isArray(allowedTables)) fail('Database scope is not configured');
  if (!Number.isInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > MAX_LIMIT) fail('Invalid default LIMIT');
  // Deliberately restricted first version. Executable comments and hints are not supported.
  if (/\/\*|--|#|@|:=/.test(sql)) fail('SQL comments, hints and variables are not supported');
  let ast;
  try { ast = parser.astify(sql, { database: 'MySQL' }); } catch { fail('SQL could not be parsed as a safe MySQL query'); }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) fail('Only one SELECT statement is allowed');
    ast = ast[0];
  }
  if (ast?.type !== 'select') fail('Only one SELECT statement is allowed');
  let placeholders = 0;
  walk(ast, (node, parent) => {
    if (node !== ast && node.type === 'select' || node.with || node._next || node.set_op) fail('Subqueries, unions and CTEs are not enabled yet');
    if (node.into && Object.values(node.into).some(Boolean)) fail('SELECT INTO is not allowed');
    if (node.locking_read) fail('Locking reads are not allowed');
    if (node.options?.length || node.window) fail('SELECT options and windows are not enabled yet');
    if (node.type === 'column_ref' && node.column === '*' && !(parent?.type === 'aggr_func' && parent.name === 'COUNT')) fail('Wildcard columns are not allowed; list the columns explicitly');
    if (node.type === 'origin') { if (node.value !== '?') fail('Unsupported expression'); placeholders++; }
    if (node.type === 'function' || node.type === 'aggr_func') {
      const name = typeof node.name === 'string' ? node.name : node.name?.name?.length === 1 ? node.name.name[0].value : '';
      if (!functions.has(String(name).toUpperCase())) fail('This function is not allowed in read queries');
    }
    if (['single_quote_string', 'double_quote_string'].includes(node.type)) fail('Use ? parameters for string values');
  });
  if (placeholders !== params.length) fail(`Expected ${placeholders} query parameters, received ${params.length}`);
  const tables = [];
  // Restrict to ordinary authorized base tables; no derived/table-function sources.
  if (!Array.isArray(ast.from) || !ast.from.length) fail('A scoped table is required');
  for (const source of ast.from) {
    if (typeof source.table !== 'string' || source.expr || source.db && source.db !== database) fail('Cross-database or derived table access is not permitted');
    if (!allowedTables.includes(source.table)) fail(`Table is not authorized: ${source.table}`);
    tables.push(source.table);
  }
  if (schema) {
    const sources = ast.from.map(source => ({ alias: source.as || source.table, table: source.table, columns: schema.find(table => table.name === source.table)?.columns || [] }));
    const aliases = new Set(ast.columns.map(column => column.as).filter(Boolean));
    const validateColumns = (root, allowAliases = false) => walk(root, node => {
      if (node.type !== 'column_ref' || node.column === '*') return;
      if (node.db && node.db !== database) fail('Cross-database column reference is not permitted');
      const matches = sources.filter(source => (!node.table || node.table === source.alias) && source.columns.some(column => column.name === node.column));
      if (allowAliases && !node.table && aliases.has(node.column)) return;
      if (matches.length !== 1) fail(`Unknown or ambiguous column: ${node.table ? node.table + '.' : ''}${node.column}`);
    });
    validateColumns(ast.columns);
    validateColumns(ast.from);
    validateColumns(ast.where);
    validateColumns(ast.groupby, true);
    validateColumns(ast.having, true);
    validateColumns(ast.orderby, true);
  }
  let limit = defaultLimit;
  if (ast.limit) {
    const values = ast.limit.value;
    if (values.length !== 1 || values[0].type !== 'number' || !Number.isSafeInteger(Number(values[0].value))) fail('LIMIT must use integer literals; OFFSET is not enabled yet');
    limit = Number(values[0].value);
    if (limit < 1 || limit > MAX_LIMIT) fail(`LIMIT cannot exceed ${MAX_LIMIT} and must be positive`);
  } else ast.limit = { seperator: '', value: [{ type: 'number', value: limit }] };
  const normalizedSql = parser.sqlify(ast, { database: 'MySQL' });
  return { sql: normalizedSql, params: structuredClone(params), tables: [...new Set(tables)], rowLimit: limit };
}
