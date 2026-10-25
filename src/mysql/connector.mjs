import { createPool } from 'mysql2/promise';
import { prepareReadQuery } from '../sql/policy.mjs';

const IDENTIFIER_LIMIT = 64;

function jsonSafe(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

export function validateMysqlConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Connection settings must be an object');
  }
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  const database = typeof input.database === 'string' ? input.database.trim() : '';
  const port = Number(input.port ?? 3306);
  const password = typeof input.password === 'string' ? input.password : '';
  const allowedTables = Array.isArray(input.allowedTables)
    ? [...new Set(input.allowedTables.filter((name) => typeof name === 'string').map((name) => name.trim()).filter(Boolean))]
    : [];

  if (!host || host.length > 255 || /[\r\n\0]/.test(host)) throw new TypeError('A valid MySQL host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('MySQL port must be between 1 and 65535');
  if (!user || user.length > 128 || /[\r\n\0]/.test(user)) throw new TypeError('A valid MySQL username is required');
  if (!database || database.length > IDENTIFIER_LIMIT || /[\r\n\0]/.test(database)) throw new TypeError('A default database is required');
  if (password.length > 4096 || /\0/.test(password)) throw new TypeError('Invalid password value');
  if (allowedTables.length > 256 || allowedTables.some((name) => name.length > IDENTIFIER_LIMIT || /[\r\n\0]/.test(name))) {
    throw new TypeError('Invalid allowed table list');
  }

  const wholeDatabase = input.wholeDatabase === true;
  const shareRecords = input.shareRecords === true;
  if ((wholeDatabase || shareRecords) && input.riskAccepted !== true) throw new TypeError('请先确认数据库访问与数据发送风险');
  return { host, port, user, password, database, allowedTables, wholeDatabase, shareRecords, riskAccepted: input.riskAccepted === true };
}

export function createMysqlConnector(input) {
  const config = validateMysqlConfig(input);
  const pool = createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectTimeout: 10_000,
    waitForConnections: true,
    connectionLimit: 2,
    queueLimit: 4,
    enableKeepAlive: true,
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  return {
    async test() {
      const connection = await pool.getConnection();
      try {
        const [rows] = await connection.query('SELECT 1 AS ok, DATABASE() AS databaseName, VERSION() AS serverVersion');
        return rows[0];
      } finally {
        connection.release();
      }
    },

    async getAuthorizedSchema() {
      if (!config.wholeDatabase && config.allowedTables.length === 0) return [];
      const placeholders = config.allowedTables.map(() => '?').join(', ');
      const [rows] = await pool.execute(
        `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_KEY AS columnKey, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra, COLUMN_COMMENT AS columnComment\n` +
        `FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ${config.wholeDatabase ? '' : `AND TABLE_NAME IN (${placeholders})`}\n` +
        'ORDER BY TABLE_NAME, ORDINAL_POSITION',
        config.wholeDatabase ? [config.database] : [config.database, ...config.allowedTables],
      );
      const tables = new Map();
      for (const row of rows) {
        if (!tables.has(row.tableName)) tables.set(row.tableName, { name: row.tableName, columns: [] });
        tables.get(row.tableName).columns.push({
          name: row.columnName,
          type: row.columnType,
          nullable: row.isNullable === 'YES',
          key: row.columnKey || null,
          defaultValue: row.columnDefault,
          extra: row.extra || null,
          comment: row.columnComment || '',
        });
      }
      return [...tables.values()];
    },

    async queryReadOnly(sql, params = []) {
      const schema = await this.getAuthorizedSchema();
      const plan = prepareReadQuery({ sql, params, database: config.database, allowedTables: schema.map(table => table.name), schema });
      const connection = await pool.getConnection();
      let rows, fields;
      let reusable = true;
      try {
        await connection.query('SET SESSION MAX_EXECUTION_TIME = 15000');
        await connection.query('START TRANSACTION READ ONLY');
        [rows, fields] = await connection.execute(plan.sql, plan.params);
      } finally {
        try { await connection.rollback(); } catch { reusable = false; connection.destroy(); }
        if (reusable) connection.release();
      }
      const resultRows = Array.isArray(rows) ? rows : [];
      return {
        sql: plan.sql,
        params: plan.params,
        tables: plan.tables,
        rowLimit: plan.rowLimit,
        columns: Array.isArray(fields) ? fields.map((field) => field.name) : [],
        rowCount: resultRows.length,
        limitReached: resultRows.length >= plan.rowLimit,
        rows: resultRows.map(jsonSafe),
      };
    },

    async close() {
      await pool.end();
    },
  };
}
