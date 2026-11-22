// اختبارات حلقة الوكيل بنموذج محاكى (لا يوجد مفتاح API في بيئة التطوير).
// السيناريوهات تحاكي قرارات النموذج؛ ما يُختبر هو سلوك النظام: الأدوات، الصلاحيات، المصادر، الفشل، التكرار.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { toolUse, text } from '../src/ops/llm/mock.js';
import { echoableContent } from '../src/ops/llm/index.js';
import { OpsError } from '../src/ops/util.js';

const lastResult = (messages) => JSON.parse(messages.at(-1).content[0].content);
const submit = (o) => toolUse('submit_answer', { understood_request: 'طلب اختبار', sources: [], missing_info: [], needs_staff: false, ...o });

test('طلب طبيعي: بحث عميل ← نواقص ← تذكير ← إجابة بمصادر وإجراء ينتظر الاعتماد', async () => {
  const env = setup({
    script: ({ messages, step }) => {
      if (step === 0) return [text('أبحث عن العميل.'), toolUse('find_client', { query: 'فهد' })];
      if (step === 1) return [toolUse('get_client', { client_id: lastResult(messages).data.clients[0].client_id })];
      if (step === 2) return [toolUse('check_missing_requirements', { transaction_id: lastResult(messages).data.transactions[0].transaction_id })];
      if (step === 3) {
        const r = lastResult(messages).data;
        return [toolUse('prepare_reminder', { client_id: env.seed.clients.fahd.id, kind: 'missing_documents', transaction_id: r.transaction_id })];
      }
      return [submit({ answer: 'ينقص: إقامة سارية، وسداد الرسوم. جُهّز تذكير وينتظر الاعتماد.', sources: ['svc:residency-002'] })];
    },
  });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'ما نواقص معاملة تجديد إقامة فهد؟ جهّز له تذكيراً' });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.sources[0].id, 'svc:residency-002');
  assert.equal(r.sources[0].approval, 'approved_listing_requirements_unverified');
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].tool, 'prepare_reminder');
  assert.equal(r.actions[0].status, 'pending_approval');
  assert.equal(r.pending_approvals.length, 1);
  assert.equal(r.log.length, 4);
  assert.deepEqual(r.warnings, []);
  assert.equal(env.store.getRun('ten_demo1', r.run_id).status, 'succeeded');
  // التعليمات ثابتة بين الطلبات (للتخزين المؤقت) والسياق المتغير في رسالة المستخدم
  assert.match(env.llm.calls[0].messages[0].content[0].text, /اليوم: 2026-11-22/);
});

test('نقص المعرفة: الوكيل يقرر الحاجة لموظف دون تحويل → يُحوَّل برمجياً بمهمة للمدير', async () => {
  const env = setup({
    script: ({ step }) => step === 0
      ? [toolUse('check_missing_requirements', { transaction_id: env.seed.transactions.txExtract.id })]
      : [submit({ answer: 'لا توجد متطلبات موثقة لهذه الخدمة.', needs_staff: true, staff_reason: 'المتطلبات غير موثقة', missing_info: ['متطلبات الخدمة من الموظف المختص'] })],
  });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'ما نواقص معاملة مستخرج السجل التجاري؟' });
  assert.equal(r.needs_staff, true);
  assert.equal(r.auto_escalated, true);
  const task = env.store.listTasks('ten_demo1').find((t) => t.assignee_role === 'manager');
  assert.match(task.details, /المتطلبات غير موثقة/);
  assert.deepEqual(r.missing_info, ['متطلبات الخدمة من الموظف المختص']);
});

test('استشهاد بمصدر لم يُسترجع وادعاء إرسال لم يحدث → يُستبعد المصدر ويظهر تنبيه', async () => {
  const env = setup({ script: () => [submit({ answer: 'تم إرسال التذكير للعميل.', sources: ['svc:residency-002', 'fact:made-up'] })] });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'ما متطلبات تجديد الإقامة؟' });
  assert.deepEqual(r.sources.map((s) => s.id), ['svc:residency-002']);
  assert.ok(r.warnings.some((w) => w.includes('fact:made-up')));
  assert.ok(r.warnings.some((w) => w.includes('لم تؤكده الأدوات')));
});

test('فشل النموذج: رسالة مفهومة، مهمة للمدير، والتشغيل مسجل كفاشل', async () => {
  const env = setup({ script: () => { throw new OpsError('llm_unavailable', 'تعذر الاتصال بمزود النموذج.'); } });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'ما الإقامات التي تنتهي هذا الشهر؟' });
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'llm_unavailable');
  assert.match(r.answer, /تعذر إكمال الطلب/);
  assert.ok(env.store.getTask('ten_demo1', r.fallback_task_id));
  assert.equal(env.store.getRun('ten_demo1', r.run_id).status, 'failed');
});

