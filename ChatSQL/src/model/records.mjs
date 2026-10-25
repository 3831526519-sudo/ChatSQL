import sqlParser from 'node-sql-parser';
const parser = new sqlParser.Parser();
const sensitive = /pass(word|wd)?|secret|token|api.?key|credential|身份证|密码|密钥/i;
// Evidence is only from confirmed reads of a direct column of one table.
// Expressions (e.g. UPPER(code) AS code) are not stored as original field values.
export class RecordContext {
  #entries = new Map();
  constructor(now = Date.now) { this.now = now; }
  remember(connectionId, result) {
    if (result.tables.length !== 1) return;
    let ast;
    try { ast = parser.astify(result.sql); } catch { return; }
    if (Array.isArray(ast) || ast.from?.length !== 1) return;
    const fields = ast.columns.filter(item => item.expr?.type === 'column_ref' && item.expr.column !== '*' && !sensitive.test(item.expr.column) && !sensitive.test(item.as || item.expr.column)).map(item => ({ name: item.expr.column, label: item.as || item.expr.column })).filter(item => result.columns.includes(item.label)).slice(0, 20);
    if (!fields.length) return;
    const rows = [], truncated = new Set();
    let size = 0;
    for (const row of result.rows.slice(0, 100)) {
      const safe = Object.fromEntries(fields.map(({ name, label }) => {
        const value = row[label];
        if (typeof value === 'string' && value.length > 256) truncated.add(name);
        if (typeof value === 'string') return [name, value.slice(0, 256)];
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [name, value];
        truncated.add(name); return [name, '[复杂值已省略]'];
      }));
      size += JSON.stringify(safe).length;
      if (size > 12000) break;
      rows.push(safe);
    }
    const entry = { tables: [...result.tables], columns: [...new Set(fields.map(field => field.name))], rows, sql: parser.sqlify(ast), sampled: true, truncatedColumns: [...truncated], expiresAt: this.now() + 900000 };
    const list = (this.#entries.get(connectionId) || []).filter(item => item.expiresAt > this.now() && item.sql !== entry.sql);
    list.push(entry);
    this.#entries.set(connectionId, list.slice(-4));
  }
  get(connectionId, schema) {
    return structuredClone((this.#entries.get(connectionId) || []).filter(entry => entry.expiresAt > this.now() && entry.tables.every(table => schema.some(metadata => metadata.name === table && entry.columns.every(name => metadata.columns.some(column => column.name === name))))).map(({ expiresAt, ...entry }) => entry));
  }
  remove(connectionId) { this.#entries.delete(connectionId); }
}
