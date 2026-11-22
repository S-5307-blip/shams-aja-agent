// يولّد knowledge/services.json من مصدرين قائمين في المشروع:
//   1) knowledge.json  (الخدمات المنشورة المعتمدة لوكيل واتساب)
//   2) services-catalog.csv (كتالوج المكتب الكامل: رابط الجهة، النبذة، طريقة التسعير)
// لا يغيّر أياً من المصدرين. شغّله بعد أي تعديل عليهما: npm run kb:build
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DATE = '2026-10-20'; // تاريخ ملفات الكتالوج في الحزمة الأصلية

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((v) => v.trim()));
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const knowledge = JSON.parse(fs.readFileSync(path.join(root, 'knowledge.json'), 'utf8'));
const csv = parseCsv(fs.readFileSync(path.join(root, 'services-catalog.csv'), 'utf8'));
const byId = new Map(csv.map((r) => [r['معرّف الخدمة'], r]));

const services = knowledge.services.map((s) => {
  const row = byId.get(s.id) || {};
  const hasReq = Array.isArray(s.requirements) && s.requirements.length > 0;
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    subcategory: s.subcategory,
    status: s.status, // available | eligibility_review | via_partner
    authority: s.authority,
    authority_url: row['رابط المصدر'] || null,
    summary: row['نبذة'] || null,
    audience: s.audience || null,
    also_covers: s.alsoCovers || [],
    requirements: s.requirements || [],
    steps: s.steps || [],
    duration: s.duration || null,
    pricing: {
      method: row['طريقة التسعير'] || 'يحدد بعد المراجعة',
      office_fee: null, // لا تُحمَّل الأسعار حتى يعتمدها المالك (reference-prices.json)
      approval: 'needs_approval',
    },
    provenance: {
      source: 'كتالوج خدمات المكتب (knowledge.json + services-catalog.csv)',
      source_kind: 'office_catalog',
      checked_at: CATALOG_DATE,
      // قرار النشر في الكتالوج = «ينشر» → اسم الخدمة وتوفرها معتمدان من المكتب
      listing_approval: 'approved',
      // المتطلبات والخطوات صاغها المكتب ولم تُطابق مع صفحة الجهة الرسمية بعد
      requirements_approval: hasReq ? 'office_unverified' : 'missing',
    },
  };
});

const out = {
  _meta: {
    description: 'خدمات المكتب المنشورة. مولّد آلياً بـ scripts/build-kb.js — لا تعدّله يدوياً، عدّل المصدر ثم أعد البناء.',
    generated_from: ['knowledge.json', 'services-catalog.csv'],
    count: services.length,
    with_requirements: services.filter((s) => s.requirements.length).length,
  },
  services,
};
fs.writeFileSync(path.join(root, 'knowledge/services.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`knowledge/services.json: ${services.length} خدمة، منها ${out._meta.with_requirements} بمتطلبات موثقة في الكتالوج.`);