test('فشل النموذج بعد إجراء مكتمل: الإجراء المكتمل يظهر مع تنبيه', async () => {
  const env = setup({
    script: ({ step }) => {
      if (step === 0) return [toolUse('create_task', { title: 'الاتصال بالعميل فهد' })];
      throw new Error('socket hang up');
    },
  });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'أنشئ مهمة للاتصال بفهد' });
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'internal_error');
  assert.equal(r.actions[0].status, 'done');
  assert.equal(r.warnings.length, 1);
});

test('رفض النموذج (refusal) يُعامل كفشل مفهوم', async () => {
  const env = setup({ script: () => ({ content: [], stop_reason: 'refusal' }) });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'طلب ما' });
  assert.equal(r.status, 'failed');
  assert.equal(r.error.code, 'llm_refusal');
});

test('فشل أداة: الخطأ يصل للنموذج كـ is_error ويظهر للمستخدم', async () => {
  const env = setup({
    script: ({ step }) => step === 0
      ? [toolUse('get_transaction', { transaction_id: 'trx_doesnotexist' })]
      : [submit({ answer: 'لم أجد المعاملة.', missing_info: ['رقم المعاملة الصحيح'] })],
  });
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'ما حالة المعاملة trx_doesnotexist؟' });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.errors[0].code, 'not_found');
  const toolResult = env.llm.calls[1].messages.at(-1).content[0];
  assert.equal(toolResult.is_error, true);
});

test('تكرار الطلب بنفس request_id: لا استدعاء جديد للنموذج ولا إجراءات مكررة', async () => {
  const env = setup({
    script: ({ step }) => step === 0 ? [toolUse('create_task', { title: 'مراجعة ملف المؤسسة' })] : [submit({ answer: 'أُنشئت المهمة.' })],
  });
  const staff = env.user('demo1_staff');
  const a = await env.agent.ask(staff, { request: 'أنشئ مهمة لمراجعة ملف المؤسسة', requestId: 'req-1' });
  const b = await env.agent.ask(staff, { request: 'أنشئ مهمة لمراجعة ملف المؤسسة', requestId: 'req-1' });
  assert.equal(b.replayed, true);
  assert.equal(b.run_id, a.run_id);
  assert.equal(env.llm.calls.length, 2);
  assert.equal(env.store.listTasks('ten_demo1').length, 1);
});

test('الصلاحيات: المطّلع لا تُعرض له أدوات الكتابة، وإن استدعاها تُرفض', async () => {
  const env = setup({
    script: ({ step }) => step === 0 ? [toolUse('create_task', { title: 'مهمة غير مسموحة' })] : [submit({ answer: 'لا أملك الصلاحية.' })],
  });
  const r = await env.agent.ask(env.user('demo1_viewer'), { request: 'أنشئ مهمة' });
  assert.ok(!env.llm.calls[0].tools.includes('create_task'));
  assert.ok(env.llm.calls[0].tools.includes('get_client'));
  assert.equal(r.errors[0].code, 'forbidden');
  assert.equal(env.store.listTasks('ten_demo1').length, 0);
});

test('الحد الأقصى للخطوات: يتوقف ويحوّل للموظف', async () => {
  const env = setup({ script: () => [toolUse('search_knowledge', { query: 'تجديد الإقامة' })] });
  env.config.agent.maxSteps = 3;
  const r = await env.agent.ask(env.user('demo1_staff'), { request: 'سؤال يدور' });
  assert.equal(r.steps, 3);
  assert.equal(r.needs_staff, true);
  assert.ok(r.warnings.some((w) => w.includes('توقف الوكيل')));
});

test('مدخلات غير صالحة للطلب نفسه تُرفض', async () => {
  const env = setup();
  await assert.rejects(() => env.agent.ask(env.user('demo1_staff'), { request: '' }), (e) => e.code === 'invalid_input');
});

test('إعادة كتل الرد بعد التحويل لنموذج احتياطي: تُحذف كتل ما قبل fallback وتبقى الكتلة نفسها', () => {
  const content = [
    { type: 'thinking', thinking: '' },
    { type: 'tool_use', id: 'a', name: 'x', input: {} },
    { type: 'fallback', from: { model: 'm1' }, to: { model: 'm2' } },
    { type: 'thinking', thinking: '' },
    { type: 'tool_use', id: 'b', name: 'y', input: {} },
  ];
  assert.deepEqual(echoableContent(content).map((b) => b.id || b.type), ['fallback', 'thinking', 'b']);
  assert.equal(echoableContent([text('x')]).length, 1);
});
