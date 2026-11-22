import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { OpsError } from '../src/ops/util.js';

test('قراءة ملف العميل: الأيام المتبقية محسوبة برمجياً والجوال مختصر', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = await env.ops.executeTool(ctx, 'get_client', { client_id: env.seed.clients.biz.id });
  assert.equal(r.ok, true);
  assert.equal(r.data.client.phone, '…0002');
  const iqama = r.data.documents.find((d) => d.type === 'iqama');
  assert.equal(iqama.days_left, 10);
  assert.equal(iqama.expiry_hijri.endsWith('هـ'), true);
});

test('فحص النواقص: يحدد الناقص من متطلبات الخدمة الموثقة', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = await env.ops.executeTool(ctx, 'check_missing_requirements', { transaction_id: env.seed.transactions.txRenew.id });
  assert.equal(r.data.requirements_known, true);
  assert.deepEqual(r.data.missing, ['إقامة سارية أو منتهية حديثًا', 'سداد الرسوم النظامية إن استحقت']);
  assert.deepEqual(r.data.sources, ['svc:residency-002']);
});

test('نقص المعرفة: خدمة بلا متطلبات موثقة لا تُخترع لها نواقص', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = await env.ops.executeTool(ctx, 'check_missing_requirements', { transaction_id: env.seed.transactions.txExtract.id });
  assert.equal(r.data.requirements_known, false);
  assert.deepEqual(r.data.missing, []);
  assert.match(r.data.note, /لا توجد متطلبات موثقة/);
});

test('الصلاحيات: المطّلع لا ينشئ مهام', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_viewer'));
  const r = await env.ops.executeTool(ctx, 'create_task', { title: 'مهمة' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'forbidden');
  assert.equal(env.store.listTasks('ten_demo1').length, 0);
});

test('التحقق من المدخلات: حقول ناقصة أو غير معروفة تُرفض', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r1 = await env.ops.executeTool(ctx, 'create_task', {});
  assert.equal(r1.error.code, 'invalid_input');
  const r2 = await env.ops.executeTool(ctx, 'create_task', { title: 'مهمة اختبار', tenant_id: 'ten_demo2' });
  assert.equal(r2.error.code, 'invalid_input');
  assert.match(r2.error.message, /tenant_id: حقل غير معروف/);
  const r3 = await env.ops.executeTool(ctx, 'create_task', { title: 'مهمة اختبار', due_date: '2026-02-30' });
  assert.equal(r3.error.code, 'invalid_input');
});

test('عزل المنشآت: لا يمكن قراءة عميل أو معاملة منشأة أخرى', async () => {
  const env = setup();
  const ctx2 = env.ops.ctxFor(env.user('demo2_manager'));
  const a = await env.ops.executeTool(ctx2, 'get_client', { client_id: env.seed.clients.fahd.id });
  assert.equal(a.error.code, 'not_found');
  const b = await env.ops.executeTool(ctx2, 'get_transaction', { transaction_id: env.seed.transactions.txRenew.id });
  assert.equal(b.error.code, 'not_found');
  const c = await env.ops.executeTool(ctx2, 'find_client', { query: 'فهد' });
  assert.equal(c.data.count, 0);
  const d = await env.ops.executeTool(ctx2, 'create_task', { title: 'مهمة عبر المنشآت', client_id: env.seed.clients.fahd.id });
  assert.equal(d.error.code, 'not_found');
  const e = await env.ops.executeTool(ctx2, 'list_expiring_documents', { within_days: 365 });
  assert.equal(e.data.count, 1); // مستند منشأته فقط
});

test('تكرار الطلب: إنشاء نفس المهمة مرتين يعيد المهمة الموجودة', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const input = { title: 'الاتصال بفهد لاستلام الإقامة', client_id: env.seed.clients.fahd.id, due_date: '2026-11-24' };
  const r1 = await env.ops.executeTool(ctx, 'create_task', input);
  const r2 = await env.ops.executeTool(ctx, 'create_task', input);
  assert.equal(r1.status, 'done');
  assert.equal(r2.status, 'duplicate');
  assert.equal(r1.data.task_id, r2.data.task_id);
  assert.equal(env.store.listTasks('ten_demo1').length, 1);
});

test('تغيير الحالة: اقتراح ← اعتماد مدير ← تنفيذ، والموظف لا يعتمد', async () => {
  const env = setup();
  const staff = env.user('demo1_staff');
  const ctx = env.ops.ctxFor(staff);
  const tx = env.seed.transactions.txRenew;
  const p = await env.ops.executeTool(ctx, 'propose_transaction_status', { transaction_id: tx.id, new_status: 'under_review', reason: 'وصلت المستندات' });
  assert.equal(p.status, 'pending_approval');
  assert.equal(env.store.getTransaction('ten_demo1', tx.id).status, 'awaiting_documents'); // لم تتغير بعد

  const dup = await env.ops.executeTool(ctx, 'propose_transaction_status', { transaction_id: tx.id, new_status: 'under_review', reason: 'مكرر' });
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.data.action_id, p.data.action_id);

  await assert.rejects(() => env.ops.approveAction(staff, p.data.action_id), (e) => e instanceof OpsError && e.code === 'forbidden');
  const done = await env.ops.approveAction(env.user('demo1_manager'), p.data.action_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(env.store.getTransaction('ten_demo1', tx.id).status, 'under_review');
  // الاعتماد المزدوج مرفوض
  await assert.rejects(() => env.ops.approveAction(env.user('demo1_owner'), p.data.action_id), (e) => e.code === 'conflict');
});

