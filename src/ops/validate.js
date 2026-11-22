// مدقق مبسط لمخططات JSON المستخدمة في الأدوات (بدون مكتبات خارجية).
// يدعم: type, properties, required, additionalProperties:false, enum, minLength, maxLength,
// pattern, minimum, maximum, items, maxItems, format: 'date'.
import { isIsoDate } from './dates.js';

export function validate(schema, value, path = 'input') {
  const errors = [];
  check(schema, value, path, errors);
  return errors;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(s, v, p, errors) {
  if (!s) return;
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : null;
  const t = typeOf(v);
  if (types && !types.some((x) => x === t || (x === 'number' && t === 'integer'))) {
    errors.push(`${p}: النوع المتوقع ${types.join('|')} والمستلم ${t}`);
    return;
  }
  if (s.enum && !s.enum.includes(v)) errors.push(`${p}: قيمة غير مسموحة (${JSON.stringify(v)})؛ المسموح: ${s.enum.join(', ')}`);
  if (t === 'string') {
    if (s.minLength !== undefined && v.trim().length < s.minLength) errors.push(`${p}: نص قصير جداً`);
    if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${p}: نص أطول من ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${p}: صيغة غير صحيحة`);
    if (s.format === 'date' && !isIsoDate(v)) errors.push(`${p}: تاريخ غير صالح (YYYY-MM-DD)`);
  }
  if (t === 'integer' || t === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${p}: أقل من ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${p}: أكبر من ${s.maximum}`);
  }
  if (t === 'array') {
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p}: عناصر أكثر من ${s.maxItems}`);
    v.forEach((item, i) => check(s.items, item, `${p}[${i}]`, errors));
  }
  if (t === 'object') {
    for (const r of s.required || []) if (v[r] === undefined) errors.push(`${p}.${r}: حقل مطلوب`);
    for (const [k, val] of Object.entries(v)) {
      if (s.properties?.[k]) check(s.properties[k], val, `${p}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${p}.${k}: حقل غير معروف`);
    }
  }
}
