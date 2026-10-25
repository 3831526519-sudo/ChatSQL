(() => {
  'use strict';
  const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  function list(values) { const ul = node('ul'); for (const value of values || []) ul.append(node('li', '', value)); return ul; }
  function disclosure(title, children) { const details = node('details', 'education-disclosure'); details.append(node('summary', '', title), ...children); return details; }
  function comparison(value) {
    return disclosure('对比写法：' + value.title, [node('span', 'education-code-label', '本句 / 原写法'), node('pre', 'education-code', value.before), node('span', 'education-code-label', '教学对比（不会执行）'), node('pre', 'education-code', value.after), node('p', '', value.note)]);
  }
  function locateButton(range, options) {
    const button = node('button', 'lesson-locate', '定位代码'); button.type = 'button';
    button.addEventListener('click', () => options.locate?.(range));
    return button;
  }
  function render(container, education, options = {}) {
    container.replaceChildren();
    if (!education) { container.append(node('p', 'lesson-empty', options.message || '生成或输入 SQL 后，可更新本句讲解。')); return; }
    if (education.status !== 'supported') {
      container.append(node('p', 'education-warning', education.message || '当前语法尚不能生成完整讲解。'));
      return;
    }
    container.append(node('p', 'education-overview', education.overview), node('small', 'education-source', education.intentSource));
    const nav = node('nav', 'education-nav'); nav.setAttribute('aria-label', '教学内容目录');
    for (const [id, title] of [['structure', '语句结构'], ['orders', '两种顺序'], ['symbols', '函数与符号'], ['warnings', '注意事项']]) {
      const button = node('button', '', title); button.type = 'button';
      button.addEventListener('click', () => container.querySelector(`#education-${id}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
      nav.append(button);
    }
    container.append(nav);
    const structure = node('section', 'education-section'); structure.id = 'education-structure'; structure.append(node('h3', 'education-section-title', '逐段读懂这条 SQL'));
    for (const clause of education.clauses || []) {
      const article = node('article', 'education-clause learning-segment'); article.dataset.lessonClause = clause.id;
      const heading = node('div', 'education-clause-heading'); heading.append(node('h4', '', clause.title), locateButton(clause.range, options));
      article.append(heading, node('pre', 'education-code', clause.sql), node('p', 'education-what', clause.what), node('strong', 'education-why-title', '为什么在这里使用'), node('p', 'education-why', clause.why));
      if (clause.details?.length) article.append(disclosure('深入理解', [list(clause.details)]));
      if (clause.comparison) article.append(comparison(clause.comparison));
      if (clause.pitfalls?.length) article.append(disclosure('常见误区', [list(clause.pitfalls)]));
      structure.append(article);
    }
    container.append(structure);
    const orders = node('section', 'education-section'); orders.id = 'education-orders';
    orders.append(node('h3', 'education-section-title', '为什么这样排列'), node('h4', '', '你写下来的顺序'), node('p', 'education-flow', (education.writingOrder || []).join(' → ')), node('h4', '', '帮助理解的逻辑顺序'), node('p', 'education-flow', (education.logicalOrder || []).join(' → ')), node('p', 'education-note', education.orderNote));
    container.append(orders);
    const symbols = node('section', 'education-section'); symbols.id = 'education-symbols'; symbols.append(node('h3', 'education-section-title', '本句的函数与符号'));
    if (!education.glossary?.length) symbols.append(node('p', 'muted', '本句没有需要额外说明的函数或符号。'));
    for (const item of education.glossary || []) {
      const content = [node('pre', 'education-code', item.sql), node('p', '', item.text)];
      if (item.range) content.push(locateButton(item.range, options));
      if (item.details?.length) content.push(list(item.details));
      if (item.comparison) content.push(comparison(item.comparison));
      symbols.append(disclosure(item.title, content));
    }
    if (education.parameters?.length) {
      const parameters = node('div', 'education-parameters'); parameters.append(node('h4', '', '本次实际参数绑定'));
      for (const parameter of education.parameters) {
        const row = node('div', 'education-parameter');
        row.append(node('code', '', `第 ${parameter.position} 个 ? = ${parameter.provided ? JSON.stringify(parameter.value) : '未提供'}`), locateButton(parameter.range, options));
        parameters.append(row);
      }
      symbols.append(parameters);
    }
    container.append(symbols);
    const warnings = node('section', 'education-section'); warnings.id = 'education-warnings'; warnings.append(node('h3', 'education-section-title', '读结果时还要知道'), list(education.warnings));
    container.append(warnings);
  }
  function highlight(container, clauseId) {
    for (const article of container.querySelectorAll('[data-lesson-clause]')) {
      const active = article.dataset.lessonClause === clauseId;
      article.classList.toggle('is-active', active);
      if (active) article.setAttribute('aria-current', 'true'); else article.removeAttribute('aria-current');
    }
  }
  window.ChatSqlEducation = Object.freeze({ render, highlight });
})();
