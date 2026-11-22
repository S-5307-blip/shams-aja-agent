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

// ===== فهم التعبيرات الزمنية (عامية سعودية + هجري + ميلادي) بقواعد ثابتة =====
const WEEKDAYS = ['الاحد', 'الاثنين', 'الثلاثاء', 'الاربعاء', 'الخميس', 'الجمعه', 'السبت']; // 0 = الأحد
const NUM_WORDS = { واحد: 1, يوم: 1, اثنين: 2, ثنين: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5, ست: 6, سته: 6, سبع: 7, سبعه: 7, ثمان: 8, ثمانيه: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10 };
const UNITS = [
  [/^(يومين)$/, 2, 'day'], [/^(اسبوعين)$/, 2, 'week'], [/^(شهرين)$/, 2, 'month'], [/^(سنتين)$/, 2, 'year'],
  [/^(يوم|ايام)$/, null, 'day'], [/^(اسبوع|اسابيع)$/, null, 'week'], [/^(شهر|شهور|اشهر)$/, null, 'month'], [/^(سنه|سنوات|سنين)$/, null, 'year'],
];
const HIJRI_MONTHS = [
  [/^محرم/, 1], [/^صفر/, 2], [/^ربيع (الاول|اول)/, 3], [/^ربيع (الاخر|الثاني|ثاني|آخر)/, 4], [/^جمادي (الاولي|الاول|اولي)/, 5],
  [/^جمادي (الاخره|الاخر|الثانيه|الثاني|اخره)/, 6], [/^رجب/, 7], [/^شعبان/, 8], [/^رمضان/, 9], [/^شوال/, 10], [/^ذو القعده|^ذي القعده/, 11], [/^ذو الحجه|^ذي الحجه/, 12],
];
const GREG_MONTHS = { يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, مايو: 5, يونيو: 6, يوليو: 7, اغسطس: 8, سبتمبر: 9, اكتوبر: 10, نوفمبر: 11, ديسمبر: 12 };

const normDate = (s) => String(s || '').trim().toLowerCase()
  .replace(/[ً-ٟـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/(\d)\s*(ه|م)$/, '$1').replace(/\s+/g, ' ').trim();

export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const weekdayOf = (iso) => new Date(toUtc(iso)).getUTCDay();
const weekdayName = (iso) => new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { weekday: 'long', timeZone: 'UTC' }).format(new Date(toUtc(iso)));
const endOfMonth = (iso) => addDays(addMonths(`${iso.slice(0, 8)}01`, 1), -1);

function shift(today, n, unit) {
  if (unit === 'day') return addDays(today, n);
  if (unit === 'week') return addDays(today, n * 7);
  if (unit === 'month') return addMonths(today, n);
  return addMonths(today, n * 12);
}

