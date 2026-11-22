import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayIn, addDays, daysBetween, toHijri, hijriToIso, normalizeDateInput, isIsoDate } from '../src/ops/dates.js';

test('اليوم بتوقيت الرياض يختلف عن UTC قرب منتصف الليل', () => {
  const lateUtc = new Date('2026-11-22T22:30:00Z'); // 01:30 صباح 23 نوفمبر في الرياض
  assert.equal(todayIn('Asia/Riyadh', lateUtc), '2026-11-23');
  assert.equal(todayIn('UTC', lateUtc), '2026-11-22');
});

test('حساب الأيام والإضافة عبر نهاية السنة والسنة الكبيسة', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(daysBetween('2026-11-22', '2026-12-22'), 30);
  assert.equal(daysBetween('2026-11-22', '2026-11-19'), -3);
});

test('التحويل الهجري (أم القرى) ذهاباً وإياباً لـ ٤٠٠٠ يوم', () => {
  assert.deepEqual(toHijri('2026-11-22'), { year: 1448, month: 6, day: 12 });
  for (let i = 0; i < 4000; i += 7) {
    const iso = addDays('2022-01-01', i);
    const h = toHijri(iso);
    assert.equal(hijriToIso(h.year, h.month, h.day), iso);
  }
});

test('رفض التواريخ غير الصالحة', () => {
  assert.throws(() => hijriToIso(1448, 1, 30), /غير موجود/);
  assert.throws(() => normalizeDateInput('2026-02-30'), /غير صحيحة/);
  assert.equal(isIsoDate('2026-13-01'), false);
});

test('إدخال هجري بأرقام عربية', () => {
  assert.deepEqual(normalizeDateInput('١٤٤٨/٠٦/١٢', 'hijri'), { iso: '2026-11-22', original: '1448/06/12', calendar: 'hijri' });
});
