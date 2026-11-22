// تحميل قاعدة المعرفة والبحث فيها بالكلمات مع تطبيع عربي.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../knowledge');

const STOP = new Set(
  'من في على الى إلى عن ما ماذا هل كم كيف متى لماذا او أو و ثم مع هذا هذه ذلك التي الذي عند لدى كل بعد قبل اي أي ان أن لا لم لن هو هي هم انا أنا نحن انت أنت يا تم ابي ابغى ابغي ودي اريد أريد ممكن لو عميل العميل معاملة معامله المعاملة نواقص النواقص يبي'
    .split(' ')
    .map((w) => normalizeArabic(w))
);

// مرادفات شائعة في المكتب ← مصطلحات الكتالوج
const SYNONYMS = {
  اقامه: ['مقيم', 'اقامه'],
  اقامات: ['مقيم', 'اقامه'],
  الاقامه: ['مقيم', 'اقامه'],
  جوازات: ['مقيم', 'جواز'],
  تجديد: ['تجديد'],
  سجل: ['سجل'],
  رخصه: ['رخصه'],
  تامين: ['تامين'],
  طبي: ['طبي', 'صحي'],
  نقل: ['نقل'],
  كفاله: ['نقل', 'خدمات'],
  خروج: ['خروج'],
  زياره: ['زياره'],
  ضريبه: ['ضريبه'],
  زكاه: ['زكاه'],
  تاكيد: ['تاكيد'],
  خصم: ['خصم', 'خصما', 'خصومات', 'استثناء'],
  تخفيض: ['خصم', 'خصما', 'خصومات'],
  غرامه: ['غرامه', 'غرامات'],
};

export function normalizeArabic(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '') // التشكيل والتطويل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}

function stem(t) {
  for (const p of ['وال', 'بال', 'كال', 'فال', 'لل', 'ال']) {
    if (t.startsWith(p) && t.length - p.length >= 3) return t.slice(p.length);
  }
  if (t.startsWith('و') && t.length > 4) return t.slice(1);
  return t;
}

