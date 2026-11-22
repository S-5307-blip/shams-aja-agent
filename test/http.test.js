// اختبار واجهة HTTP على خادم فعلي بمنفذ عشوائي.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/ops/app.js';
import { toolUse } from '../src/ops/llm/mock.js';

let env, server, base;
before(async () => {
  env = setup({
    script: ({ step }) => step === 0
      ? [toolUse('propose_transaction_status', { transaction_id: env.seed.transactions.txRenew.id, new_status: 'under_review', reason: 'اكتملت المستندات' })]
      : [toolUse('submit_answer', { understood_request: 'تغيير حالة معاملة فهد', answer: 'اقترحت تغيير الحالة وينتظر الاعتماد.', sources: [], missing_info: [], needs_staff: false })],
  });
  server = createApp(env).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (path, token, opts = {}) => {
  const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const tok = (k) => env.seed.tokens[k];

test('بدون رمز أو برمز خاطئ: 401', async () => {
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/me', 'wrong')).status, 401);
});

test('الواجهة الرسومية تُخدم', async () => {
  const res = await fetch(`${base}/ops/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /وكيل عمليات المكتب/);
});

test('عزل المنشآت عبر HTTP: 404 لعميل منشأة أخرى، وقائمة العملاء خاصة بالمنشأة', async () => {
  assert.equal((await call(`/api/clients/${env.seed.clients.fahd.id}`, tok('demo2_manager'))).status, 404);
  const list = await call('/api/clients', tok('demo2_manager'));
  assert.deepEqual(list.body.map((c) => c.name), ['عميل منشأة أخرى (تجريبي)']);
});

test('دورة كاملة: طلب للوكيل ← إجراء معلق ← الموظف لا يعتمد (403) ← المدير يعتمد ← الحالة تتغير', async () => {
  const ask = await call('/api/agent/ask', tok('demo1_staff'), { method: 'POST', body: { request: 'غيّر حالة معاملة فهد إلى قيد المراجعة', request_id: 'r1' } });
  assert.equal(ask.status, 200);
  const actionId = ask.body.pending_approvals[0].action_id;
  assert.equal((await call(`/api/actions/${actionId}/approve`, tok('demo1_staff'), { method: 'POST' })).status, 403);
  assert.equal((await call(`/api/actions/${actionId}/approve`, tok('demo2_manager'), { method: 'POST' })).status, 404);
  const ok = await call(`/api/actions/${actionId}/approve`, tok('demo1_manager'), { method: 'POST' });
  assert.equal(ok.body.status, 'succeeded');
  const tx = await call(`/api/transactions/${env.seed.transactions.txRenew.id}`, tok('demo1_viewer'));
  assert.equal(tx.body.transaction.status, 'under_review');
  assert.equal((await call(`/api/actions/${actionId}/approve`, tok('demo1_manager'), { method: 'POST' })).status, 409);
});

test('إدخال مستند بتاريخ هجري، ثم تجديده يلغي تذكيراته المعلقة', async () => {
  const doc = await call(`/api/clients/${env.seed.clients.fahd.id}/documents`, tok('demo1_staff'), {
    method: 'POST', body: { doc_type: 'exit_reentry_visa', expiry_date: '1448/06/17', expiry_calendar: 'hijri', data_source: 'absher' },
  });
  assert.equal(doc.status, 200);
  assert.equal(doc.body.expiry_date, '2026-11-27');
  assert.equal(doc.body.days_left, 5);
  const run = await call('/api/automation/followups', tok('demo1_automation'), { method: 'POST' });
  assert.equal(run.status, 200);
  const before = (await call('/api/reminders?status=pending_approval', tok('demo1_staff'))).body.filter((r) => r.document_id === doc.body.document_id);
  assert.equal(before.length, 1);
  const renewed = await call(`/api/documents/${doc.body.document_id}/renew`, tok('demo1_staff'), { method: 'POST', body: { expiry_date: '2027-03-01', data_source: 'absher', verified_at: '2026-11-22' } });
  assert.equal(renewed.body.status, 'valid');
  const r = (await call('/api/reminders', tok('demo1_staff'))).body.find((x) => x.id === before[0].id);
  assert.equal(r.status, 'cancelled');
});

test('أخطاء الإدخال مفهومة: نوع مستند غير معروف، تاريخ هجري غير موجود، حقول زائدة', async () => {
  const id = env.seed.clients.fahd.id;
  const a = await call(`/api/clients/${id}/documents`, tok('demo1_staff'), { method: 'POST', body: { doc_type: 'xyz', expiry_date: '2027-01-01' } });
  assert.equal(a.status, 400);
  const b = await call(`/api/clients/${id}/documents`, tok('demo1_staff'), { method: 'POST', body: { doc_type: 'iqama', expiry_date: '1448/01/30', expiry_calendar: 'hijri' } });
  assert.equal(b.status, 400);
  assert.match(b.body.error.message, /غير موجود في تقويم أم القرى/);
  const c = await call('/api/clients', tok('demo1_staff'), { method: 'POST', body: { kind: 'individual', name: 'س', role: 'owner' } });
  assert.equal(c.status, 400);
});

test('صلاحيات الأتمتة والسجل: الموظف لا يشغّل المتابعة ولا يقرأ سجل التدقيق', async () => {
  assert.equal((await call('/api/automation/followups', tok('demo1_staff'), { method: 'POST' })).status, 403);
  assert.equal((await call('/api/audit', tok('demo1_staff'))).status, 403);
  const audit = await call('/api/audit', tok('demo1_owner'));
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some((a) => a.event === 'action.succeeded'));
});

test('تشغيل التقييم: للمالك فقط، ويرفض بوضوح إن كان النموذج محاكى', async () => {
  assert.equal((await call('/api/admin/evals', tok('demo1_manager'), { method: 'POST' })).status, 403);
  const r = await call('/api/admin/evals', tok('demo1_owner'), { method: 'POST' });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /النموذج الحقيقي/);
});
