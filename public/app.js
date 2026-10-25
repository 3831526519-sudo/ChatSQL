const form = document.querySelector('#connection-form');
const saveButton = document.querySelector('#save-button');
const formStatus = document.querySelector('#form-status');
const connectionList = document.querySelector('#connections');
const schemaPanel = document.querySelector('#schema-panel');
const schemaTitle = document.querySelector('#schema-title');
const schemaContent = document.querySelector('#schema-content');
const readiness = { database: false, model: false };
let viewsInitialized = false;
let runtimeCompatible = false;
let runtimeChecked = false;
async function verifyRuntime() {
  try {
    const health = await request('/api/health');
    runtimeCompatible = health.apiVersion === 'intent-plan-v1' && health.capabilities?.intentPlan === true;
  } catch { runtimeCompatible = false; }
  runtimeChecked = true;
  updateEntry();
}

function updateEntry() {
  const ready = runtimeCompatible && readiness.database && readiness.model;
  document.querySelector('#enter-workspace').disabled = !ready;
  document.querySelector('#database-ready').textContent = readiness.database ? '数据库：已连接并授权表' : '数据库：待连接或授权表';
  document.querySelector('#model-ready').textContent = readiness.model ? '模型：已配置' : '模型：待配置';
  document.querySelector('#entry-status').textContent = !runtimeChecked ? '正在核验后端版本…' : !runtimeCompatible ? '后端仍是旧版本或服务不可用，结构化查询计划尚未生效。请在原终端按 Ctrl+C 后重新运行 npm.cmd start，再刷新页面。重启会清空内存配置。' : ready ? '配置已就绪，点击进入工作台。' : '请先完成数据库连接和模型 API 配置。';
  if (viewsInitialized && !ready && !document.querySelector('#workspace-view').hidden) {
    history.replaceState(null, '', '#settings');
    showView(false);
  }
}
function showView(workspace) {
  const wasWorkspace = !document.querySelector('#workspace-view').hidden;
  document.querySelector('#settings-view').hidden = workspace;
  document.querySelector('#workspace-view').hidden = !workspace;
  document.title = workspace ? 'ChatSQL · 查询与学习' : 'ChatSQL · 配置';
  document.body.classList.toggle('workspace-open', workspace);
  if (workspace && !wasWorkspace) refreshWorkspaceTables();
  if (wasWorkspace && !workspace) invalidatePreview();
  document.getElementById(workspace ? 'workspace-heading' : 'settings-heading').focus();
}
function applyViewRoute() {
  if (!viewsInitialized) return;
  const workspace = location.hash === '#workspace';
  if (workspace && !(runtimeCompatible && readiness.database && readiness.model)) {
    history.replaceState(null, '', '#settings');
    showView(false);
    return;
  }
  showView(workspace);
}

