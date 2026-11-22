// المهارات الأساسية: فهم التواريخ، البحث المرن، الملخص اليومي، ذاكرة المحادثة، السؤال التوضيحي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { toolUse } from '../src/ops/llm/mock.js';
import { parseDateExpression } from '../src/ops/dates.js';
import { extractEntities } from '../src/ops/tools/index.js';
import { runFollowups } from '../src/ops/followups.js';

const T = 'ten_demo1';
const lastResult = (messages) => JSON.parse(messages.at(-1).content[0].content);
const submit = (o) => toolUse('submit_answer', { understood_request: 'طلب', sources: [], missing_info: [], needs_staff: false, ...o });

test('فهم التعبيرات الزمنية العامية والهجرية (اليوم = الأحد 2026-11-22)', () => {
  const t = '2026-11-22';
  const cases = {
    'بكرة': '2026-11-23', 'بعد بكرة': '2026-11-24', 'أمس': '2026-11-21', 'بعد ٣ أيام': '2026-11-25', 'بعد اسبوعين': '2026-12-06',
    'بعد شهر': '2026-12-22', 'قبل يومين': '2026-11-20', 'الخميس الجاي': '2026-11-26', 'الأحد': '2026-11-29', 'نهاية الشهر': '2026-11-30',
    '١٥ رجب': '2026-12-24', '1 رمضان 1448': '2027-02-08', '٣ ديسمبر': '2026-12-03', '5 يناير': '2027-01-05', '1448/06/12هـ': '2026-11-22', '01/12/2026': '2026-12-01',
  };
  for (const [expr, iso] of Object.entries(cases)) assert.equal(parseDateExpression(expr, t).iso, iso, expr);
  const week = parseDateExpression('الأسبوع الجاي', t);
  assert.deepEqual([week.from, week.to], ['2026-11-29', '2026-12-05']);
  assert.throws(() => parseDateExpression('بعدين', t), /لم أفهم/);
  assert.throws(() => parseDateExpression('1448/01/30', t), /غير موجود/);
});

test('أداة resolve_date: اليوم والهجري والفرق بين تاريخين، والتعبير غير المفهوم يعيد خطأ مفهوماً', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = await env.ops.executeTool(ctx, 'resolve_date', { expression: 'الخميس الجاي', compare_to: 'نهاية الشهر' });
  assert.equal(r.data.date, '2026-11-26');
  assert.equal(r.data.weekday, 'الخميس');
  assert.equal(r.data.days_from_today, 4);
  assert.equal(r.data.hijri, '1448/06/16هـ');
  assert.equal(r.data.compare_to.days_between, 4);
  const bad = await env.ops.executeTool(ctx, 'resolve_date', { expression: 'قريب' });
  assert.equal(bad.error.code, 'invalid_date');
});

test('البحث المرن عن العميل: الهمزات والتطويل والخطأ البسيط، ووسم الغموض عند تعدد المطابقين', async () => {
  const env = setup();
  env.store.createClient(T, { kind: 'individual', name: 'أحمد الشمري' });
  env.store.createClient(T, { kind: 'individual', name: 'احمد العتيبي' });
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const find = async (query) => (await env.ops.executeTool(ctx, 'find_client', { query })).data;
  assert.equal((await find('فهـد')).clients[0].name, 'فهد التجريبي');
  assert.equal((await find('النخبه')).clients[0].name, 'مؤسسة النخبة التجريبية للمقاولات');
  assert.equal((await find('الشمرى')).clients[0].name, 'أحمد الشمري');
  const ambiguous = await find('احمد');
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.count, 2);
  assert.equal((await find('احمد الشمري')).ambiguous, false);
  const none = await find('خالد');
  assert.equal(none.count, 0);
  assert.match(none.hint, /لا يوجد عميل مطابق/);
});

test('الملخص اليومي: الأولويات مرتبة (منتهٍ ← متأخر ← قريب ← اعتمادات ← متوقف)', async () => {
  const env = setup();
  await runFollowups({ ...env, tenantId: T });
  env.store.createTask(T, { title: 'مهمة متأخرة', due_date: '2026-11-20', source: 'user' });
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = (await env.ops.executeTool(ctx, 'get_daily_overview', {})).data;
  assert.equal(r.counts.expired_documents, 1);
  assert.equal(r.counts.overdue_tasks, 1);
  assert.equal(r.counts.pending_approvals, 5);
  assert.equal(r.counts.stale_transactions, 1);
  const levels = r.priorities.map((p) => p.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => a - b));
  assert.match(r.priorities[0].why, /منتهٍ منذ 3 يوم/);
  // كل ما يدخل في العدد يظهر في القائمة (لا عدد بلا تفاصيل)
  assert.equal(r.expiring_within_horizon.length, r.counts.expiring_within_horizon);
  assert.equal(r.expired_documents.length, r.counts.expired_documents);
  assert.equal(r.today.weekday, 'الأحد');
});

