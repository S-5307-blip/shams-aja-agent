import crypto from 'node:crypto';

export const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const nowIso = () => new Date().toISOString();
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// JSON بترتيب مفاتيح ثابت (لمفاتيح منع التكرار)
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const parseJson = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// خطأ له رمز مفهوم يُعرض للمستخدم بدلاً من تفاصيل داخلية
export class OpsError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

export async function withTimeout(promiseOrFn, ms, label = 'operation') {
  let timer;
  const p = typeof promiseOrFn === 'function' ? Promise.resolve().then(promiseOrFn) : promiseOrFn;
  return Promise.race([
    p,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new OpsError('timeout', `انتهت المهلة (${ms}ms) أثناء: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ===== إخفاء البيانات الحساسة قبل التسجيل =====
const SENSITIVE = /(token|secret|password|api_?key|authorization)/i;
const PERSONAL = /(phone|mobile|email|national|iqama|id_number|number_last4|id_last4)/i;

export function maskValue(v) {
  const s = String(v);
  if (s.length <= 4) return '***';
  return `***${s.slice(-2)}`;
}

export function redact(value, depth = 0) {
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE.test(k)) out[k] = '[محجوب]';
      else if (PERSONAL.test(k) && v != null && typeof v !== 'object') out[k] = maskValue(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') {
    // أرقام جوال سعودية داخل النص
    const masked = value.replace(/(\+?966|0)?5\d{8}/g, (m) => `***${m.slice(-2)}`);
    return masked.length > 500 ? `${masked.slice(0, 500)}…` : masked;
  }
  return value;
}
