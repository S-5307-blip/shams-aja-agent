// حساب التواريخ بقواعد ثابتة (لا يُترك للنموذج).
// التخزين دائماً ميلادي YYYY-MM-DD، والمنطقة الزمنية الافتراضية Asia/Riyadh،
// والتحويل الهجري بتقويم أم القرى (islamic-umalqura) المضمّن في Node.
import { OpsError } from './util.js';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

export function isIsoDate(s) {
  const m = ISO.exec(s || '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

const toUtc = (iso) => {
  if (!isIsoDate(iso)) throw new OpsError('invalid_date', `تاريخ غير صالح: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

// تاريخ اليوم في المنطقة الزمنية المحددة
export function todayIn(timezone = 'Asia/Riyadh', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export const addDays = (iso, n) => fromUtc(toUtc(iso) + n * DAY);
export const daysBetween = (fromIso, toIso) => Math.round((toUtc(toIso) - toUtc(fromIso)) / DAY);

const hijriFmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
  timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
});

export function toHijri(iso) {
  const parts = Object.fromEntries(hijriFmt.formatToParts(new Date(toUtc(iso))).map((p) => [p.type, p.value]));
  return { year: parseInt(parts.year, 10), month: +parts.month, day: +parts.day };
}

export const formatHijri = (iso) => {
  const h = toHijri(iso);
  return `${h.year}/${String(h.month).padStart(2, '0')}/${String(h.day).padStart(2, '0')}هـ`;
};

// هجري (أم القرى) ← ميلادي، بالبحث حول تقدير أولي ثم التحقق العكسي
export function hijriToIso(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || month < 1 || month > 12 || day < 1 || day > 30) {
    throw new OpsError('invalid_date', `تاريخ هجري غير صالح: ${year}/${month}/${day}`);
  }
  const ordinal = (h) => h.year * 360 + (h.month - 1) * 30 + h.day; // ترتيب تقريبي للمقارنة
  const epoch = Date.UTC(622, 6, 19);
  let ms = epoch + Math.round(((year - 1) * 354.367 + (month - 1) * 29.53 + (day - 1)) * DAY);
  for (let i = 0; i < 400; i++) {
    const h = toHijri(fromUtc(ms));
    if (h.year === year && h.month === month && h.day === day) return fromUtc(ms);
    const diff = ordinal({ year, month, day }) - ordinal(h);
    const step = Math.abs(diff) > 3 ? Math.trunc(diff * 0.98) : Math.sign(diff);
    ms += step * DAY;
    // اليوم ٣٠ قد لا يوجد في شهر من ٢٩ يوماً
    if (step === 0) break;
  }
  throw new OpsError('invalid_date', `التاريخ الهجري ${year}/${month}/${day} غير موجود في تقويم أم القرى`);
}

// يقبل "2026-12-01" (ميلادي) أو "1448/06/12" / "1448-06-12" مع calendar='hijri'
export function normalizeDateInput(value, calendar = 'gregorian') {
  const s = String(value || '').trim().replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/هـ?$/, '');
  if (calendar === 'hijri') {
    const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
    if (!m) throw new OpsError('invalid_date', `صيغة التاريخ الهجري غير صحيحة: ${value} (المتوقع 1448/06/12)`);
    return { iso: hijriToIso(+m[1], +m[2], +m[3]), original: s, calendar: 'hijri' };
  }
  if (!isIsoDate(s)) throw new OpsError('invalid_date', `صيغة التاريخ غير صحيحة: ${value} (المتوقع YYYY-MM-DD)`);
  return { iso: s, original: s, calendar: 'gregorian' };
}
