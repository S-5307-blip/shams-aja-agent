// واجهة HTTP لوكيل العمليات + الواجهة الرسومية الثابتة.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { can } from './permissions.js';
import { validate } from './validate.js';
import { OpsError } from './util.js';
import { listAudit } from './audit.js';
import { audit } from './audit.js';
import { normalizeDateInput } from './dates.js';
import { describeDocument } from './tools/definitions.js';
import { runFollowups } from './followups.js';
import { statusLabel } from './workflow.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/ops');
const ID = { type: 'string', pattern: '^[a-z]+_[a-z0-9]+$', maxLength: 64 };

const HTTP = { unauthorized: 401, forbidden: 403, not_found: 404, invalid_input: 400, invalid_date: 400, missing_data: 422, conflict: 409, no_change: 409, invalid_transition: 409, opted_out: 409 };

const SCHEMAS = {
  client: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['individual', 'business'] },
      name: { type: 'string', minLength: 2, maxLength: 150 },
      phone: { type: 'string', pattern: '^9665\\d{8}$' },
      email: { type: 'string', maxLength: 150 },
      id_last4: { type: 'string', pattern: '^\\d{4}$' },
      cr_number: { type: 'string', pattern: '^\\d{10}$' },
      preferred_channel: { type: 'string', enum: ['whatsapp', 'manual'] },
      language: { type: 'string', maxLength: 5 },
      opt_out_reminders: { type: 'boolean' },
      notes: { type: 'string', maxLength: 1000 },
      external_ref: { type: 'string', maxLength: 64 },
    },
    required: ['kind', 'name'],
    additionalProperties: false,
  },
  document: {
    type: 'object',
    properties: {
      doc_type: { type: 'string', maxLength: 40 },
      label: { type: 'string', maxLength: 150 },
      holder_name: { type: 'string', maxLength: 150 },
      number_last4: { type: 'string', pattern: '^\\d{4}$' },
      expiry_date: { type: 'string', maxLength: 12 },
      expiry_calendar: { type: 'string', enum: ['gregorian', 'hijri'] },
      data_source: { type: 'string', enum: ['manual', 'absher', 'muqeem', 'qiwa', 'business_sa', 'client', 'document'] },
      verified_at: { type: 'string', format: 'date' },
    },
    required: ['doc_type', 'expiry_date'],
    additionalProperties: false,
  },
  renew: {
    type: 'object',
    properties: {
      expiry_date: { type: 'string', maxLength: 12 },
      expiry_calendar: { type: 'string', enum: ['gregorian', 'hijri'] },
      data_source: { type: 'string', enum: ['manual', 'absher', 'muqeem', 'qiwa', 'business_sa', 'client', 'document'] },
      verified_at: { type: 'string', format: 'date' },
    },
    required: ['expiry_date', 'data_source'],
    additionalProperties: false,
  },
  transaction: {
    type: 'object',
    properties: {
      client_id: ID,
      service_id: { type: 'string', maxLength: 80 },
      title: { type: 'string', minLength: 3, maxLength: 200 },
      due_date: { type: 'string', format: 'date' },
      received_docs: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 200 } },
      external_ref: { type: 'string', maxLength: 64 },
    },
    required: ['client_id', 'title'],
    additionalProperties: false,
  },
};

