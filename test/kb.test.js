import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKnowledge, normalizeArabic } from '../src/ops/kb/index.js';

const kb = loadKnowledge();

test('تطبيع النص العربي', () => {
  assert.equal(normalizeArabic('الإقامةُ'), 'الاقامه');
  assert.equal(normalizeArabic('مستشفى'), 'مستشفي');
});

test('كل مدخل معرفة له مصدر وتاريخ تحقق وحالة اعتماد', () => {
  for (const e of kb.entries) {
    assert.ok(e.source?.name, `${e.id} بلا مصدر`);
    assert.match(e.checked_at, /^\d{4}-\d{2}-\d{2}$/, `${e.id} بلا تاريخ تحقق`);
    assert.ok(e.approval, `${e.id} بلا حالة اعتماد`);
  }
});

test('كل نوع مستند يشير لخدمة تجديد موجودة في الكتالوج', () => {
  for (const [key, t] of Object.entries(kb.docTypes)) {
    if (t.renewal_service_id) assert.ok(kb.service(t.renewal_service_id), `${key} → ${t.renewal_service_id}`);
    assert.ok(t.reminder_offsets_days.length > 0);
  }
});

test('الاسترجاع يجد الخدمات بالمرادفات العامية', () => {
  const ids = (q) => kb.search(q, { limit: 3 }).map((r) => r.id);
  assert.ok(ids('تجديد الإقامة').includes('svc:residency-002'));
  assert.ok(ids('نقل كفالة عامل').includes('svc:hr-001'));
  assert.ok(ids('التأكيد السنوي للسجل التجاري').includes('doc:cr_annual_confirmation'));
  assert.ok(ids('العميل يطلب خصم').includes('case-discount-request'));
});

test('لا نتائج لطلب خارج المعرفة (لا اختلاق)', () => {
  assert.deepEqual(kb.search('تأشيرة سياحية لليابان'), []);
});

test('المعلومة غير الموثقة رسمياً معلّمة unverified', () => {
  assert.equal(kb.get('fact:iqama:1').approval, 'unverified');
  assert.equal(kb.get('fact:work_permit:1').approval, 'approved');
});
