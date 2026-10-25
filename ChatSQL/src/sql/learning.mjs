import sqlParser from 'node-sql-parser';
import { createHash } from 'node:crypto';
const parser = new sqlParser.Parser();
const VERSION = 'education-v2';
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
// Range scanner, NOT a SQL parser: only AST-confirmed top-level clauses become cards.
export function scanSql(sql) {
  const tokens = []; let index = 0, depth = 0;
  while (index < sql.length) {
    const start = index, char = sql[index];
    if (/\s/.test(char)) { index++; continue; }
    if (sql.startsWith('/*', index)) { const end = sql.indexOf('*/', index + 2); index = end < 0 ? sql.length : end + 2; continue; }
    if (char === '#' || sql.startsWith('--', index) && /\s|$/.test(sql[index + 2] || '')) { const end = sql.indexOf('\n', index); index = end < 0 ? sql.length : end; continue; }
    if (['`', "'", '"'].includes(char)) {
      const quote = char; index++;
      while (index < sql.length) {
        if (sql[index] === String.fromCharCode(92)) { index += 2; continue; }
        if (sql[index] === quote) { if (sql[index + 1] === quote) { index += 2; continue; } index++; break; }
        index++;
      }
      tokens.push({ text: sql.slice(start, index), type: quote === '`' ? 'identifier' : 'literal', start, end: index, depth }); continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      index++; while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index++;
      tokens.push({ text: sql.slice(start, index), upper: sql.slice(start, index).toUpperCase(), type: 'word', start, end: index, depth }); continue;
    }
    if (char === ')') depth--;
    tokens.push({ text: char, type: char === '?' ? 'parameter' : 'symbol', start, end: ++index, depth });
    if (char === '(') depth++;
  }
  return tokens;
}
const expression = node => { try { return parser.exprToSQL(node, { database: 'MySQL' }); } catch { return '此表达式'; } };
const functionName = node => typeof node.name === 'string' ? node.name : (node.name?.name || []).map(part => part.value).join('.');
const groups = ast => Array.isArray(ast.groupby) ? ast.groupby : ast.groupby?.columns || [];
const outputName = item => expression(item.expr) + (item.as ? ` AS ${item.as}` : '');
function fragment(sql, node) { return node.loc ? sql.slice(node.loc.start.offset, node.loc.end.offset).trim() : expression(node); }
function resultLimit(ast) {
  if (!ast.limit?.value?.length) return null;
  const values = ast.limit.value;
  return Number((values.length === 1 || ast.limit.seperator === 'offset' ? values[0] : values[1]).value);
}
export function buildEducation(plan) {
  const sql = typeof plan?.sql === 'string' ? plan.sql : '';
  const params = Array.isArray(plan?.params) ? plan.params : [];
  const fingerprint = createHash('sha256').update(JSON.stringify([sql, params])).digest('hex');
  const base = { version: VERSION, sql, params, fingerprint, status: 'supported', clauses: [], glossary: [], warnings: [] };
  const unsupported = message => ({ ...base, status: 'unsupported', message, overview: '当前 SQL 暂不能生成完整结构讲解。', writingOrder: [], logicalOrder: [], parameters: [] });
  if (!sql.trim() || sql.length > 20000) return unsupported('请先输入不超过 20000 字符的单条 SELECT。');
  let ast;
  try { ast = parser.astify(sql, { database: 'MySQL', parseOptions: { includeLocations: true } }); } catch { return unsupported('无法解析这条 MySQL SELECT，请检查语法；没有执行任何查询。'); }
  if (Array.isArray(ast)) { if (ast.length !== 1) return unsupported('一次只讲解一条 SELECT，不拼接多语句。'); ast = ast[0]; }
  if (ast?.type !== 'select') return unsupported('当前教育模式只支持 SELECT 结构，不会执行或讲解为可运行的写入语句。');
  let complex = false;
  walk(ast, node => { if (node !== ast && node.type === 'select' || node.with || node._next || node.set_op || node.window || node.over || node.type === 'select' && node.options?.length) complex = true; });
  if (complex || ast.locking_read || ast.into && Object.values(ast.into).some(Boolean)) return unsupported('当前尚不支持完整讲解 CTE、子查询、UNION、窗口、锁定读取或 SELECT INTO；不会输出貌似完整的简化教程。');
  const tokens = scanSql(sql), top = tokens.filter(token => token.depth === 0);
  const positions = [];
  const flags = { SELECT: true, FROM: !!ast.from?.length, WHERE: !!ast.where, 'GROUP BY': !!ast.groupby, HAVING: !!ast.having, 'ORDER BY': !!ast.orderby, LIMIT: !!ast.limit };
  for (let index = 0; index < top.length; index++) {
    const token = top[index]; if (token.type !== 'word') continue;
    const pair = token.upper + ' ' + (top[index + 1]?.upper || '');
    const name = pair === 'GROUP BY' || pair === 'ORDER BY' ? pair : token.upper;
    if (flags[name] && !positions.some(position => position.name === name)) positions.push({ name, start: token.start });
  }
  positions.sort((a, b) => a.start - b.start);
  if (Object.entries(flags).some(([name, exists]) => exists && !positions.some(position => position.name === name))) return unsupported('无法可靠定位某个实际子句；本版不为这种写法生成不完整教程。');
  const make = (name, title, what, why, details = [], pitfalls = [], comparison = null) => {
    const index = positions.findIndex(position => position.name === name); if (index < 0) return;
    const start = positions[index].start;
    let end = positions[index + 1]?.start ?? sql.length;
    while (end > start && /[\s;]/.test(sql[end - 1])) end--;
    base.clauses.push({ id: name.toLowerCase().replaceAll(' ', '-'), keyword: name, title, sql: sql.slice(start, end), range: { start, end }, what, why, details, pitfalls, comparison });
  };
  const outputItems = ast.columns || [];
  const outputList = outputItems.map(outputName).join('、');
  const sourceList = (ast.from || []).map(source => `${source.db ? source.db + '.' : ''}${source.table}${source.as ? '（别名 ' + source.as + '）' : ''}`).join('、');
  const fieldStar = outputItems.some(item => item.expr?.type === 'column_ref' && item.expr.column === '*');
  make('SELECT', 'SELECT：决定输出什么', `本次返回 ${outputItems.length} 个选择项：${outputList}。`, 'SELECT 声明结果需要展示的字段或计算表达式；用户需要的返回项应体现在这里，而不是自动返回表中所有数据。', [fieldStar ? '这里的 * 表示所有列，列数随表结构而变，不是 LIKE 的通配符。当前执行策略要求显式列清单，能讲解不代表允许运行。' : '字段/表达式之间用逗号分隔；字段名不是 SQL 关键词。显式列清单让数据范围更清楚。', ...outputItems.filter(item => item.as).map(item => `${item.as} 是 ${expression(item.expr)} 在本次结果里的别名；不重命名表或实际字段。`)], ['SELECT 不负责确定稳定的行顺序，顺序由 ORDER BY 指定。'], { title: '显式列与星号的区别', before: base.sql.slice(positions[0]?.start || 0, positions.find(position => position.name === 'FROM')?.start || sql.length).trim(), after: 'SELECT *（教学片段，不会执行）', note: '改成 * 会选择所有列，而不是只选择当前列清单。不能据此断言哪种写法一定更快。' });
  if (ast.distinct) {
    const token = top.find(token => token.upper === 'DISTINCT' && token.type === 'word');
    if (token) base.clauses.push({ id: 'distinct', keyword: 'DISTINCT', title: 'DISTINCT：对输出行去重', sql: sql.slice(token.start, token.end), range: { start: token.start, end: token.end }, what: `针对本次所有选择项的组合（${outputList}）去重。`, why: '希望只保留不同的输出组合，而不是保留每一条重复结果。', details: ['它是 SELECT 的修饰，不是独立取数据来源的子句；在逻辑上，对所选输出项形成的行进行去重。'], pitfalls: ['不是只对第一列去重，也不保证排序。'], comparison: { title: '去掉 DISTINCT 会怎样', before: 'SELECT DISTINCT …', after: 'SELECT …', note: '去掉后允许相同输出行重复出现；没有实际数据时不能断言重复多少行。' } });
  }
  make('FROM', 'FROM：确定数据来源', ast.from?.length ? `本次从 ${sourceList} 读取。` : '本次没有 FROM。', '先知道数据来自哪些表，才能解释字段引用；书写时 FROM 在 SELECT 后面，逻辑理解时来源先于选择输出。', (ast.from || []).map(source => source.join ? `${source.join}：${String(source.join).includes('LEFT') ? '保留左侧行，右侧无匹配时对应列为 NULL' : String(source.join).includes('RIGHT') ? '保留右侧行，左侧无匹配时对应列为 NULL' : String(source.join).includes('CROSS') ? '组合两侧记录，形成笛卡尔积' : '仅保留满足连接条件的匹配组合'}；${source.on ? 'ON ' + expression(source.on) + ' 决定匹配条件' : '未给出 ON 条件，需核对是否有意交叉读取'}。` : source.as ? `别名 ${source.as} 用来限定该来源的列；a.column 中的点号用于限定列的来源。` : '单个来源本身不代表结果已筛选或排序。'), ast.from?.length > 1 ? ['连接可使一条记录匹配多行，产生重复输出；没有外键证据时不能声称连接字段存在数据库强制关系。', '多来源且无连接条件时要注意笛卡尔积。'] : []);
  make('WHERE', 'WHERE：先筛选原始行', ast.where ? `本次筛选表达式：${expression(ast.where)}。` : '', 'WHERE 只保留条件为 TRUE 的原始行；它在逻辑上先于分组，适用于限制哪些明细记录参与后续计算。', ['比较、逻辑运算和参数共同组成条件；? 的实际值在参数讲解中按顺序列出。'], ['条件结果为 UNKNOWN（例如与 NULL 普通比较）不会被 WHERE 保留。'], { title: 'WHERE 与 HAVING', before: 'WHERE：对原始记录筛选', after: 'HAVING：对分组/聚合结果筛选', note: '两者不应在没有核对语义时直接互换；示意文字不是待执行 SQL。' });
  make('GROUP BY', 'GROUP BY：把记录按键分组', `实际分组键：${groups(ast).map(expression).join('、')}。`, '需要按这些键分别计算聚合，而不是对所有输入记录只计算一份总计。', ['同组记录参与各聚合表达式的计算；非聚合返回项应与分组键相容。'], ['分组不是排序，不能因为出现 GROUP BY 就依赖某个输出顺序。']);
  make('HAVING', 'HAVING：筛选分组或聚合结果', ast.having ? `本次组筛选：${expression(ast.having)}。` : '', '当条件要作用于分组结果或聚合值时，使用 HAVING，而不是把所有条件都放在 WHERE。', ['HAVING 在逻辑上位于分组之后；MySQL 还允许某些没有显式 GROUP BY 的聚合 HAVING 用法。'], ['WHERE 与 HAVING 针对的阶段不同，不能一概互换。']);
  make('ORDER BY', 'ORDER BY：明确返回顺序', `本次排序：${(ast.orderby || []).map(item => expression(item.expr) + ' ' + (item.type || 'ASC')).join('，')}。`, '只有明确排序，才能说明先返回哪些记录；与 LIMIT 配合时排序决定取哪一段结果。', ['ASC 表示升序，DESC 表示降序；多个键按书写先后依次比较。', 'MySQL 可以在 ORDER BY 中引用输出别名，但不能把这个规则推广到所有子句。'], ['相同排序键若没有唯一决胜条件，行之间仍可能不稳定。']);
  const limit = resultLimit(ast);
  make('LIMIT', 'LIMIT：限制本次返回规模', Number.isFinite(limit) ? `本次最多返回 ${limit} 行结果。` : '本次包含 LIMIT 表达式。', plan.semantic ? `这是已核对计划中的结果上限 ${plan.semantic.rowLimit}；可能来自用户要求或系统默认安全限制，不应伪称都是用户要求。` : '限制返回规模，避免一次取出过多结果；没有可靠意图信息时不能断言这个数字是用户要求还是系统默认。', ast.limit?.value?.length > 1 ? ['本句还包含偏移量，先跳过指定数量结果再返回限制范围。教学解释不等于当前执行策略支持 OFFSET。'] : ['它限制结果行数，不是给数据库中的表删掉多余记录。'], ['不等于表总数或总匹配数；只有实际执行后才知道返回了多少行。'], { title: '去掉 LIMIT 会怎样', before: Number.isFinite(limit) ? `LIMIT ${limit}` : 'LIMIT …', after: '不设置结果行数限制', note: '可能返回更多匹配行，也可能数量相同；没有执行数据不能给出确定数量。实际执行仍受服务端上限约束。' });
  if (plan.semantic) {
    const selectCard = base.clauses.find(clause => clause.id === 'select');
    if (selectCard) selectCard.details.push(...(plan.semantic.outputs || []).map(item => `原需求“${item.userTerm}”在当前计划中对应 ${item.column}${item.aggregate ? ' 的 ' + item.aggregate + ' 计算' : ''}；这是计划中的字段映射，仍需核对业务理解。`));
    const whereCard = base.clauses.find(clause => clause.id === 'where');
    if (whereCard) whereCard.details.push(...(plan.semantic.filters || []).map(item => `需求“${item.userTerm}”对应 ${item.column} ${item.operator} ${JSON.stringify(item.value)}；取值依据：${item.source}。字段值存在不等于业务映射一定正确。`));
  }
  base.clauses.sort((a, b) => a.range.start - b.range.start);
  const writingOrder = positions.map(position => position.name);
  if (ast.distinct) writingOrder.splice(1, 0, 'DISTINCT（SELECT 修饰）');
  base.writingOrder = writingOrder;
  base.logicalOrder = ['FROM', 'WHERE', 'GROUP BY', 'HAVING', 'SELECT', 'DISTINCT', 'ORDER BY', 'LIMIT'].filter(name => name === 'DISTINCT' ? !!ast.distinct : flags[name]);
  base.orderNote = '以上是便于理解的逻辑处理模型，不是数据库物理执行计划；优化器可能重排或合并步骤。没有 EXPLAIN 不能声称实际执行顺序或性能。';
  base.overview = plan.semantic?.intent || `这条 SELECT 从${sourceList || '表达式'}形成结果，输出 ${outputItems.length} 个选择项。这里只解释结构，不猜测未提供的业务目标。`;
  base.intentSource = plan.semantic ? '已绑定查询计划的业务意图；仍需核对模型理解' : 'AST 结构说明，不代表字段已获数据库验证';
  const glossary = [], seen = new Set();
  const add = (id, title, sqlText, text, details = [], comparison = null, range = null) => {
    const key = id + ':' + sqlText + ':' + (range?.start ?? ''); if (seen.has(key)) return; seen.add(key);
    glossary.push({ id, title, sql: sqlText, text, details, comparison, range });
  };
  const parameterTokens = tokens.filter(token => token.type === 'parameter');
  const parameterIndex = node => {
    const range = node.loc;
    if (!range) return -1;
    // Called only when the LIKE right operand is a single '?': it is the LAST
    // parameter in that binary expression, not a possible parameter in its left function.
    let found = -1;
    parameterTokens.forEach((token, index) => { if (token.start >= range.start.offset && token.end <= range.end.offset) found = index; });
    return found;
  };
  base.parameters = parameterTokens.map((token, index) => ({ position: index + 1, provided: index < params.length, value: index < params.length ? params[index] : null, range: { start: token.start, end: token.end } }));
  if (parameterTokens.length) add('parameters', '?：参数占位符', '?', '问号在 SQL 中保留一个值的位置，驱动按出现顺序绑定参数，不是拿问号字符去匹配数据。', ['绑定参数与 SQL 语法分别传递，避免把数据拼成可执行指令；标识符不能用 ? 代替。', ...base.parameters.map(item => `第 ${item.position} 个 ?：${item.provided ? JSON.stringify(item.value) : '未提供，不能据此运行'}。`)]);
  if (parameterTokens.length !== params.length) base.warnings.push(`SQL 有 ${parameterTokens.length} 个参数位置，提供 ${params.length} 个值；当前参数不完整或多余，讲解不会替你执行。`);
  let hasAggregate = false;
  walk(ast, node => {
    if (node.type === 'aggr_func' || node.type === 'function') {
      const name = functionName(node).toUpperCase(), call = fragment(sql, node);
      const range = node.loc ? { start: node.loc.start.offset, end: node.loc.end.offset } : null;
      hasAggregate ||= node.type === 'aggr_func';
      if (name === 'COUNT') {
        const args = node.args?.expr; const star = args?.type === 'star' || args?.value === '*' || args?.column === '*';
        add('function-count', node.args?.distinct ? 'COUNT(DISTINCT …)：不同非空值/组合的数量' : star ? 'COUNT(*)：统计行数' : 'COUNT(列)：统计非空值', call, node.args?.distinct ? '对指定非 NULL 值/组合去重后计数；多参数时含 NULL 的组合不计入。' : star ? '这里的 * 表示统计符合条件的行，不是选择所有列，也不是 LIKE 通配符。' : '只统计该表达式不为 NULL 的记录，可能与行数不同。', ['COUNT 对无分组的空输入返回 0；显式分组没有组时不会凭空生成每组的记录。'], { title: '统计行与统计非空值', before: 'COUNT(*)', after: 'COUNT(列名)', note: '前者统计行，后者忽略该列 NULL；不假定当前数据一定存在 NULL。' }, range);
      } else if (['SUM', 'AVG', 'MIN', 'MAX'].includes(name)) {
        const meaning = { SUM: '求和', AVG: '平均值', MIN: '最小值', MAX: '最大值' }[name];
        add('function-' + name.toLowerCase(), `${name}：${meaning}`, call, `对每个输入组求${meaning}，没有显式分组时通常把符合条件的输入作为一个整体。`, ['这些常见聚合忽略 NULL；无有效输入时通常返回 NULL，不应直接当成 0。', 'MIN/MAX 也可比较文本或日期，比较行为与类型/排序规则有关。'], null, range);
      } else {
        const known = { LOWER: ['转为小写', '用于需要小写形式的输出或比较；不保证比较本身大小写敏感。'], UPPER: ['转为大写', '转换大小写形式，不会修改表内原值。'], LENGTH: ['计算字节长度', '字节数不一定等于字符数，中文等字符可能占多个字节。'], COALESCE: ['选取第一个非 NULL 参数', '可为缺失值提供回退；空字符串与 0 不等于 NULL。'], ROUND: ['按指定位数舍入', '用于数值展示或计算；舍入后的值可能改变比较结果。'], ABS: ['取绝对值', '去掉数值符号，不等于把原始数据改写。'], YEAR: ['取年份', '从日期/时间值中提取年份。'], MONTH: ['取月份', '从日期/时间值中提取月份部分。'], DAY: ['取月内日号', '不是一年中的第几天。'], DATEDIFF: ['计算两个日期的天数差', '按第一个日期减第二个日期计算，时间部分不参与天数比较。'] };
        add('function-' + name.toLowerCase(), known[name] ? `${name}：${known[name][0]}` : `函数调用：${name}`, call, known[name]?.[1] || '识别到函数调用，但当前版本没有该函数的内置准确解释；不推测其作用。', ['括号内是参数或表达式；识别函数不代表执行策略允许使用它。'], null, range);
      }
    }
    if (node.type === 'unary_expr' && String(node.operator).toUpperCase() === 'NOT') add('not', 'NOT：对条件取反', fragment(sql, node), '对条件作逻辑否定；遇到 UNKNOWN 时不能简单当作 TRUE。', ['括号有助于明确 NOT 作用于哪一段条件。']);
    if (node.type === 'binary_expr') {
      const operator = String(node.operator).toUpperCase();
      const comparisons = { '=': '比较两个值是否相等', '!=': '比较两个值是否不等', '<>': '比较两个值是否不等', '>': '左值大于右值', '>=': '左值大于或等于右值', '<': '左值小于右值', '<=': '左值小于或等于右值', IN: '检查值是否在给定列表中', 'NOT IN': '检查值是否不在给定列表中', BETWEEN: '检查值是否处于包含两端的区间内', 'NOT BETWEEN': '检查值是否不在包含两端的区间内' };
      if (comparisons[operator] && node.left?.type !== 'null' && node.right?.type !== 'null') add('operator-' + operator, `${operator}：比较条件`, fragment(sql, node), comparisons[operator] + '；它决定条件的真假，不是给字段赋值。', ['比较受数据类型和排序规则影响；NULL 可能使条件产生 UNKNOWN。']);
      if (['*', '+', '-', '/', '%'].includes(operator)) add('arithmetic-' + operator, `${operator}：算术运算`, fragment(sql, node), operator === '*' ? '这里的 * 处在二元表达式中，表示乘法，不是所有列、计数或 LIKE 通配符。' : operator === '%' ? '这里是取模运算，不是 LIKE 模式中的任意长度匹配。' : '这里对表达式做算术计算，不会直接修改原表值。');
      if (['LIKE', 'NOT LIKE'].includes(operator)) {
        let pattern = node.right?.value;
        if (node.right?.type === 'origin' && pattern === '?') { const index = parameterIndex(node); pattern = index >= 0 ? params[index] : undefined; }
        add('like', `${operator}：按模式匹配`, fragment(sql, node), '用于模式匹配，不是普通相等比较。% 匹配零个或多个字符，_ 匹配一个字符；转义与排序规则会影响匹配。', [pattern !== undefined ? `本次模式值：${JSON.stringify(pattern)}。只有在模式上下文中才把 %/_ 当作通配符。` : '本次模式是表达式或未提供的参数，不能虚构它的实际值。', '普通字符串里的 %/_ 和取模运算不能一律按 LIKE 通配符解释。'], { title: '模糊与精确比较', before: '字段 LIKE 模式', after: '字段 = 值', note: 'LIKE 按模式匹配；等号按值比较。两者都受数据类型和排序规则影响，不保证大小写敏感。' }, node.loc ? { start: node.loc.start.offset, end: node.loc.end.offset } : null);
      }
      if (['AND', 'OR'].includes(operator)) add('boolean-' + operator, operator === 'AND' ? 'AND：同时满足' : 'OR：满足任一条件', operator, operator === 'AND' ? '连接需要同时为真的条件。' : '连接满足任一分支即可保留的条件。', ['通常 NOT 的优先级高于 AND，AND 高于 OR；括号可明确改变组合方式。', '涉及 NULL 时还可能产生 UNKNOWN，不应只套用两值逻辑。']);
      if (node.left?.type === 'null' || node.right?.type === 'null') add('null', 'NULL：未知或缺失值', fragment(sql, node), ['IS', 'IS NOT'].includes(operator) ? '这里用 IS NULL / IS NOT NULL 检查空值。NULL 不等于空字符串或 0。' : '这里对 NULL 做普通比较会得到 UNKNOWN，不能替代 IS NULL / IS NOT NULL。', ['WHERE 只保留 TRUE，不保留 UNKNOWN。']);
    }
  });
  if (fieldStar) add('select-star', 'SELECT *：选择所有列', '*', '当前 * 出现在返回列位置，表示所有列；不是 COUNT(*) 的计数含义，也不是 LIKE 的通配符。', ['讲解支持这一语法，不代表当前只读执行策略允许通配列。']);
  if (outputItems.some(item => item.as) || ast.from?.some(source => source.as)) add('alias', 'AS / 别名：给本次引用或结果命名', tokens.some(token => token.type === 'word' && token.upper === 'AS') ? 'AS' : '本句采用省略 AS 的别名写法', '别名只在当前语句/结果中起作用，不会修改数据库表名或列名。', ['输出别名可在 MySQL 的 ORDER BY 等位置使用，不要误认为所有 WHERE 都能引用输出别名。']);
  if (tokens.some(token => token.text === ',')) add('comma', '逗号：分隔同一列表中的项目', ',', '分隔返回项、分组/排序键、函数参数或列表值；不是 AND 条件。', ['具体含义取决于 AST 所在列表；FROM 中逗号多表可能形成交叉组合。']);
  if (tokens.some(token => token.text === '(')) add('parentheses', '括号：表达式分组或函数参数', '( … )', '函数参数、列表或条件分组使用括号；条件中的括号可以改变 AND/OR 的组合次序。');
  if (tokens.some(token => token.type === 'identifier')) add('backticks', '反引号：引用标识符', '`…`', '反引号包围表名/字段名，区别于表示字符串值的引号；它不是条件运算符。');
  if (tokens.some((token, index) => token.text === '.' && ['word', 'identifier'].includes(tokens[index - 1]?.type) && ['word', 'identifier'].includes(tokens[index + 1]?.type))) add('qualification', '点号：限定名称所属范围', '.', '例如表别名.列名用于限定列来源，数据库名.表名用于限定表所在库；不是小数点时才作此解释。');
  if (tokens.some(token => token.text === ';')) add('terminator', '分号：结束一条语句', ';', '标记语句结束，不负责筛选、排序或分组；当前运行入口仍只允许单条查询。');
  base.glossary = glossary;
  if (!ast.orderby) base.warnings.push('没有 ORDER BY，不能保证每次结果的顺序稳定；LIMIT 也不能替代排序。');
  if (ast.limit) base.warnings.push('返回上限不等于表总记录数或总匹配数，未执行时不能声称已找到多少条。');
  if (hasAggregate && ast.limit) base.warnings.push('聚合查询中的 LIMIT 限制聚合后的结果行数，不代表只统计或扫描这么多条原始记录。');
  base.warnings.push('本讲解不执行 SQL，不验证表内记录，不替代数据库授权、安全校验或实际执行计划。');
  return base;
}
// Compatibility only: new UI must prefer the full education document, not this flattened view.
export function explainQuery(plan) {
  const education = buildEducation(plan);
  if (education.status !== 'supported') return [{ title: '讲解范围', text: education.message }];
  return education.clauses.map(clause => ({ title: clause.title, text: clause.sql + '：' + clause.what + ' ' + clause.why }));
}