// يعيد { iso, from?, to?, interpretation } أو يرمي invalid_date إن لم يُفهم التعبير
export function parseDateExpression(expression, today) {
  const s = normDate(expression);
  if (!s) throw new OpsError('invalid_date', 'التعبير الزمني فارغ.');
  const one = (iso, interpretation) => ({ iso, interpretation });
  const range = (from, to, interpretation) => ({ iso: from, from, to, interpretation });

  if (/^(اليوم|الحين|الان)$/.test(s)) return one(today, 'اليوم');
  if (/^(بكره|بكرا|غدا|بكرة)$/.test(s)) return one(addDays(today, 1), 'غداً');
  if (/^(بعد بكره|بعد بكرا|بعد غد)$/.test(s)) return one(addDays(today, 2), 'بعد غد');
  if (/^(امس|البارح|البارحه)$/.test(s)) return one(addDays(today, -1), 'أمس');
  if (/^(اول امس|قبل امس)$/.test(s)) return one(addDays(today, -2), 'أول أمس');

  // بعد/قبل/خلال N وحدة
  let m = /^(بعد|قبل|خلال) (.+)$/.exec(s);
  if (m) {
    const sign = m[1] === 'قبل' ? -1 : 1;
    const parts = m[2].split(' ');
    let n = null;
    let unitWord = parts.at(-1);
    if (parts.length === 1) n = null;
    else n = /^\d+$/.test(parts[0]) ? Number(parts[0]) : NUM_WORDS[parts[0]] ?? null;
    for (const [re, fixed, unit] of UNITS) {
      if (re.test(unitWord)) {
        const count = fixed ?? (parts.length === 1 ? 1 : n);
        if (!count) break;
        const target = shift(today, sign * count, unit);
        const phrase = fixed || parts.length === 1 ? unitWord : `${count} ${unitWord}`;
        if (m[1] === 'خلال') return range(today, target, `من اليوم حتى ${phrase}`);
        return one(target, `${m[1]} ${phrase}`);
      }
    }
  }

  if (/^(الاسبوع|الاسبوع) (الجاي|القادم|الياي)$/.test(s)) {
    const nextSunday = addDays(today, 7 - weekdayOf(today));
    return range(nextSunday, addDays(nextSunday, 6), 'الأسبوع القادم (الأحد إلى السبت)');
  }
  if (/^(هذا الاسبوع|الاسبوع هذا)$/.test(s)) {
    const sunday = addDays(today, -weekdayOf(today));
    return range(today, addDays(sunday, 6), 'بقية هذا الأسبوع');
  }
  if (/^(نهايه|اخر) (الشهر)( هذا)?$/.test(s)) return one(endOfMonth(today), 'نهاية الشهر الميلادي الحالي');
  if (/^(الشهر|الشهر) (الجاي|القادم|الياي)$/.test(s)) {
    const first = addMonths(`${today.slice(0, 8)}01`, 1);
    return range(first, endOfMonth(first), 'الشهر الميلادي القادم');
  }
  if (/^(هذا الشهر|الشهر هذا)$/.test(s)) return range(today, endOfMonth(today), 'بقية الشهر الميلادي الحالي');
  if (/^(بدايه|اول) (الشهر) (الجاي|القادم)$/.test(s)) return one(addMonths(`${today.slice(0, 8)}01`, 1), 'أول الشهر الميلادي القادم');

  // أيام الأسبوع: «الخميس» أو «الخميس الجاي»
  m = /^(يوم )?(الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت)( (الجاي|القادم|الياي))?$/.exec(s);
  if (m) {
    const target = WEEKDAYS.indexOf(m[2]);
    let diff = (target - weekdayOf(today) + 7) % 7;
    if (diff === 0) diff = 7;
    return one(addDays(today, diff), `${m[2]} القادم`);
  }

  // تواريخ رقمية
  m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s) || null;
  let y, mo, d;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s))) [y, mo, d] = [+m[3], +m[2], +m[1]];
  if (y) {
    if (y >= 1300 && y <= 1600) return one(hijriToIso(y, mo, d), `${y}/${mo}/${d} هجري`);
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!isIsoDate(iso)) throw new OpsError('invalid_date', `تاريخ غير صالح: ${expression}`);
    return one(iso, 'تاريخ ميلادي');
  }

  // «١٥ رجب» أو «١٥ رجب ١٤٤٨» أو «٣ ديسمبر» أو «٣ ديسمبر ٢٠٢٧»
  m = /^(\d{1,2}) (.+?)( (\d{4}))?$/.exec(s);
  if (m) {
    const day = +m[1];
    const name = m[2];
    const year = m[4] ? +m[4] : null;
    for (const [re, month] of HIJRI_MONTHS) {
      if (re.test(name)) {
        if (year) return one(hijriToIso(year, month, day), `${day} ${name} ${year}هـ`);
        const h = toHijri(today);
        let iso = hijriToIso(h.year, month, day);
        if (iso < today) iso = hijriToIso(h.year + 1, month, day);
        return one(iso, `${day} ${name} القادم (هجري)`);
      }
    }
    if (GREG_MONTHS[name]) {
      const mm = String(GREG_MONTHS[name]).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      let iso = `${year || today.slice(0, 4)}-${mm}-${dd}`;
      if (!isIsoDate(iso)) throw new OpsError('invalid_date', `تاريخ غير صالح: ${expression}`);
      if (!year && iso < today) iso = `${Number(today.slice(0, 4)) + 1}-${mm}-${dd}`;
      return one(iso, `${day} ${name}${year ? ` ${year}` : ' القادم'} (ميلادي)`);
    }
  }
  throw new OpsError('invalid_date', `لم أفهم التعبير الزمني «${expression}». اكتبه مثل: بكرة، بعد ٣ أيام، الخميس الجاي، ١٥ رجب، 2026-12-01.`);
}

export function describeDate(iso, today) {
  return { date: iso, hijri: formatHijri(iso), weekday: weekdayName(iso), days_from_today: daysBetween(today, iso) };
}