export function createApp({ store, kb, ops, agent, config }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/ops', express.static(PUBLIC_DIR));
  app.get('/', (_req, res) => res.redirect('/ops/'));

  const api = express.Router();
  api.use((req, _res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const user = store.userByToken(token);
    if (!user) return next(new OpsError('unauthorized', 'رمز الدخول غير صالح.'));
    req.user = user;
    next();
  });
  const need = (perm) => (req, _res, next) => (can(req.user.role, perm) ? next() : next(new OpsError('forbidden', 'ليست لديك صلاحية لهذه العملية.')));
  const body = (schema) => (req, _res, next) => {
    const errs = validate(schema, req.body ?? {});
    return errs.length ? next(new OpsError('invalid_input', errs.join('؛ '))) : next();
  };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => res.json(data)).catch(next);
  const T = (req) => req.user.tenant_id;
  const ctx = (req) => ops.ctxFor(req.user);

  api.get('/me', wrap((req) => ({ user: req.user, tenant: store.getTenant(T(req)), today: ctx(req).today })));

  // ===== الوكيل =====
  api.post('/agent/ask', need('agent.ask'), wrap((req) => agent.ask(req.user, { request: req.body?.request, requestId: req.body?.request_id })));
  api.get('/runs/:id', need('read'), wrap((req) => {
    const run = store.getRun(T(req), req.params.id);
    if (!run) throw new OpsError('not_found', 'التشغيل غير موجود.');
    return run;
  }));

  // ===== العملاء والمستندات والمعاملات =====
  api.get('/clients', need('read'), wrap((req) => (req.query.q ? store.findClients(T(req), { query: req.query.q, limit: 50 }) : store.listClients(T(req)))));
  api.post('/clients', need('data.write'), body(SCHEMAS.client), wrap((req) => {
    const c = store.createClient(T(req), req.body);
    audit(store.db, { tenantId: T(req), userId: req.user.id, event: 'client.created', detail: { client_id: c.id } });
    return c;
  }));
  api.get('/clients/:id', need('read'), wrap((req) => {
    const c = store.getClient(T(req), req.params.id);
    if (!c) throw new OpsError('not_found', 'العميل غير موجود.');
    const cx = ctx(req);
    return {
      client: c,
      documents: store.clientDocuments(T(req), c.id).map((d) => describeDocument(cx, d)),
      transactions: store.clientTransactions(T(req), c.id).map((t) => ({ ...t, status_label: statusLabel(t.status) })),
    };
  }));
  api.post('/clients/:id/documents', need('data.write'), body(SCHEMAS.document), wrap((req) => {
    if (!kb.docType(req.body.doc_type)) throw new OpsError('invalid_input', `نوع مستند غير معروف. المتاح: ${Object.keys(kb.docTypes).join(', ')}`);
    const date = normalizeDateInput(req.body.expiry_date, req.body.expiry_calendar);
    const d = store.addDocument(T(req), { ...req.body, client_id: req.params.id, expiry_date: date.iso, expiry_original: date.original, expiry_calendar: date.calendar });
    audit(store.db, { tenantId: T(req), userId: req.user.id, event: 'document.created', detail: { document_id: d.id, doc_type: d.doc_type } });
    return describeDocument(ctx(req), d);
  }));
  // تجديد: تاريخ انتهاء جديد مع مصدره؛ التذكيرات المعلقة للتاريخ القديم تُلغى في التشغيل التالي للمتابعة (وفوراً هنا)
  api.post('/documents/:id/renew', need('data.write'), body(SCHEMAS.renew), wrap((req) => {
    const date = normalizeDateInput(req.body.expiry_date, req.body.expiry_calendar);
    const d = store.tx(() => {
      const updated = store.updateDocumentExpiry(T(req), req.params.id, { ...req.body, expiry_date: date.iso, expiry_original: date.original, expiry_calendar: date.calendar });
      store.cancelPendingReminders(T(req), 'document_id', updated.id, { exceptExpiry: updated.expiry_date });
      store.cancelOpenTasks(T(req), 'document_id', updated.id);
      return updated;
    });
    audit(store.db, { tenantId: T(req), userId: req.user.id, event: 'document.renewed', detail: { document_id: d.id, expiry_date: d.expiry_date, data_source: d.data_source } });
    return describeDocument(ctx(req), d);
  }));
  api.get('/documents/expiring', need('read'), wrap(async (req) => {
    const cx = ctx(req);
    const days = Math.min(365, Math.max(0, Number(req.query.days ?? 60)));
    const r = await ops.executeTool(cx, 'list_expiring_documents', { within_days: days });
    if (!r.ok) throw new OpsError(r.error.code, r.error.message);
    return r.data;
  }));
  api.post('/transactions', need('data.write'), body(SCHEMAS.transaction), wrap((req) => {
    if (req.body.service_id && !kb.service(req.body.service_id)) throw new OpsError('invalid_input', 'الخدمة غير موجودة في الكتالوج.');
    return store.createTransaction(T(req), { ...req.body, actor: req.user.id });
  }));
  api.get('/transactions/:id', need('read'), wrap(async (req) => {
    const r = await ops.executeTool(ctx(req), 'get_transaction', { transaction_id: req.params.id });
    if (!r.ok) throw new OpsError(r.error.code, r.error.message);
    return r.data;
  }));

  // ===== المهام والتذكيرات والاعتمادات =====
  api.get('/tasks', need('read'), wrap((req) => store.listTasks(T(req), { status: req.query.status || 'open' })));
  api.post('/tasks/:id/:op(complete|cancel)', need('task.write'), wrap((req) => {
    const status = req.params.op === 'complete' ? 'done' : 'cancelled';
    if (!store.setTaskStatus(T(req), req.params.id, status)) throw new OpsError('not_found', 'المهمة غير موجودة.');
    audit(store.db, { tenantId: T(req), userId: req.user.id, event: `task.${status}`, detail: { task_id: req.params.id } });
    return store.getTask(T(req), req.params.id);
  }));
  api.get('/reminders', need('read'), wrap((req) => store.listReminders(T(req), { status: req.query.status || 'all' })));
  api.post('/reminders/:id/mark-sent', wrap((req) => ops.markReminderSent(req.user, req.params.id)));
  api.get('/actions', need('read'), wrap((req) => store.listActions(T(req), { status: req.query.status || 'pending_approval' })));
  api.post('/actions/:id/approve', wrap((req) => ops.approveAction(req.user, req.params.id)));
  api.post('/actions/:id/reject', wrap((req) => ops.rejectAction(req.user, req.params.id, String(req.body?.reason || '').slice(0, 300))));

  // ===== الأتمتة (n8n / cron) =====
  api.post('/automation/followups', need('automation.run'), wrap((req) => runFollowups({ store, kb, ops, config, tenantId: T(req), actor: req.user })));

  // ===== المعرفة والسجل =====
  api.get('/kb/search', need('read'), wrap((req) => kb.search(String(req.query.q || ''), { limit: 10 })));
  api.get('/audit', need('audit.read'), wrap((req) => listAudit(store.db, T(req), { runId: req.query.run_id, limit: 200 })));

  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof OpsError) return res.status(HTTP[err.code] || 500).json({ error: { code: err.code, message: err.message } });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'invalid_json', message: 'صيغة JSON غير صحيحة.' } });
    console.error('[http]', err);
    res.status(500).json({ error: { code: 'internal_error', message: 'خطأ داخلي في الخادم.' } });
  });
  return app;
}