async function request(url, options) {
  if (options?.method && options.method !== 'GET' && !runtimeCompatible) throw new Error('当前后端未加载查询计划版本，请重启服务后再操作');
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function loadConnections() {
  connectionList.replaceChildren(element('p', 'muted', '正在读取连接…'));
  try {
    const data = await request('/api/mysql/connections');
    readiness.database = data.connections.some(connection => connection.wholeDatabase || connection.allowedTables.length > 0);
    updateEntry();
    const select = document.querySelector('#query-connection');
    const selected = select.value;
    select.replaceChildren(...data.connections.map(connection => {
      const option = element('option', '', `${connection.database} · ${connection.user}@${connection.host}`);
      option.value = connection.id;
      option.dataset.shareRecords = String(connection.shareRecords === true);
      return option;
    }));
    if (data.connections.some(connection => connection.id === selected)) select.value = selected;
    if (select.value !== selected) {
      invalidatePreview();
      document.querySelector('#share-schema').checked = select.selectedOptions[0]?.dataset.shareRecords === 'true';
    }
    if (!data.connections.length) {
      connectionList.replaceChildren(element('div', 'empty', '还没有数据源。添加连接后，可在这里检查授权表结构。'));
      return;
    }
    const cards = data.connections.map((connection) => {
      const card = element('article', 'connection-card');
      const details = element('div');
      const title = element('div', 'conn-title', `${connection.user} @ ${connection.host}:${connection.port}`);
      const meta = element('div', 'conn-meta', `数据库：${connection.database} · 授权表：${connection.wholeDatabase ? '指定库全部表' : connection.allowedTables.join(', ') || '无'} · 密码：${connection.hasPassword ? '已设置（不显示）' : '空'}`);
      details.append(title, meta);
      const actions = element('div', 'conn-actions');
      const schemaButton = element('button', 'button-secondary', '查看 Schema');
      schemaButton.type = 'button';
      schemaButton.addEventListener('click', () => showSchema(connection));
      const deleteButton = element('button', 'button-secondary', '移除连接');
      deleteButton.type = 'button';
      deleteButton.addEventListener('click', () => removeConnection(connection));
      actions.append(schemaButton, deleteButton);
      card.append(details, actions);
      return card;
    });
    connectionList.replaceChildren(...cards);
  } catch (error) {
    readiness.database = false;
    updateEntry();
    connectionList.replaceChildren(element('p', 'status-error', `读取连接失败：${error.message}`));
  }
}

async function showSchema(connection) {
  schemaPanel.hidden = false;
  schemaTitle.textContent = `Schema · ${connection.database}`;
  schemaContent.replaceChildren(element('p', 'muted', '正在读取授权表结构…'));
  schemaPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const data = await request(`/api/mysql/connections/${encodeURIComponent(connection.id)}/schema`);
    if (!data.tables.length) {
      schemaContent.replaceChildren(element('p', 'muted', '没有匹配的授权表。请检查数据库名和表白名单。'));
      return;
    }
    const sections = data.tables.map((table) => {
      const section = element('section', 'schema-table');
      section.append(element('h3', '', table.name));
      const tableElement = document.createElement('table');
      const thead = document.createElement('thead');
      const header = document.createElement('tr');
      for (const label of ['列名', '类型', '可空', '键', '注释']) header.append(element('th', '', label));
      thead.append(header);
      const tbody = document.createElement('tbody');
      for (const column of table.columns) {
        const row = document.createElement('tr');
        row.append(
          element('td', '', column.name),
          element('td', '', column.type),
          element('td', '', column.nullable ? '是' : '否'),
          element('td', column.key ? 'key' : '', column.key || '—'),
          element('td', '', column.comment || '—'),
        );
        tbody.append(row);
      }
      tableElement.append(thead, tbody);
      section.append(tableElement);
      return section;
    });
    schemaContent.replaceChildren(...sections);
  } catch (error) {
    schemaContent.replaceChildren(element('p', 'status-error', `读取 Schema 失败：${error.message}`));
  }
}

