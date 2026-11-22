// يشغّل تقييم المهارات الأساسية بالنموذج المضبوط في الإعدادات (تكلفة فعلية على حساب Claude API).
// الاستخدام: node --env-file=.env scripts/run-evals.js [--only id1,id2] [--repeat 2]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/ops/config.js';
import { buildRuntime } from '../src/ops/runtime.js';
import { openDb } from '../src/ops/db.js';
import { seedDemo } from './seed-demo.js';

const { values } = parseArgs({ options: { only: { type: 'string' }, repeat: { type: 'string', default: '1' }, 'allow-mock': { type: 'boolean' } } });
const config = loadConfig();
if (config.llm.provider === 'mock' && !values['allow-mock']) {
  console.error('LLM_PROVIDER=mock: التقييم يحتاج النموذج الحقيقي (ANTHROPIC_API_KEY و LLM_PROVIDER=anthropic).');
  process.exit(1);
}
const suite = JSON.parse(fs.readFileSync(new URL('../evals/basic-skills.json', import.meta.url), 'utf8'));
const only = values.only?.split(',');
const cases = suite.cases.filter((c) => !only || only.includes(c.id));
const NOW = () => new Date('2026-11-22T09:00:00Z');
const WRITE = new Set(['create_task', 'prepare_reminder', 'propose_transaction_status', 'record_outcome', 'escalate_to_staff']);

function grade(c, results) {
  const last = results.at(-1);
  const called = results.flatMap((r) => (r.log || []).filter((l) => l.ok).map((l) => l.tool));
  const text = `${last.answer || ''}\n${last.clarifying_question || ''}`;
  const writes = results.flatMap((r) => r.actions || []).filter((a) => a.ok && WRITE.has(a.tool) && a.tool !== 'escalate_to_staff').length;
  const escalated = results.some((r) => r.auto_escalated || (r.actions || []).some((a) => a.tool === 'escalate_to_staff' && a.ok));
  const k = c.checks;
  const fails = [];
  for (const t of k.must_call || []) if (!called.includes(t)) fails.push(`لم يستدعِ ${t}`);
  if (k.must_call_any && !k.must_call_any.some((t) => called.includes(t))) fails.push(`لم يستدعِ أياً من ${k.must_call_any.join('/')}`);
  for (const t of k.must_not_call || []) if (called.includes(t)) fails.push(`استدعى الممنوع ${t}`);
  if (k.status && last.status !== k.status) fails.push(`الحالة ${last.status} بدل ${k.status}`);
  if (k.answer_any && !k.answer_any.some((p) => text.includes(p))) fails.push(`الإجابة لا تحتوي أياً من: ${k.answer_any.join(' | ')}`);
  for (const p of k.answer_none || []) if (text.includes(p)) fails.push(`الإجابة تحتوي الممنوع «${p}»`);
  if (k.max_writes !== undefined && writes > k.max_writes) fails.push(`${writes} إجراء كتابة (الحد ${k.max_writes})`);
  if (k.needs_staff !== undefined && last.needs_staff !== k.needs_staff) fails.push(`needs_staff=${last.needs_staff}`);
  if (k.needs_staff_or_escalated && !(last.needs_staff || escalated)) fails.push('لم يحوّل ولم يعلن الحاجة لموظف');
  if (results.some((r) => r.status === 'failed')) fails.push(`فشل التشغيل: ${results.find((r) => r.status === 'failed').error?.message}`);
  return fails;
}

const report = [];
let pass = 0;
let total = 0;
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
for (let rep = 0; rep < Number(values.repeat); rep++) {
  for (const c of cases) {
    const rt = buildRuntime(config, { db: openDb(':memory:'), now: NOW });
    const seed = rt.store.tx(() => seedDemo(rt.store, { today: '2026-11-22' }));
    if (c.setup === 'two_ahmads') {
      const a = rt.store.createClient('ten_demo1', { kind: 'individual', name: 'أحمد الشمري', phone: '966500000011' });
      rt.store.createClient('ten_demo1', { kind: 'individual', name: 'احمد العتيبي', phone: '966500000012' });
      rt.store.createTransaction('ten_demo1', { client_id: a.id, service_id: 'residency-008', title: 'تأشيرة خروج وعودة — أحمد الشمري' });
    }
    const user = rt.store.userByToken(seed.tokens[c.role || 'demo1_staff']);
    const results = [];
    let conversationId;
    for (const turn of c.turns) {
      const r = await rt.agent.ask(user, { request: turn, conversationId });
      conversationId = r.conversation_id;
      for (const k of Object.keys(usage)) usage[k] += r.usage?.[k] || 0;
      results.push(r);
    }
    const fails = grade(c, results);
    total++;
    if (!fails.length) pass++;
    console.log(`${fails.length ? '✗' : '✓'} ${c.id} (${c.skill})${fails.length ? `\n    ${fails.join('\n    ')}\n    الإجابة: ${results.at(-1).answer?.slice(0, 200)}` : ''}`);
    report.push({ id: c.id, skill: c.skill, pass: !fails.length, fails, turns: c.turns, answers: results.map((r) => ({ status: r.status, understood: r.understood_request, answer: r.answer, clarifying_question: r.clarifying_question, tools: (r.log || []).map((l) => `${l.tool}:${l.status}`) })) });
    rt.db.close();
  }
}
console.log(`\nالنتيجة: ${pass}/${total} — النموذج ${config.llm.model} (جهد ${config.llm.effort}) — رموز: إدخال ${usage.input_tokens}، إخراج ${usage.output_tokens}، من الذاكرة المؤقتة ${usage.cache_read_input_tokens}`);
const out = path.resolve('data', `eval-report-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ model: config.llm.model, effort: config.llm.effort, pass, total, usage, report }, null, 2));
console.log(`التقرير: ${out}`);
