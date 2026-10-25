import { compileIntentPlan, compileInspection, EvidenceRequired, PlanError } from '../sql/plan.mjs';
import { explainQuery, buildEducation } from '../sql/learning.mjs';

// No execution capability is called here: schema -> intent -> evidence -> compile -> review.
export async function proposeQuery({ provider, connector, database, question, learning = false, defaultLimit = 100, recordContext, connectionId, shareRecords = false }) {
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) throw new TypeError('请输入 1–4000 字的问题');
  if (!Number.isInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > 1000) throw new TypeError('默认行数必须在 1–1000 之间');
  question = question.trim();
  const schema = await connector.getAuthorizedSchema();
  if (!schema.length) throw new TypeError('没有可用的授权表，请检查数据源授权');
  if (JSON.stringify(schema).length > 100000) throw new TypeError('授权 Schema 过大，请缩小表范围');
  const trace = ['schema_loaded'];
  const samples = shareRecords && recordContext ? recordContext.get(connectionId, schema) : [];
  const candidate = await provider.generate({ question, database, schema, samples, canInspect: shareRecords, learning, defaultLimit });
  trace.push('intent_planned');

  function inspect(target) {
    if (!shareRecords) return { kind: 'clarification', reason: 'permission', question: '此查询需要实际字段值作为依据，请先在连接配置中授权记录上下文；无需手工填写数据库取值。', trace: [...trace, 'permission_needed'] };
    const plan = compileInspection(target, { database, schema });
    if (samples.length >= 4 || samples.some(sample => sample.sql === plan.sql)) return { kind: 'clarification', reason: 'evidence_inconclusive', question: `已有 ${target.table}.${target.column} 的有限样例仍无法确认映射，不能把未采到的值视为不存在。请补充业务含义或缩小需求范围。`, trace: [...trace, 'evidence_inconclusive'] };
    plan.inspectionQuestion = question;
    plan.source = 'schema-inspection';
    plan.evidenceTarget = { table: target.table, column: target.column };
    return { kind: 'inspection', plan, education: learning ? buildEducation(plan) : null, learning: learning ? [{ title: '为什么先读取取值', text: `需要确认 ${target.table}.${target.column} 的实际表示方式。该 SQL 只供确认，不是原问题的最终结果查询。` }, ...explainQuery(plan)] : [], trace: [...trace, 'evidence_needed', 'awaiting_confirmation'] };
  }
  if (candidate.kind === 'clarification') {
    if (candidate.reason === 'data_value') return inspect({ table: candidate.table, column: candidate.column });
    return { ...candidate, trace: [...trace, 'clarification_needed'] };
  }
  if (candidate.kind === 'inspection') return inspect(candidate);
  if (candidate.kind !== 'plan') throw new PlanError('模型必须提供结构化计划；拒绝旧式直接 SQL 响应');
  let plan;
  try { plan = compileIntentPlan(candidate.plan, { question, database, schema, samples, defaultLimit }); }
  catch (error) { if (error instanceof EvidenceRequired) return inspect(error); throw error; }
  trace.push('plan_compiled');
  if (typeof provider.review !== 'function') throw new PlanError('模型适配器缺少独立意图审查能力，未创建待执行查询');
  const review = await provider.review({ question, semantic: plan.semantic, schema, samples });
  if (!review || review.approved !== true || !Array.isArray(review.issues) || review.issues.length) return { kind: 'clarification', reason: 'semantic_review', question: `查询计划未通过意图核对：${Array.isArray(review?.issues) ? review.issues.join('；') : '审查未能确认计划符合原问题'}。请澄清后重试；尚未创建可执行查询。`, trace: [...trace, 'semantic_review_rejected'] };
  plan.semantic.review = 'passed';
  plan.source = 'intent-plan';
  const lessons = learning ? [{ title: '查询意图', text: plan.semantic.intent }, ...explainQuery(plan)] : [];
  return { kind: 'query', plan, education: learning ? buildEducation(plan) : null, learning: lessons, trace: [...trace, 'semantic_review_passed', 'awaiting_confirmation'] };
}
