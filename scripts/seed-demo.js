// بيانات تجريبية وهمية (أسماء وأرقام غير حقيقية) لتجربة الوكيل والواجهة.
// التواريخ نسبية لتاريخ اليوم حتى تظهر التذكيرات دائماً. الرموز تُكتب في data/dev-tokens.json.
// الاستخدام: npm run ops:seed   (يرفض التشغيل إن كانت القاعدة تحتوي منشآت إلا مع --force)
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/ops/config.js';
import { openDb } from '../src/ops/db.js';
import { createStore } from '../src/ops/store.js';
import { addDays, todayIn, toHijri } from '../src/ops/dates.js';

export function seedDemo(store, { today }) {
  const t1 = store.createTenant({ id: 'ten_demo1', name: 'شمس أجا (بيانات تجريبية)' });
  const t2 = store.createTenant({ id: 'ten_demo2', name: 'مكتب آخر (بيانات تجريبية)' });
  const tokens = {};
  for (const [role, name] of [['owner', 'المالك'], ['manager', 'مدير المكتب'], ['staff', 'موظف الاستقبال'], ['viewer', 'مطّلع'], ['automation', 'n8n']]) {
    tokens[`demo1_${role}`] = store.createUser({ tenantId: t1.id, name, role }).token;
  }
  tokens.demo2_manager = store.createUser({ tenantId: t2.id, name: 'مدير المكتب الآخر', role: 'manager' }).token;

  const T = t1.id;
  const fahd = store.createClient(T, { kind: 'individual', name: 'فهد التجريبي', phone: '966500000001', id_last4: '1234' });
  const biz = store.createClient(T, { kind: 'business', name: 'مؤسسة النخبة التجريبية للمقاولات', phone: '966500000002', cr_number: '7000000001' });
  const salem = store.createClient(T, { kind: 'individual', name: 'سالم التجريبي', phone: '966500000003', opt_out_reminders: true, notes: 'طلب إيقاف الرسائل' });

  const h = toHijri(addDays(today, 25));
  const hijriStr = `${h.year}/${String(h.month).padStart(2, '0')}/${String(h.day).padStart(2, '0')}`;
  const docs = {
    fahdIqama: store.addDocument(T, { client_id: fahd.id, doc_type: 'iqama', label: 'إقامة فهد', number_last4: '1234', expiry_date: addDays(today, 25), expiry_original: hijriStr, expiry_calendar: 'hijri', data_source: 'absher', verified_at: `${addDays(today, -3)}T10:00:00Z` }),
    workerIqama: store.addDocument(T, { client_id: biz.id, doc_type: 'iqama', label: 'إقامة عامل', holder_name: 'العامل راجو (تجريبي)', number_last4: '5678', expiry_date: addDays(today, 10), data_source: 'muqeem', verified_at: `${addDays(today, -1)}T09:00:00Z` }),
    workPermit: store.addDocument(T, { client_id: biz.id, doc_type: 'work_permit', holder_name: 'العامل راجو (تجريبي)', expiry_date: addDays(today, 45), data_source: 'qiwa' }),
    cr: store.addDocument(T, { client_id: biz.id, doc_type: 'cr_annual_confirmation', label: 'السجل 7000000001', expiry_date: addDays(today, 20), data_source: 'business_sa' }),
    insurance: store.addDocument(T, { client_id: biz.id, doc_type: 'health_insurance', label: 'وثيقة تأمين الموظفين', expiry_date: addDays(today, -3), data_source: 'document' }),
    salemIqama: store.addDocument(T, { client_id: salem.id, doc_type: 'iqama', expiry_date: addDays(today, 5), data_source: 'client' }),
    passport: store.addDocument(T, { client_id: fahd.id, doc_type: 'passport', expiry_date: addDays(today, 400), data_source: 'document' }),
  };

  const txRenew = store.createTransaction(T, { client_id: fahd.id, service_id: 'residency-002', title: 'تجديد هوية مقيم — فهد', status: 'awaiting_documents', received_docs: ['جواز سفر ساري'] });
  const stale = `${addDays(today, -9)}T08:00:00.000Z`;
  const txTransfer = store.createTransaction(T, { client_id: biz.id, service_id: 'hr-001', title: 'نقل خدمات عامل إلى المؤسسة', status: 'in_progress', received_docs: ['موافقة صاحب العمل الحالي والجديد'], created_at: stale, updated_at: stale });
  store.db.prepare('UPDATE transaction_events SET created_at = ? WHERE transaction_id = ?').run(stale, txTransfer.id);
  const txExtract = store.createTransaction(T, { client_id: biz.id, service_id: 'business-setup-003', title: 'مستخرج سجل تجاري', status: 'new' });

  const other = store.createClient(t2.id, { kind: 'individual', name: 'عميل منشأة أخرى (تجريبي)', phone: '966500000009' });
  store.addDocument(t2.id, { client_id: other.id, doc_type: 'iqama', expiry_date: addDays(today, 7) });

  return { tokens, tenants: [t1, t2], clients: { fahd, biz, salem, other }, docs, transactions: { txRenew, txTransfer, txExtract } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const count = db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
  if (count && !process.argv.includes('--force')) {
    console.error('القاعدة تحتوي بيانات منشآت. لن تُضاف بيانات تجريبية إلا مع --force (ولن يُحذف شيء).');
    process.exit(1);
  }
  const store = createStore(db);
  const { tokens } = store.tx(() => seedDemo(store, { today: todayIn(config.timezone) }));
  const out = path.resolve(path.dirname(config.dbPath), 'dev-tokens.json');
  fs.writeFileSync(out, JSON.stringify(tokens, null, 2));
  console.log(`أُضيفت البيانات التجريبية. رموز الدخول في: ${out}`);
  // لبيئة التجربة على الخادم فقط (لا يوجد وصول لملفات القرص): الرموز تخص منشآت تجريبية وهمية
  if (process.env.SEED_PRINT_TOKENS === '1') console.log(`DEMO_TOKENS ${JSON.stringify(tokens)}`);
}