test('تعارض البيانات: تغيرت الحالة بعد الاقتراح → يفشل التنفيذ ولا يكتب فوقها', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const tx = env.seed.transactions.txRenew;
  const p = await env.ops.executeTool(ctx, 'propose_transaction_status', { transaction_id: tx.id, new_status: 'quoted', reason: 'جاهز للتسعير' });
  env.store.updateTransactionStatus('ten_demo1', tx.id, { from: 'awaiting_documents', to: 'on_hold', actor: 'other' });
  const res = await env.ops.approveAction(env.user('demo1_manager'), p.data.action_id);
  assert.equal(res.status, 'failed');
  assert.match(res.error, /تعارض/);
  assert.equal(env.store.getTransaction('ten_demo1', tx.id).status, 'on_hold');
});

test('انتقال غير مسموح يُرفض قبل إنشاء الإجراء', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = await env.ops.executeTool(ctx, 'propose_transaction_status', { transaction_id: env.seed.transactions.txRenew.id, new_status: 'completed', reason: 'إغلاق' });
  assert.equal(r.error.code, 'invalid_transition');
  assert.equal(env.store.listActions('ten_demo1').length, 0);
});

test('إغلاق المعاملة يلغي مهامها الآلية وتذكيراتها المعلقة', async () => {
  const env = setup();
  const T = 'ten_demo1';
  const tx = env.seed.transactions.txTransfer;
  env.store.createTask(T, { title: 'متابعة آلية', transaction_id: tx.id, source: 'automation', dedupe_key: 'x' });
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const p = await env.ops.executeTool(ctx, 'propose_transaction_status', { transaction_id: tx.id, new_status: 'completed', reason: 'اكتمل النقل' });
  await env.ops.approveAction(env.user('demo1_manager'), p.data.action_id);
  assert.equal(env.store.listTasks(T, { status: 'open' }).filter((t) => t.transaction_id === tx.id).length, 0);
});

test('التذكير: يُجهَّز ولا يُرسل؛ بعد الاعتماد يُرسل عبر القناة اليدوية كـ«جاهز للإرسال اليدوي» وليس «أُرسل»', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = await env.ops.executeTool(ctx, 'prepare_reminder', { client_id: env.seed.clients.fahd.id, kind: 'missing_documents', transaction_id: env.seed.transactions.txRenew.id });
  assert.equal(r.status, 'pending_approval');
  assert.match(r.data.message, /إقامة سارية/);
  const rem = env.store.getReminder('ten_demo1', r.data.reminder_id);
  assert.equal(rem.status, 'pending_approval');
  const done = await env.ops.approveAction(env.user('demo1_manager'), r.data.action_id);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.delivery_status, 'queued_manual');
  assert.equal(env.store.getReminder('ten_demo1', rem.id).status, 'queued_manual');
  const sent = env.ops.markReminderSent(env.user('demo1_staff'), rem.id);
  assert.equal(sent.status, 'sent');
});

test('العميل الموقِف للرسائل لا يُجهَّز له تذكير', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const salemDoc = env.seed.docs.salemIqama;
  const r = await env.ops.executeTool(ctx, 'prepare_reminder', { client_id: env.seed.clients.salem.id, kind: 'renewal', document_id: salemDoc.id });
  assert.equal(r.status, 'skipped');
  assert.equal(env.store.listReminders('ten_demo1').length, 0);
});

test('فشل القناة: يُسجل التذكير «فشل» والإجراء «فشل» برسالة مفهومة، ولا يُدّعى الإرسال', async () => {
  const failing = { name: 'whatsapp', async send() { throw new OpsError('channel_unavailable', 'واتساب غير متاح مؤقتاً: HTTP 503'); } };
  const env = setup({ channelOverrides: { whatsapp: failing } });
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = await env.ops.executeTool(ctx, 'prepare_reminder', { client_id: env.seed.clients.fahd.id, kind: 'renewal', document_id: env.seed.docs.fahdIqama.id, channel: 'whatsapp' });
  const res = await env.ops.approveAction(env.user('demo1_manager'), r.data.action_id);
  assert.equal(res.status, 'failed');
  assert.match(res.error, /غير متاح مؤقتاً/);
  assert.equal(env.store.getReminder('ten_demo1', r.data.reminder_id).status, 'failed');
});

test('مهلة الأداة: أداة معلّقة تنتهي بخطأ timeout', async () => {
  const slow = { name: 'slow_tool', description: 'x', permission: 'read', mode: 'read', input_schema: { type: 'object', properties: {}, additionalProperties: false }, run: () => new Promise(() => {}) };
  const env = setup({ extraTools: [slow], configOverrides: {} });
  env.config.agent.toolTimeoutMs = 50;
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  const r = await env.ops.executeTool(ctx, 'slow_tool', {});
  assert.equal(r.error.code, 'timeout');
});

test('سجل التدقيق لا يحتوي أرقام جوال كاملة', async () => {
  const env = setup();
  const ctx = env.ops.ctxFor(env.user('demo1_staff'));
  await env.ops.executeTool(ctx, 'find_client', { phone: '0500000001' });
  const rows = env.store.db.prepare('SELECT detail FROM audit_log').all().map((r) => r.detail).join('\n');
  assert.doesNotMatch(rows, /500000001/);
});
