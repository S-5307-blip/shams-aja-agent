import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, TODAY } from './helpers.js';
import { runFollowups } from '../src/ops/followups.js';
import { addDays } from '../src/ops/dates.js';

const T = 'ten_demo1';
const run = (env) => runFollowups({ ...env, tenantId: T });

test('المتابعة: تذكير واحد لكل مستند داخل نافذة التذكير، ومهام داخلية، وتحديث الحالات', async () => {
  const env = setup();
  const s = await run(env);
  assert.equal(s.errors.length, 0);
  // fahd iqama 25d, worker iqama 10d, work permit 45d, cr 20d, insurance -3d → 5 ؛ salem (موقف) يُتخطى ؛ الجواز 400d خارج النافذة
  assert.equal(s.reminders_created, 5);
  assert.equal(s.reminders_skipped_opt_out, 1);
  const docs = env.seed.docs;
  assert.equal(env.store.getDocument(T, docs.insurance.id).status, 'expired');
  assert.equal(env.store.getDocument(T, docs.workerIqama.id).status, 'expiring');
  assert.equal(env.store.getDocument(T, docs.passport.id).status, 'valid');
  // كل تذكير ينتظر اعتماداً ومرتبط بإجراء
  for (const r of env.store.listReminders(T)) {
    assert.equal(r.status, 'pending_approval');
    assert.ok(env.store.getAction(T, r.action_id));
  }
  // العميل الموقف للرسائل له مهمة داخلية بدل التذكير
  const salemTask = env.store.listTasks(T).find((t) => t.document_id === docs.salemIqama.id);
  assert.match(salemTask.details, /أوقف الرسائل/);
  // المعاملة المتوقفة ٩ أيام لها مهمة متابعة تذكر النواقص
  const stale = env.store.listTasks(T).find((t) => t.transaction_id === env.seed.transactions.txTransfer.id);
  assert.match(stale.details, /النواقص/);
});

test('المتابعة: إعادة التشغيل لا تكرر المهام ولا التذكيرات', async () => {
  const env = setup();
  const first = await run(env);
  const second = await run(env);
  assert.equal(second.reminders_created, 0);
  assert.equal(second.tasks_created, 0);
  assert.equal(second.reminders_existing, first.reminders_created);
  assert.equal(env.store.listReminders(T).length, first.reminders_created);
});

test('المتابعة: المرحلة التالية تُنشئ تذكيراً جديداً واحداً فقط (لا تذكيرات متراكمة لمراحل فائتة)', async () => {
  const env = setup();
  const doc = env.seed.docs.workerIqama; // 10 أيام → مرحلة 14
  await run(env);
  const stageKeys = () => env.store.listReminders(T).filter((r) => r.document_id === doc.id).map((r) => r.dedupe_key.split(':').pop());
  assert.deepEqual(stageKeys(), ['14']);
  // بعد ٤ أيام (٦ أيام متبقية) → مرحلة 7
  const later = setup();
  later.store.db.prepare('UPDATE documents SET expiry_date = ? WHERE id = ?').run(addDays(TODAY, 6), later.seed.docs.workerIqama.id);
  await runFollowups({ ...later, tenantId: T });
  const keys = later.store.listReminders(T).filter((r) => r.document_id === later.seed.docs.workerIqama.id).map((r) => r.dedupe_key.split(':').pop());
  assert.deepEqual(keys, ['7']);
});

test('المتابعة: تجديد المستند (تاريخ جديد) يلغي التذكيرات المعلقة للتاريخ القديم ولا ينشئ تذكيراً جديداً', async () => {
  const env = setup();
  await run(env);
  const doc = env.seed.docs.workerIqama;
  const pending = env.store.listReminders(T).find((r) => r.document_id === doc.id);
  env.store.updateDocumentExpiry(T, doc.id, { expiry_date: addDays(TODAY, 365), data_source: 'muqeem', verified_at: TODAY });
  const s = await run(env);
  assert.equal(s.old_reminders_cancelled, 1);
  assert.equal(env.store.getReminder(T, pending.id).status, 'cancelled');
  assert.equal(env.store.getAction(T, pending.action_id).status, 'rejected');
  assert.equal(env.store.getDocument(T, doc.id).status, 'valid');
});

test('المتابعة: لا تخلط بين المنشآت', async () => {
  const env = setup();
  await run(env);
  assert.equal(env.store.listReminders('ten_demo2').length, 0);
  const s2 = await runFollowups({ ...env, tenantId: 'ten_demo2' });
  assert.equal(s2.reminders_created, 1);
  assert.equal(env.store.listReminders(T).length, 5);
});
