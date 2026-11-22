// تشغيل مجموعة تقييم المهارات الأساسية (evals/basic-skills.json) على النموذج المضبوط.
// كل سيناريو يعمل على قاعدة بيانات في الذاكرة ببيانات وهمية جديدة؛ لا يلمس قاعدة التشغيل.
import fs from 'node:fs';
import { buildRuntime } from './runtime.js';
import { openDb } from './db.js';
import { seedDemo } from '../../scripts/seed-demo.js';

const SUITE = new URL('../../evals/basic-skills.json', import.meta.url);
const NOW = () => new Date('2026-11-22T09:00:00Z');
const WRITE = new Set(['create_task', 'prepare_reminder', 'propose_transaction_status', 'record_outcome']);

export function loadSuite() {
  return JSON.parse(fs.readFileSync(SUITE, 'utf8'));
}

export function grade(c, results) {
  const last = results.at(-1);
  const called = results.flatMap((r) => (r.log || []).filter((l) => l.ok).map((l) => l.tool));
  const text = `${last.answer || ''}\n${last.clarifying_question || ''}`;
  const writes = results.flatMap((r) => r.actions || []).filter((a) => a.ok && WRITE.has(a.tool)).length;
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
  const failed = results.find((r) => r.status === 'failed');
  if (failed) fails.push(`فشل التشغيل: ${failed.error?.message}`);
  return fails;
}

export async function runEvalSuite({ config, only, onCase = () => {} }) {
  const suite = loadSuite();
  const cases = suite.cases.filter((c) => !only?.length || only.includes(c.id));
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const report = [];
  for (const c of cases) {
    const started = Date.now();
    const rt = buildRuntime(config, { db: openDb(':memory:'), now: NOW });
    try {
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
        for (const key of Object.keys(usage)) usage[key] += r.usage?.[key] || 0;
        results.push(r);
      }
      const fails = grade(c, results);
      const entry = {
        id: c.id, skill: c.skill, pass: !fails.length, fails, seconds: Math.round((Date.now() - started) / 1000), turns: c.turns,
        answers: results.map((r) => ({
          status: r.status, understood: r.understood_request, answer: r.answer, clarifying_question: r.clarifying_question,
          assumptions: r.assumptions, confidence: r.confidence, tools: (r.log || []).map((l) => `${l.tool}:${l.status}`), warnings: r.warnings,
        })),
      };
      report.push(entry);
      onCase(entry);
    } finally {
      rt.db.close();
    }
  }
  const pass = report.filter((r) => r.pass).length;
  return { model: config.llm.model, effort: config.llm.effort, pass, total: report.length, usage, report };
}