async function removeConnection(connection) {
  if (!window.confirm(`从本次运行中移除 ${connection.database} 的连接？不会删除 MySQL 数据。`)) return;
  try {
    await request(`/api/mysql/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
    await loadConnections();
    schemaPanel.hidden = true;
  } catch (error) {
    window.alert(`移除失败：${error.message}`);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  formStatus.className = '';
  formStatus.textContent = '正在测试连接…';
  const fields = new FormData(form);
  const config = {
    host: String(fields.get('host')).trim(),
    port: Number(fields.get('port')),
    user: String(fields.get('user')).trim(),
    password: String(fields.get('password')),
    database: String(fields.get('database')).trim(),
    allowedTables: String(fields.get('allowedTables') || '').split(',').map((name) => name.trim()).filter(Boolean),
    wholeDatabase: fields.get('wholeDatabase') === 'on',
    shareRecords: fields.get('shareRecords') === 'on',
    riskAccepted: fields.get('riskAccepted') === 'on',
  };
  try {
    const result = await request('/api/mysql/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    formStatus.className = 'status-ok';
    formStatus.textContent = `连接成功，已添加 ${result.connection.database}（MySQL ${result.serverVersion}）。`;
    form.elements.password.value = '';
    form.elements.user.value = '';
    await loadConnections();
  } catch (error) {
    formStatus.className = 'status-error';
    formStatus.textContent = `未添加连接：${error.message}`;
  } finally {
    config.password = '';
    form.elements.password.value = '';
    saveButton.disabled = false;
  }
});

const queryForm = document.querySelector('#query-form');
const previewPanel = document.querySelector('#query-preview');
const queryStatus = document.querySelector('#work-status');
const queryResults = document.querySelector('#query-results');
const confirmButton = document.querySelector('#confirm-query');
let pending = null;
let revision = 0;
let lastGenerated = null;
let schemaRevision = 0;
let running = false;
let inspectionQuestion = null;
let lastEducation = null;
let activeEducation = null;
let educationRequest = 0;
function updateAuthorizationForm() {
  const whole = document.querySelector('#whole-database').checked;
  form.elements.allowedTables.disabled = whole;
  form.elements.allowedTables.required = !whole;
  document.querySelector('#risk-accepted').required = whole || document.querySelector('#share-records').checked;
}
document.querySelector('#whole-database').addEventListener('change', updateAuthorizationForm);
document.querySelector('#share-records').addEventListener('change', updateAuthorizationForm);
updateAuthorizationForm();

function closeConfirmation() {
  if (previewPanel.open && typeof previewPanel.close === 'function') previewPanel.close();
  previewPanel.removeAttribute('open');
}
function renderBindings() {
  const sql = document.querySelector('#query-sql').value;
  let quote = null, placeholders = 0;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (quote) {
      if (char === String.fromCharCode(92)) { index++; continue; }
      if (char === quote) { if (sql[index + 1] === quote) index++; else quote = null; }
    } else if (['\"', "'", '`'].includes(char)) quote = char;
    else if (char === '?') placeholders++;
  }
  const summary = document.querySelector('#parameter-summary');
  try {
    const params = JSON.parse(document.querySelector('#query-params').value);
    if (!Array.isArray(params)) throw new Error();
    summary.className = placeholders === params.length ? '' : 'status-error';
    summary.textContent = placeholders !== params.length ? `参数不完整：SQL 中有 ${placeholders} 个占位符，当前提供 ${params.length} 个参数；不会通过运行校验。` : params.length ? params.map((value, index) => `第 ${index + 1} 个 ? 绑定为 ${JSON.stringify(value)}`).join('；') : '这条 SQL 没有需要绑定的参数。';
  } catch {
    summary.className = 'status-error';
    summary.textContent = '参数必须是有效的 JSON 数组，当前内容不能用于运行。';
  }
}
function updateLineNumbers() {
  renderBindings();
  const editor = document.querySelector('#query-sql');
  document.querySelector('#line-numbers').textContent = Array.from({ length: editor.value.split('\n').length }, (_, index) => index + 1).join('\n');
}
function setLearningVisibility() {
  const enabled = document.querySelector('#learning').checked;
  document.querySelector('#learning-panel').hidden = !enabled;
  document.querySelector('#studio-layout').classList.toggle('with-learning', enabled);
  return enabled;
}
function renderLessons(_legacySegments = [], message = '生成或输入 SQL 后，更新本句讲解以逐段理解结构。') {
  activeEducation = null;
  const container = document.querySelector('#learning-content'); container.replaceChildren();
  if (!setLearningVisibility()) return;
  if (window.ChatSqlEducation) window.ChatSqlEducation.render(container, null, { message });
  else container.append(element('p', 'education-warning', '新版教育组件尚未加载，请重启本机后端后刷新页面。'));
}
function educationMatchesEditor(education) {
  try { return education?.sql === document.querySelector('#query-sql').value && JSON.stringify(education.params) === JSON.stringify(JSON.parse(document.querySelector('#query-params').value)); }
  catch { return false; }
}
function showEducation(education) {
  if (!educationMatchesEditor(education)) return;
  lastEducation = education;
  if (!setLearningVisibility()) { activeEducation = null; document.querySelector('#learning-content').replaceChildren(); return; }
  if (!window.ChatSqlEducation || education.version !== 'education-v2') { renderLessons([], '当前服务尚未提供新版结构讲解，请重启后端并刷新。'); return; }
  activeEducation = education;
  window.ChatSqlEducation.render(document.querySelector('#learning-content'), education, { locate: locateEducationRange });
  syncLessonCursor();
}
async function updateEducation() {
  if (!document.querySelector('#learning').checked || document.querySelector('#workspace-view').hidden) return;
  if (lastEducation && educationMatchesEditor(lastEducation)) { showEducation(lastEducation); return; }
  const sql = document.querySelector('#query-sql').value;
  if (!sql.trim()) { renderLessons([], '先生成或输入 SQL，再查看本句讲解。'); return; }
  const current = ++educationRequest;
  renderLessons([], '正在分析本句结构，不执行查询，也不调用模型…');
  try {
    const params = JSON.parse(document.querySelector('#query-params').value);
    if (!Array.isArray(params)) throw new Error('绑定参数必须是 JSON 数组');
    const response = await request('/api/learning/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, params, queryId: pending && matchesEditor(pending) ? pending.queryId : undefined }) });
    if (response.education?.version !== 'education-v2') throw new Error('后端没有返回新版结构讲解');
    if (current !== educationRequest || !educationMatchesEditor(response.education)) return;
    showEducation(response.education);
  } catch (error) {
    if (current === educationRequest && document.querySelector('#learning').checked) renderLessons([], `讲解未完成：${error.message}。若提示接口不存在，请重启新版后端；没有执行查询。`);
  }
}
function locateEducationRange(range) {
  if (!activeEducation || !educationMatchesEditor(activeEducation) || !Number.isInteger(range?.start) || !Number.isInteger(range?.end) || range.start < 0 || range.end > activeEducation.sql.length || range.start >= range.end) return;
  const editor = document.querySelector('#query-sql');
  editor.focus(); editor.setSelectionRange(range.start, range.end);
  editor.scrollTop = Math.max(0, editor.value.slice(0, range.start).split('\n').length - 2) * 26;
  const lineStart = editor.value.lastIndexOf('\n', range.start - 1) + 1;
  editor.scrollLeft = Math.max(0, (range.start - lineStart) * 8 - editor.clientWidth / 3);
  syncLessonCursor();
}
function syncLessonCursor() {
  if (!activeEducation || !educationMatchesEditor(activeEducation) || !document.querySelector('#learning').checked) return;
  const editor = document.querySelector('#query-sql');
  const position = Math.min(editor.selectionStart, Math.max(0, editor.value.length - 1));
  const clause = [...activeEducation.clauses].filter(item => item.range.start <= position && position < item.range.end).sort((a, b) => (a.range.end - a.range.start) - (b.range.end - b.range.start))[0];
  window.ChatSqlEducation?.highlight(document.querySelector('#learning-content'), clause?.id);
}
for (const event of ['click', 'keyup', 'select']) document.querySelector('#query-sql').addEventListener(event, syncLessonCursor);
document.querySelector('#refresh-education').addEventListener('click', updateEducation);
function selectResultTab(tab) {
  const isResult = tab.id === 'result-tab';
  for (const button of document.querySelectorAll('#result-tabs [role="tab"]')) {
    button.setAttribute('aria-selected', String(button === tab));
    button.tabIndex = button === tab ? 0 : -1;
  }
  queryResults.hidden = !isResult;
  document.querySelector('#table-content').hidden = isResult;
}
async function refreshWorkspaceTables() {
  const version = ++schemaRevision;
  const id = document.querySelector('#query-connection').value;
  const tabs = document.querySelector('#result-tabs');
  for (const tab of tabs.querySelectorAll('[data-table]')) tab.remove();
  selectResultTab(document.querySelector('#result-tab'));
  if (!id) return;
  try {
    const data = await request(`/api/mysql/connections/${encodeURIComponent(id)}/schema`);
    if (version !== schemaRevision) return;
    for (const [index, table] of data.tables.entries()) {
      const tab = element('button', '', table.name);
      tab.type = 'button'; tab.id = `table-tab-${index}`; tab.dataset.table = table.name;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', 'false'); tab.setAttribute('aria-controls', 'table-content'); tab.tabIndex = -1;
      tab.addEventListener('click', () => {
        selectResultTab(tab);
        const panel = document.querySelector('#table-content');
        panel.setAttribute('aria-labelledby', tab.id);
        const grid = element('table');
        const head = element('tr');
        for (const label of ['字段', '类型', '可为空', '键']) head.append(element('th', '', label));
        const thead = element('thead'); thead.append(head);
        const tbody = element('tbody');
        for (const column of table.columns) {
          const row = element('tr');
          for (const value of [column.name, column.type, column.nullable ? '是' : '否', column.key || '—']) row.append(element('td', '', value));
          tbody.append(row);
        }
        grid.append(thead, tbody);
        const load = element('button', 'button-secondary', '将表查询载入编辑器');
        load.type = 'button';
        load.addEventListener('click', () => {
          invalidatePreview();
          const quote = name => '`' + name.replaceAll('`', '``') + '`';
          document.querySelector('#query-sql').value = `SELECT ${table.columns.map(column => quote(column.name)).join(', ')}\nFROM ${quote(table.name)}`;
          document.querySelector('#query-params').value = '[]';
          updateLineNumbers();
          renderLessons([], '已载入表查询，运行前会校验并生成讲解。');
          document.querySelector('#editor-state').textContent = `已载入 ${table.name}，尚未执行`;
          queryStatus.textContent = '表查询已载入。点击“运行 SQL”并确认后才会读取记录。';
          document.querySelector('#query-sql').focus();
        });
        panel.replaceChildren(element('h3', '', `${table.name} · 表结构`), element('p', 'muted', '这里只读取授权字段信息，不会自动查询表中的记录。'), load, grid);
      });
      tabs.append(tab);
    }
  } catch (error) { if (version === schemaRevision) queryStatus.textContent = `读取授权表失败：${error.message}`; }
}

function invalidatePreview() {
  revision++;
  educationRequest++;
  lastEducation = null;
  renderLessons([], '当前内容或查询上下文已变化，旧讲解已失效。可点击“更新本句讲解”。');
  document.querySelector('#plan-summary').hidden = true;
  if (pending) request('/api/mysql/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queryId: pending.queryId }) }).catch(() => {});
  pending = null;
  closeConfirmation();
}
queryForm.addEventListener('input', () => {
  invalidatePreview(); inspectionQuestion = null; updateLineNumbers(); renderLessons([], 'SQL 或参数已修改，运行时将重新校验与讲解。');
  document.querySelector('#editor-state').textContent = '已修改，尚未执行';
});
queryForm.addEventListener('change', invalidatePreview);
for (const id of ['query-connection', 'query-limit', 'share-schema', 'chat-question']) document.getElementById(id).addEventListener('input', invalidatePreview);
document.querySelector('#learning').addEventListener('change', () => {
  educationRequest++;
  if (!document.querySelector('#learning').checked) {
    renderLessons();
    document.querySelectorAll('#query-results .learning-output').forEach(node => node.remove());
    return;
  }
  updateEducation();
});
document.querySelector('#query-connection').addEventListener('change', () => {
  invalidatePreview();
  lastGenerated = null;
  document.querySelector('#query-sql').value = '';
  document.querySelector('#query-params').value = '[]';
  updateLineNumbers();
  queryResults.replaceChildren(element('p', 'muted', '数据源已切换，尚未执行查询。'));
  renderLessons();
  document.querySelector('#share-schema').checked = document.querySelector('#query-connection').selectedOptions[0]?.dataset.shareRecords === 'true';
  inspectionQuestion = null;
  refreshWorkspaceTables();
});
document.querySelector('#result-tab').addEventListener('click', event => selectResultTab(event.currentTarget));
document.querySelector('#result-tabs').addEventListener('keydown', event => {
  const tabs = [...document.querySelectorAll('#result-tabs [role="tab"]')];
  const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click(); tabs[next].focus();
});
document.querySelector('#query-sql').addEventListener('scroll', event => { document.querySelector('#line-numbers').scrollTop = event.target.scrollTop; });
document.querySelector('#reset-sql').addEventListener('click', () => {
  invalidatePreview();
  document.querySelector('#query-sql').value = lastGenerated?.sql || '';
  document.querySelector('#query-params').value = JSON.stringify(lastGenerated?.params || []);
  updateLineNumbers(); renderLessons();
  document.querySelector('#editor-state').textContent = '已重置，尚未执行';
});
previewPanel.addEventListener('cancel', event => { event.preventDefault(); invalidatePreview(); queryStatus.textContent = '已取消，未执行。'; });
function cancelPlan(plan) {
  return request('/api/mysql/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queryId: plan.queryId }) }).catch(() => {});
}
async function requestEditorPreview() {
  const id = document.querySelector('#query-connection').value;
  if (!id) throw new Error('请先选择数据源');
  const params = JSON.parse(document.querySelector('#query-params').value);
  return request(`/api/mysql/connections/${encodeURIComponent(id)}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: document.querySelector('#query-sql').value, params, defaultLimit: Number(document.querySelector('#query-limit').value), learning: document.querySelector('#learning').checked, inspectionQuestion }),
  });
}
document.querySelector('#cancel-query').addEventListener('click', () => { invalidatePreview(); queryStatus.textContent = '已取消，未执行。'; });
queryForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (document.querySelector('#workspace-view').hidden || running) return;
  const reusable = pending && matchesEditor(pending) ? pending : null;
  if (!reusable) invalidatePreview();
  const current = revision;
  queryStatus.textContent = '正在核对查询快照，尚未执行…';
  try {
    const preview = reusable || await requestEditorPreview();
    if (current !== revision) {
      await request('/api/mysql/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queryId: preview.queryId }) });
      return;
    }
    document.querySelector('#query-sql').value = preview.sql;
    updateLineNumbers();
    showPreview(preview);
    if (typeof previewPanel.showModal === 'function') previewPanel.showModal();
    else previewPanel.setAttribute('open', '');
    document.querySelector('#cancel-query').focus();
  } catch (error) { if (current === revision) queryStatus.textContent = `校验失败：${error.message}`; }
});
confirmButton.addEventListener('click', async () => {
  if (!pending || !previewPanel.open || running || document.querySelector('#workspace-view').hidden) return;
  const plan = pending;
  const learning = document.querySelector('#learning').checked;
  const sourceConnection = document.querySelector('#query-connection').value;
  const sourceQuestion = document.querySelector('#chat-question').value.trim();
  let continueInspection = false;
  pending = null;
  running = true;
  closeConfirmation();
  selectResultTab(document.querySelector('#result-tab'));
  queryResults.replaceChildren(element('p', 'muted', '正在运行查询…'));
  confirmButton.disabled = true;
  document.querySelector('#preview-button').disabled = true;
  queryStatus.textContent = '正在执行已确认的查询…';
  try {
    const result = await request('/api/mysql/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queryId: plan.queryId, confirm: true }),
    });
    const table = element('table');
    const head = element('tr');
    for (const column of result.columns) head.append(element('th', '', column));
    const thead = element('thead'); thead.append(head);
    const tbody = element('tbody');
    for (const record of result.rows) {
      const row = element('tr');
      for (const column of result.columns) row.append(element('td', '', record[column] === null ? 'NULL' : typeof record[column] === 'object' ? JSON.stringify(record[column]) : String(record[column])));
      tbody.append(row);
    }
    table.append(thead, tbody);
    const summary = element('p', '', `返回 ${result.rowCount} 行 · 上限 ${result.rowLimit}`);
    queryResults.replaceChildren(element('h3', '', '查询结果'), element('pre', '', result.sql), summary, table);
    if (learning && document.querySelector('#learning').checked) queryResults.append(element('p', 'muted learning-output', result.limitReached ? '已达到返回上限，可能还有更多匹配记录；返回行数不代表总数。' : '这是本次查询返回的记录，不应据此推断其他筛选条件下的数据。'));
    queryStatus.textContent = `运行完成，返回 ${result.rowCount} 行。`;
    document.querySelector('#editor-state').textContent = '已运行';
    if (result.samplesAvailable) queryStatus.textContent += ' 少量记录已作为当前连接的临时模型上下文。';
    continueInspection = !!result.inspectionQuestion && result.inspectionQuestion === sourceQuestion && sourceConnection === document.querySelector('#query-connection').value && sourceQuestion === document.querySelector('#chat-question').value.trim() && document.querySelector('#share-schema').checked;
  } catch (error) {
    queryStatus.textContent = `运行失败：${error.message}；不会自动重试。`;
    queryResults.replaceChildren(element('p', 'status-error', '本次运行失败，未取得查询结果。请检查错误提示后重新运行。'));
  }
  finally { running = false; document.querySelector('#preview-button').disabled = false; }
  if (continueInspection && !document.querySelector('#workspace-view').hidden) {
    document.querySelector('#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
});

function matchesEditor(plan) {
  try { return plan.sql === document.querySelector('#query-sql').value && JSON.stringify(plan.params) === JSON.stringify(JSON.parse(document.querySelector('#query-params').value)); }
  catch { return false; }
}
function renderQueryPlan(plan) {
  const target = document.querySelector('#plan-summary');
  target.hidden = false;
  if (!plan.semantic) {
    target.replaceChildren(element('strong', '', plan.source === 'schema-inspection' ? '辅助取值查询（不是最终答案）' : '手工 SQL：仅做结构与安全校验，未做自然语言意图复核'));
    return;
  }
  const semantic = plan.semantic;
  target.replaceChildren(
    element('strong', '', '本次查询计划'),
    element('p', '', `目标：${semantic.intent}`),
    element('p', '', `返回：${semantic.outputs.map(item => item.alias).join('、')} · 数据表：${semantic.table}`),
    element('p', '', `条件：${semantic.filters.map(item => `${item.column} ${item.operator} ${JSON.stringify(item.value)}（依据：${item.source}）`).join('；') || '无筛选条件'}`),
    element('small', '', `上限 ${semantic.rowLimit} 行 · 字段/参数校验通过 · 模型意图复核${semantic.review === 'passed' ? '通过，仍请核对' : '未完成'}`),
  );
}
function showPreview(preview) {
  pending = preview;
  renderQueryPlan(preview);
  document.querySelector('#preview-sql').textContent = preview.sql;
  document.querySelector('#preview-meta').textContent = `参数：${JSON.stringify(preview.params)} · 最多 ${preview.rowLimit} 行 · 5 分钟内有效`;
  if (preview.education) showEducation(preview.education);
  else if (document.querySelector('#learning').checked) updateEducation();
  else renderLessons();
  confirmButton.disabled = false;
  queryStatus.textContent = preview.kind === 'inspection' ? 'Agent 需要先确认字段的实际取值，已生成辅助读取 SQL。点击“运行 SQL”确认读取后，将自动继续翻译原问题。' : 'SQL 已就绪，点击“运行 SQL”继续。';
}

async function loadModel() {
  try {
    const model = await request('/api/model');
    readiness.model = model.configured === true;
    updateEntry();
    document.querySelector('#model-summary').textContent = model.configured ? `${model.model} · 已配置` : '未配置';
    if (model.configured) {
      document.querySelector('#model-form').elements.baseUrl.value = model.baseUrl;
      document.querySelector('#model-form').elements.model.value = model.model;
    }
  } catch {
    readiness.model = false;
    updateEntry();
    document.querySelector('#model-summary').textContent = '读取配置失败';
  }
}
document.querySelector('#model-form').addEventListener('submit', async event => {
  event.preventDefault(); invalidatePreview();
  const form = event.currentTarget;
  const button = document.querySelector('#save-model');
  const status = document.querySelector('#model-status');
  const config = Object.fromEntries(new FormData(form));
  button.disabled = true;
  try {
    const result = await request('/api/model', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
    status.textContent = result.note;
    await loadModel();
  } catch (error) { status.textContent = `保存失败：${error.message}`; }
  finally { form.elements.apiKey.value = ''; config.apiKey = ''; button.disabled = false; }
});
document.querySelector('#remove-model').addEventListener('click', async () => {
  invalidatePreview();
  try {
    await request('/api/model', { method: 'DELETE' });
    document.querySelector('#model-form').reset();
    await loadModel();
    document.querySelector('#model-status').textContent = '已清除模型配置';
  } catch (error) { document.querySelector('#model-status').textContent = error.message; }
});
document.querySelector('#chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (document.querySelector('#workspace-view').hidden || running) return;
  invalidatePreview();
  const current = revision;
  const question = document.querySelector('#chat-question').value;
  const connectionId = document.querySelector('#query-connection').value;
  if (!connectionId) { queryStatus.textContent = '请先添加并选择数据源'; return; }
  if (!document.querySelector('#share-schema').checked) { queryStatus.textContent = '请先勾选模型发送授权。'; return; }
  renderLessons([], '模型正在生成 SQL，完成后展示中文讲解。');
  document.querySelector('#ask-button').disabled = true;
  queryStatus.textContent = '正在分析结构、核对取值依据并复核查询计划（不执行查询）…';
  try {
    const proposal = await request('/api/chat/propose', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, connectionId, defaultLimit: Number(document.querySelector('#query-limit').value), learning: document.querySelector('#learning').checked, shareSchema: document.querySelector('#share-schema').checked }),
    });
    if (current !== revision) {
      if (proposal.queryId) await request('/api/mysql/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queryId: proposal.queryId }) });
      return;
    }
    if (proposal.kind === 'clarification') {
      queryStatus.textContent = `请补充说明：${proposal.question}`;
      renderLessons([], '问题需要澄清，尚未生成 SQL。请补充后重新发送完整问题。');
      return;
    }
    inspectionQuestion = proposal.kind === 'inspection' ? question.trim() : null;
    document.querySelector('#query-sql').value = proposal.sql;
    document.querySelector('#query-params').value = JSON.stringify(proposal.params);
    lastGenerated = { sql: proposal.sql, params: proposal.params, learning: proposal.learning };
    updateLineNumbers();
    document.querySelector('#editor-state').textContent = proposal.semantic ? '查询计划已编译并复核，尚未执行' : '已准备辅助取值查询，尚未执行';
    showPreview(proposal);
  } catch (error) { if (current === revision) queryStatus.textContent = `生成未完成：${error.message}`; }
  finally { document.querySelector('#ask-button').disabled = false; }
});
document.querySelector('#enter-workspace').addEventListener('click', async () => {
  const button = document.querySelector('#enter-workspace');
  button.disabled = true;
  await Promise.all([verifyRuntime(), loadConnections(), loadModel()]);
  if (runtimeCompatible && readiness.database && readiness.model) {
    location.hash = 'workspace';
    applyViewRoute();
  }
});
document.querySelector('#back-settings').addEventListener('click', () => {
  location.hash = 'settings';
  applyViewRoute();
});
window.addEventListener('hashchange', applyViewRoute);
document.querySelector('#refresh-button').addEventListener('click', loadConnections);
document.querySelector('#close-schema').addEventListener('click', () => { schemaPanel.hidden = true; });
Promise.all([verifyRuntime(), loadModel(), loadConnections()]).then(() => {
  viewsInitialized = true;
  updateLineNumbers();
  renderLessons();
  updateEntry();
  applyViewRoute();
});