export function tokenize(s) {
  return normalizeArabic(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(stem)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

export function loadKnowledge(dir = DEFAULT_DIR) {
  const services = read(dir, 'services.json').services;
  const docTypes = read(dir, 'document-types.json');
  const policies = read(dir, 'policies.json').policies;
  const procedures = read(dir, 'procedures.json').procedures;
  const faq = read(dir, 'faq.json').faq;
  const cases = read(dir, 'cases.json').cases;
  const business = read(dir, 'business.json');

  const entries = [];
  for (const s of services) {
    entries.push({
      id: `svc:${s.id}`,
      type: 'service',
      title: s.name,
      fields: { title: s.name, alt: s.also_covers.join(' '), cat: `${s.category} ${s.subcategory} ${s.authority}`, body: `${s.summary || ''} ${s.requirements.join(' ')}` },
      approval: s.provenance.requirements_approval === 'missing' ? 'approved_listing_only' : 'approved_listing_requirements_unverified',
      source: { name: s.provenance.source, url: s.authority_url, kind: s.provenance.source_kind },
      checked_at: s.provenance.checked_at,
      data: s,
    });
  }
  for (const [key, t] of Object.entries(docTypes.types)) {
    entries.push({
      id: `doc:${key}`,
      type: 'document_type',
      title: t.name,
      fields: { title: t.name, cat: t.authority || '', body: t.facts.map((f) => f.text).join(' ') },
      approval: docTypes._meta.offsets_approval,
      source: { name: 'knowledge/document-types.json', kind: 'office' },
      checked_at: '2026-11-22',
      data: { key, ...t },
    });
    t.facts.forEach((f, i) => {
      entries.push({
        id: `fact:${key}:${i + 1}`,
        type: 'fact',
        title: `${t.name}: معلومة نظامية`,
        fields: { title: t.name, body: f.text },
        approval: f.approval,
        source: f.source,
        checked_at: f.checked_at,
        data: f,
      });
    });
  }
  for (const p of policies) entries.push({ id: p.id, type: 'policy', title: p.text.slice(0, 60), fields: { body: p.text }, approval: p.approval, source: p.source, checked_at: p.checked_at, data: p });
  for (const p of procedures) entries.push({ id: p.id, type: 'procedure', title: p.title, fields: { title: p.title, body: p.steps.join(' ') }, approval: p.approval, source: p.source, checked_at: p.checked_at, data: p });
  for (const f of faq) entries.push({ id: f.id, type: 'faq', title: f.q, fields: { title: f.q, body: f.a }, approval: f.approval, source: f.source, checked_at: f.checked_at, data: f });
  for (const c of cases) entries.push({ id: c.id, type: 'case', title: c.situation, fields: { title: c.situation, body: c.resolution }, approval: c.approval, source: c.source, checked_at: c.checked_at, data: c });

  const WEIGHTS = { title: 4, alt: 2.5, cat: 1, body: 1 };
  for (const e of entries) {
    e.index = Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, new Set(tokenize(v))]));
    e.normTitle = normalizeArabic(e.title);
  }

  const servicesById = new Map(services.map((s) => [s.id, s]));

  function search(query, { limit = 5, types, minScore = 3.5, minCoverage = 0.5 } = {}) {
    // كل كلمة في السؤال مجموعة (الكلمة + مرادفاتها). التغطية = نسبة الكلمات التي وُجدت.
    const groups = tokenize(query).map((t) => [...new Set([t, ...(SYNONYMS[t] || [])])]);
    if (!groups.length) return [];
    const nq = normalizeArabic(query).trim();
    const scored = [];
    for (const e of entries) {
      if (types && !types.includes(e.type)) continue;
      let score = 0;
      let matched = 0;
      for (const group of groups) {
        let best = 0;
        for (const [field, set] of Object.entries(e.index)) {
          if (group.some((t) => set.has(t))) best += WEIGHTS[field];
        }
        if (best) { score += best; matched++; }
      }
      if (!score) continue;
      const coverage = matched / groups.length;
      if (groups.length > 1 && coverage < minCoverage) continue;
      score *= coverage + 0.5;
      if (nq.length > 4 && e.normTitle.includes(nq)) score += 6; // تطابق العبارة
      scored.push({ e, score });
    }
    return scored
      .filter((x) => x.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ e, score }) => toResult(e, score));
  }

  function get(id) {
    const e = entries.find((x) => x.id === id);
    return e ? toResult(e) : null;
  }

  return {
    search,
    get,
    entries,
    service: (id) => servicesById.get(id) || null,
    docType: (key) => docTypes.types[key] || null,
    docTypes: docTypes.types,
    business,
    ids: new Set(entries.map((e) => e.id)),
  };
}

function toResult(e, score) {
  return {
    id: e.id,
    type: e.type,
    title: e.title,
    approval: e.approval,
    source: e.source,
    checked_at: e.checked_at,
    ...(score !== undefined ? { score: Math.round(score * 10) / 10 } : {}),
    content: summarize(e),
  };
}

function summarize(e) {
  const d = e.data;
  switch (e.type) {
    case 'service':
      return {
        service_id: d.id, name: d.name, category: d.category, status: d.status, authority: d.authority,
        also_covers: d.also_covers, requirements: d.requirements, steps: d.steps, duration: d.duration,
        pricing: d.pricing.method, requirements_approval: d.provenance.requirements_approval,
      };
    case 'document_type':
      return { key: d.key, name: d.name, renewal_service_id: d.renewal_service_id, reminder_offsets_days: d.reminder_offsets_days, date_meaning: d.date_meaning || 'تاريخ الانتهاء', note: d.note };
    case 'fact':
      return { text: d.text, note: d.note };
    case 'policy':
      return { text: d.text, scope: d.scope };
    case 'procedure':
      return { title: d.title, steps: d.steps };
    case 'faq':
      return { q: d.q, a: d.a };
    case 'case':
      return { situation: d.situation, resolution: d.resolution };
    default:
      return d;
  }
}