test('ذاكرة المحادثة: الرسالة التالية ترى الطلب والإجابة السابقة والكيانات المذكورة بمعرّفاتها', async () => {
  const env = setup({
    script: ({ messages, step }) => {
      const isFirstTurn = Array.isArray(messages[0].content); // أول دور: لا تاريخ نصي قبله
      if (isFirstTurn && step === 0) return [toolUse('find_client', { query: 'فهد' })];
      if (isFirstTurn) return [submit({ understood_request: 'البحث عن العميل فهد', answer: 'وجدت العميل فهد التجريبي.' })];
      return [submit({ understood_request: 'إقامة فهد المذكور سابقاً', answer: 'إقامته تنتهي بعد 25 يوماً.' })];
    },
  });
  const staff = env.user('demo1_staff');
  const a = await env.agent.ask(staff, { request: 'دور لي العميل فهد' });
  assert.ok(a.conversation_id);
  assert.equal(a.entities[0].id, env.seed.clients.fahd.id);
  const b = await env.agent.ask(staff, { request: 'متى تنتهي إقامته؟', conversationId: a.conversation_id });
  assert.equal(b.conversation_id, a.conversation_id);
  const sent = env.llm.calls.at(-1).messages;
  assert.equal(sent[0].content, 'دور لي العميل فهد');
  assert.match(sent[1].content, /وجدت العميل فهد التجريبي/);
  assert.ok(sent[1].content.includes(env.seed.clients.fahd.id));
  assert.match(sent[2].content[0].text, /رسالة متابعة/);
  assert.equal(env.store.recentTurns(T, a.conversation_id).length, 2);
});

test('المحادثة خاصة بصاحبها: مستخدم آخر أو منشأة أخرى لا يكملها', async () => {
  const env = setup({ script: () => [submit({ answer: 'تم' })] });
  const a = await env.agent.ask(env.user('demo1_staff'), { request: 'سؤال أول' });
  await assert.rejects(() => env.agent.ask(env.user('demo1_manager'), { request: 'متابعة', conversationId: a.conversation_id }), (e) => e.code === 'not_found');
  await assert.rejects(() => env.agent.ask(env.user('demo2_manager'), { request: 'متابعة', conversationId: a.conversation_id }), (e) => e.code === 'not_found');
});

test('السؤال التوضيحي: عند تعدد المطابقين يتوقف دون إجراءات كتابة ولا يُحوَّل للمدير', async () => {
  const env = setup({
    script: ({ messages, step }) => {
      if (step === 0) return [toolUse('find_client', { query: 'احمد' })];
      const r = lastResult(messages).data;
      assert.equal(r.ambiguous, true);
      return [submit({
        understood_request: 'تجهيز تذكير لعميل اسمه أحمد',
        answer: 'لقيت عميلين باسم أحمد.',
        clarifying_question: `تقصد ${r.clients.map((c) => c.name).join(' أو ')}؟`,
        needs_staff: true,
      })];
    },
  });
  env.store.createClient(T, { kind: 'individual', name: 'أحمد الشمري' });
  env.store.createClient(T, { kind: 'individual', name: 'احمد العتيبي' });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'جهز تذكير لأحمد' });
  assert.equal(r.status, 'needs_clarification');
  assert.match(r.clarifying_question, /أحمد الشمري أو احمد العتيبي/);
  assert.equal(r.actions.length, 0);
  assert.equal(r.auto_escalated, undefined);
  assert.equal(env.store.listTasks(T).length, 0);
  // السؤال محفوظ في المحادثة ليفهم الجواب التالي («الشمري»)
  assert.match(env.store.recentTurns(T, r.conversation_id)[0].assistant_text, /سؤالي: تقصد/);
});

test('الإجابة تحمل الفهم والافتراضات ودرجة الثقة', async () => {
  const env = setup({ script: () => [submit({ understood_request: 'ما الإقامات التي تنتهي هذا الشهر', answer: 'إجابة', assumptions: ['«هذا الشهر» = الشهر الميلادي الحالي'], confidence: 'medium' })] });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'وش الاقامات اللي تخلص هالشهر؟' });
  assert.equal(r.understood_request, 'ما الإقامات التي تنتهي هذا الشهر');
  assert.deepEqual(r.assumptions, ['«هذا الشهر» = الشهر الميلادي الحالي']);
  assert.equal(r.confidence, 'medium');
});

test('الإجابة بلا understood_request تُرفض ويُطلب تصحيحها من النموذج', async () => {
  const env = setup({
    script: ({ step }) => step === 0
      ? [toolUse('submit_answer', { answer: 'ناقصة', sources: [], missing_info: [], needs_staff: false })]
      : [submit({ answer: 'مكتملة' })],
  });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'سؤال' });
  assert.equal(r.answer, 'مكتملة');
  assert.match(env.llm.calls[1].messages.at(-1).content[0].content, /understood_request: حقل مطلوب/);
});

test('استخراج الكيانات من نتائج الأدوات', () => {
  const e = extractEntities({ clients: [{ client_id: 'cli_a', name: 'فهد' }], transactions: [{ transaction_id: 'trx_b', title: 'تجديد' }], documents: [{ document_id: 'doc_c', type_name: 'إقامة', holder_name: 'راجو' }] });
  assert.deepEqual(e.map((x) => [x.type, x.id]), [['client', 'cli_a'], ['transaction', 'trx_b'], ['document', 'doc_c']]);
});
