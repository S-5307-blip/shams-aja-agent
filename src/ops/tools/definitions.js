// تعريف أدوات الوكيل. لكل أداة: مخطط مدخلات، صلاحية، نمط تنفيذ، ودالة تنفيذ.
// mode: read = قراءة | write = كتابة مباشرة (منخفضة الخطورة، داخلية) | approval = لا تُنفذ إلا بعد اعتماد بشري
import { OpsError, sha256 } from '../util.js';
import { daysBetween, formatHijri, parseDateExpression, describeDate } from '../dates.js';
import { normalizeArabic, tokenize } from '../kb/index.js';
import { canTransition, allowedNext, statusLabel, TX_STATUSES, CLOSED_STATUSES } from '../workflow.js';
import { renewalReminder, missingDocsReminder, followupReminder } from '../messages.js';

const ID = { type: 'string', minLength: 3, maxLength: 64, pattern: '^[a-z]+_[a-z0-9]+$' };
const maskPhone = (p) => (p ? `…${String(p).slice(-4)}` : null);

function mustClient(ctx, id) {
  const c = ctx.store.getClient(ctx.tenantId, id);
  if (!c) throw new OpsError('not_found', `العميل ${id} غير موجود في هذه المنشأة.`);
  return c;
}
function mustTx(ctx, id) {
  const t = ctx.store.getTransaction(ctx.tenantId, id);
  if (!t) throw new OpsError('not_found', `المعاملة ${id} غير موجودة في هذه المنشأة.`);
  return t;
}
function mustDoc(ctx, id) {
  const d = ctx.store.getDocument(ctx.tenantId, id);
  if (!d) throw new OpsError('not_found', `المستند ${id} غير موجود في هذه المنشأة.`);
  return d;
}

// الحالة تُحسب من التاريخ عند كل قراءة (لا تنتظر تشغيل المتابعة اليومية)، عدا «تجديد جارٍ» و«مؤرشف»
export function effectiveStatus(d, days, type) {
  if (['renewal_in_progress', 'archived'].includes(d.status) || days === null) return d.status;
  if (days < 0) return 'expired';
  return days <= Math.max(...(type?.reminder_offsets_days || [30])) ? 'expiring' : 'valid';
}

export function describeDocument(ctx, d) {
  const type = ctx.kb.docType(d.doc_type);
  const days = d.expiry_date ? daysBetween(ctx.today, d.expiry_date) : null;
  return {
    document_id: d.id,
    type: d.doc_type,
    type_name: type?.name || d.doc_type,
    label: d.label,
    holder_name: d.holder_name,
    expiry_date: d.expiry_date,
    expiry_hijri: d.expiry_date ? formatHijri(d.expiry_date) : null,
    date_meaning: type?.date_meaning || 'تاريخ الانتهاء',
    days_left: days,
    status: effectiveStatus(d, days, type),
    data_source: d.data_source,
    verified_at: d.verified_at,
    renewal_service_id: type?.renewal_service_id || null,
  };
}

// مطابقة المستلم بالمطلوب: تطابق نصي بعد التطبيع أو تغطية ٦٠٪ من الكلمات
function matches(requirement, received) {
  const r = normalizeArabic(requirement).trim();
  return received.some((x) => {
    const n = normalizeArabic(x).trim();
    if (n === r) return true;
    const rt = new Set(tokenize(requirement));
    const xt = tokenize(x);
    if (!rt.size) return false;
    const hit = xt.filter((t) => rt.has(t)).length;
    return hit / rt.size >= 0.6;
  });
}

export function computeMissing(ctx, tx) {
  const service = tx.service_id ? ctx.kb.service(tx.service_id) : null;
  if (!service) {
    return {
      service: null,
      requirements_known: false,
      missing: [],
      received: tx.received_docs,
      note: tx.service_id ? `الخدمة ${tx.service_id} غير موجودة في قاعدة المعرفة.` : 'المعاملة غير مربوطة بخدمة من الكتالوج.',
      sources: [],
    };
  }
  const reqs = service.requirements;
  if (!reqs.length) {
    return {
      service: { id: service.id, name: service.name, status: service.status },
      requirements_known: false,
      missing: [],
      received: tx.received_docs,
      note: 'لا توجد متطلبات موثقة لهذه الخدمة في قاعدة المعرفة؛ يحددها الموظف المختص ولا تُخترع.',
      sources: [`svc:${service.id}`],
    };
  }
  const missing = reqs.filter((r) => !matches(r, tx.received_docs));
  return {
    service: { id: service.id, name: service.name, status: service.status },
    requirements_known: true,
    requirements_approval: service.provenance.requirements_approval,
    required: reqs,
    received: tx.received_docs,
    missing,
    complete: missing.length === 0,
    note: 'المتطلبات من كتالوج المكتب ولم تُطابق بعد مع صفحة الجهة الرسمية.',
    sources: [`svc:${service.id}`],
  };
}

export const TOOLS = [
  {
    name: 'search_knowledge',
    description: 'يبحث في قاعدة معرفة المكتب: الخدمات ومتطلباتها، أنواع المستندات ومواعيد التذكير، المعلومات النظامية، السياسات، الإجراءات، الأسئلة المتكررة والحالات. كل نتيجة لها id للاستشهاد وحالة اعتماد.',
    permission: 'read',
    mode: 'read',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 200, description: 'نص البحث بالعربية' },
        types: { type: 'array', maxItems: 7, items: { type: 'string', enum: ['service', 'document_type', 'fact', 'policy', 'procedure', 'faq', 'case'] } },
      },
      required: ['query'],
      additionalProperties: false,
    },
    run(ctx, { query, types }) {
      const results = ctx.kb.search(query, { limit: 5, types });
      results.forEach((r) => ctx.citable.add(r.id));
      return { count: results.length, results };
    },
  },
  {
    name: 'find_client',
    description: 'يبحث عن عميل بالاسم أو رقم السجل التجاري أو آخر ٤ أرقام من الهوية، أو برقم الجوال. يعيد قائمة مختصرة؛ استخدم get_client للتفاصيل.',
    permission: 'read',
    mode: 'read',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 100 },
        phone: { type: 'string', pattern: '^[+0-9 ]{9,16}$' },
      },
      additionalProperties: false,
    },
    run(ctx, { query, phone }) {
      if (!query && !phone) throw new OpsError('invalid_input', 'حدد query أو phone.');
      const rows = ctx.store.findClients(ctx.tenantId, { query, phone });
      const strong = rows.filter((c) => c.match_quality !== 'partial');
      return {
        count: rows.length,
        // أكثر من تطابق قوي = غموض: اسأل الموظف أيهم يقصد قبل أي إجراء
        ambiguous: strong.length > 1,
        clients: rows.map((c) => ({ client_id: c.id, name: c.name, kind: c.kind, phone: maskPhone(c.phone), cr_number: c.cr_number, opt_out_reminders: !!c.opt_out_reminders, match: c.match_quality || 'strong' })),
        hint: rows.length === 0 ? 'لا يوجد عميل مطابق. تأكد من الاسم أو اطلب رقم الجوال أو السجل.' : strong.length > 1 ? 'أكثر من عميل مطابق؛ اسأل الموظف أيهم يقصد.' : undefined,
      };
    },
  },
  {
    name: 'get_client',
    description: 'يقرأ ملف العميل من قاعدة بيانات المكتب: بياناته الأساسية، مستنداته مع أيام الانتهاء المحسوبة، ومعاملاته.',
    permission: 'read',
    mode: 'read',
    input_schema: { type: 'object', properties: { client_id: ID }, required: ['client_id'], additionalProperties: false },
    run(ctx, { client_id }) {
      const c = mustClient(ctx, client_id);
      return {
        client: { client_id: c.id, name: c.name, kind: c.kind, phone: maskPhone(c.phone), cr_number: c.cr_number, preferred_channel: c.preferred_channel, language: c.language, opt_out_reminders: !!c.opt_out_reminders, notes: c.notes },
        documents: ctx.store.clientDocuments(ctx.tenantId, c.id).map((d) => describeDocument(ctx, d)),
        transactions: ctx.store.clientTransactions(ctx.tenantId, c.id).map((t) => ({
          transaction_id: t.id, title: t.title, service_id: t.service_id, status: t.status, status_label: statusLabel(t.status), due_date: t.due_date, updated_at: t.updated_at,
        })),
      };
    },
  },
  {
    name: 'get_transaction',
    description: 'يقرأ معاملة: حالتها، الخدمة المرتبطة، المستندات المستلمة، سجل الأحداث، والحالات التالية المسموحة.',
    permission: 'read',
    mode: 'read',
    input_schema: { type: 'object', properties: { transaction_id: ID }, required: ['transaction_id'], additionalProperties: false },
    run(ctx, { transaction_id }) {
      const t = mustTx(ctx, transaction_id);
      const c = ctx.store.getClient(ctx.tenantId, t.client_id);
      const svc = t.service_id ? ctx.kb.service(t.service_id) : null;
      if (svc) ctx.citable.add(`svc:${svc.id}`);
      return {
        transaction: {
          transaction_id: t.id, title: t.title, client_id: t.client_id, client_name: c?.name, status: t.status, status_label: statusLabel(t.status),
          due_date: t.due_date, received_docs: t.received_docs, office_fee: t.office_fee, gov_fees: t.gov_fees, created_at: t.created_at, updated_at: t.updated_at,
        },
        service: svc ? { service_id: svc.id, name: svc.name, status: svc.status, authority: svc.authority, kb_id: `svc:${svc.id}` } : null,
        allowed_next_statuses: allowedNext(t.status).map((s) => ({ status: s, label: statusLabel(s) })),
        events: ctx.store.transactionEvents(ctx.tenantId, t.id),
      };
    },
  },
  {
    name: 'check_missing_requirements',
    description: 'يقارن متطلبات الخدمة في قاعدة المعرفة بالمستندات المستلمة في المعاملة ويعيد النواقص. إن لم تكن للخدمة متطلبات موثقة يذكر ذلك صراحة.',
    permission: 'read',
    mode: 'read',
    input_schema: { type: 'object', properties: { transaction_id: ID }, required: ['transaction_id'], additionalProperties: false },
    run(ctx, { transaction_id }) {
      const t = mustTx(ctx, transaction_id);
      const r = computeMissing(ctx, t);
      r.sources.forEach((s) => ctx.citable.add(s));
      return { transaction_id: t.id, title: t.title, ...r };
    },
  },
  {
    name: 'list_expiring_documents',
    description: 'يعرض مستندات العملاء التي تنتهي (أو انتهت) خلال عدد أيام محدد، محسوبة بتاريخ اليوم في منطقة المكتب الزمنية.',
    permission: 'read',
    mode: 'read',
    input_schema: {
      type: 'object',
      properties: {
        within_days: { type: 'integer', minimum: 0, maximum: 365 },
        doc_type: { type: 'string', maxLength: 40 },
        include_expired: { type: 'boolean' },
      },
      required: ['within_days'],
      additionalProperties: false,
    },
    run(ctx, { within_days, doc_type, include_expired = true }) {
      const docs = ctx.store.trackedDocuments(ctx.tenantId)
        .filter((d) => !doc_type || d.doc_type === doc_type)
        .map((d) => ({ d, info: describeDocument(ctx, d) }))
        .filter(({ info }) => info.days_left <= within_days && (include_expired || info.days_left >= 0))
        .sort((a, b) => a.info.days_left - b.info.days_left);
      return {
        today: ctx.today,
        count: docs.length,
        documents: docs.map(({ d, info }) => ({ ...info, client_id: d.client_id, client_name: ctx.store.getClient(ctx.tenantId, d.client_id)?.name })),
      };
    },
  },
  {
    name: 'resolve_date',
    description: 'يحوّل تعبيراً زمنياً (بكرة، بعد ٣ أيام، الخميس الجاي، الأسبوع الجاي، نهاية الشهر، ١٥ رجب، 1448/07/01، 2026-12-01) إلى تاريخ ميلادي وهجري واليوم وعدد الأيام من اليوم. استخدمه قبل أي حساب أو إدخال تاريخ؛ لا تحسب التواريخ بنفسك.',
    permission: 'read',
    mode: 'read',
    input_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', minLength: 1, maxLength: 60 },
        compare_to: { type: 'string', maxLength: 60, description: 'تعبير ثانٍ اختياري لحساب الفرق بين تاريخين' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    run(ctx, { expression, compare_to }) {
      const r = parseDateExpression(expression, ctx.today);
      const out = { today: describeDate(ctx.today, ctx.today), interpretation: r.interpretation, ...describeDate(r.iso, ctx.today) };
      if (r.to) out.range = { from: describeDate(r.from, ctx.today), to: describeDate(r.to, ctx.today) };
      if (compare_to) {
        const b = parseDateExpression(compare_to, ctx.today);
        out.compare_to = { interpretation: b.interpretation, ...describeDate(b.iso, ctx.today), days_between: daysBetween(r.iso, b.iso) };
      }
      return out;
    },
  },
  {
    name: 'get_daily_overview',
    description: 'ملخص اليوم مرتباً حسب الأولوية: مستندات منتهية وقريبة الانتهاء، مهام متأخرة ومستحقة اليوم، إجراءات تنتظر الاعتماد، ومعاملات متوقفة. استخدمه لأسئلة مثل «وش عندي اليوم؟» أو «وش الأهم؟».',
    permission: 'read',
    mode: 'read',
    input_schema: { type: 'object', properties: { horizon_days: { type: 'integer', minimum: 1, maximum: 60 } }, additionalProperties: false },
    run(ctx, { horizon_days = 14 }) {
      const T = ctx.tenantId;
      const name = (id) => ctx.store.getClient(T, id)?.name;
      const docs = ctx.store.trackedDocuments(T).map((d) => ({ ...describeDocument(ctx, d), client_id: d.client_id, client_name: name(d.client_id) }));
      const expired = docs.filter((d) => d.days_left < 0 && d.status !== 'renewal_in_progress').sort((a, b) => a.days_left - b.days_left);
      const soon = docs.filter((d) => d.days_left >= 0 && d.days_left <= horizon_days).sort((a, b) => a.days_left - b.days_left);
      const tasks = ctx.store.listTasks(T, { status: 'open' });
      const overdue = tasks.filter((t) => t.due_date && t.due_date < ctx.today);
      const dueToday = tasks.filter((t) => t.due_date === ctx.today);
      const pending = ctx.store.listActions(T, { status: 'pending_approval' });
      const staleDays = ctx.config.automation.staleTransactionDays;
      const stale = ctx.store.openTransactions(T)
        .map((t) => ({ t, idle: daysBetween((ctx.store.lastEventAt(T, t.id) || t.updated_at).slice(0, 10), ctx.today) }))
        .filter((x) => x.t.status !== 'on_hold' && x.idle >= staleDays)
        .sort((a, b) => b.idle - a.idle);
      const doc = (d) => ({ document_id: d.document_id, client_id: d.client_id, client_name: d.client_name, type_name: d.type_name, holder_name: d.holder_name, expiry_date: d.expiry_date, days_left: d.days_left });
      const task = (t) => ({ task_id: t.id, title: t.title, due_date: t.due_date, priority: t.priority, client_name: t.client_name });
      const priorities = [
        ...expired.map((d) => ({ level: 1, why: `${d.type_name} منتهٍ منذ ${-d.days_left} يوم`, ...doc(d) })),
        ...overdue.map((t) => ({ level: 2, why: `مهمة متأخرة منذ ${daysBetween(t.due_date, ctx.today)} يوم`, ...task(t) })),
        ...soon.filter((d) => d.days_left <= 7).map((d) => ({ level: 3, why: `${d.type_name} ينتهي خلال ${d.days_left} يوم`, ...doc(d) })),
        ...(pending.length ? [{ level: 4, why: `${pending.length} إجراء ينتظر الاعتماد` }] : []),
        ...stale.map((x) => ({ level: 5, why: `معاملة بلا تحديث منذ ${x.idle} يوم`, transaction_id: x.t.id, title: x.t.title, client_id: x.t.client_id, client_name: name(x.t.client_id) })),
      ].slice(0, 12);
      return {
        today: describeDate(ctx.today, ctx.today),
        counts: { expired_documents: expired.length, expiring_within_horizon: soon.length, overdue_tasks: overdue.length, tasks_due_today: dueToday.length, open_tasks: tasks.length, pending_approvals: pending.length, stale_transactions: stale.length },
        priorities,
        due_today: dueToday.slice(0, 10).map(task),
        pending_approvals: pending.slice(0, 5).map((a) => ({ action_id: a.id, summary: a.summary })),
      };
    },
  },
  {
    name: 'create_task',
    description: 'ينشئ مهمة داخلية لموظفي المكتب (لا تُرسل للعميل). الطلب المكرر بنفس البيانات لا ينشئ مهمة ثانية.',
    permission: 'task.write',
    mode: 'write',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 160 },
        details: { type: 'string', maxLength: 1000 },
        due_date: { type: 'string', format: 'date' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        client_id: ID,
        transaction_id: ID,
        document_id: ID,
      },
      required: ['title'],
      additionalProperties: false,
    },
    run(ctx, input) {
      if (input.client_id) mustClient(ctx, input.client_id);
      if (input.transaction_id) mustTx(ctx, input.transaction_id);
      if (input.document_id) mustDoc(ctx, input.document_id);
      const key = `agent:${sha256([normalizeArabic(input.title), input.client_id, input.transaction_id, input.document_id, input.due_date].join('|')).slice(0, 24)}`;
      const { task, created } = ctx.store.createTask(ctx.tenantId, { ...input, source: 'agent', dedupe_key: key, created_by: ctx.user.id });
      return { _status: created ? 'done' : 'duplicate', task_id: task.id, title: task.title, due_date: task.due_date, priority: task.priority, created };
    },
  },
  {
    name: 'prepare_reminder',
    description: 'يجهّز تذكيراً للعميل (تجديد مستند، نقص مستندات، أو متابعة) بنص ثابت التنسيق. لا يُرسل: ينشئ إجراء إرسال ينتظر اعتماد مدير. يتخطى العميل الذي أوقف الرسائل.',
    permission: 'reminder.prepare',
    mode: 'write',
    input_schema: {
      type: 'object',
      properties: {
        client_id: ID,
        kind: { type: 'string', enum: ['renewal', 'missing_documents', 'followup'] },
        document_id: ID,
        transaction_id: ID,
        channel: { type: 'string', enum: ['manual', 'whatsapp'] },
      },
      required: ['client_id', 'kind'],
      additionalProperties: false,
    },
    run(ctx, input) {
      const client = mustClient(ctx, input.client_id);
      if (client.opt_out_reminders) {
        return { _status: 'skipped', reason: 'العميل طلب إيقاف الرسائل؛ لا يُجهَّز تذكير. أنشئ مهمة داخلية إن لزم.' };
      }
      const channel = input.channel || ctx.channels.default;
      let built, refs = {};
      if (input.kind === 'renewal') {
        if (!input.document_id) throw new OpsError('invalid_input', 'تذكير التجديد يتطلب document_id.');
        const doc = mustDoc(ctx, input.document_id);
        if (doc.client_id !== client.id) throw new OpsError('conflict', 'المستند لا يخص هذا العميل.');
        if (!doc.expiry_date) throw new OpsError('missing_data', 'لا يوجد تاريخ انتهاء مسجل للمستند.');
        built = renewalReminder({ kb: ctx.kb, client, document: doc, docType: ctx.kb.docType(doc.doc_type), channelTemplates: ctx.config.channelTemplates });
        refs = { document_id: doc.id, dedupe: `agent:renewal:${doc.id}:${doc.expiry_date}:${ctx.today}` };
      } else {
        if (!input.transaction_id) throw new OpsError('invalid_input', 'هذا النوع يتطلب transaction_id.');
        const tx = mustTx(ctx, input.transaction_id);
        if (tx.client_id !== client.id) throw new OpsError('conflict', 'المعاملة لا تخص هذا العميل.');
        if (input.kind === 'missing_documents') {
          const m = computeMissing(ctx, tx);
          if (!m.requirements_known) throw new OpsError('missing_data', `لا يمكن تحديد النواقص: ${m.note}`);
          if (!m.missing.length) return { _status: 'skipped', reason: 'لا توجد نواقص مسجلة لهذه المعاملة.' };
          built = missingDocsReminder({ kb: ctx.kb, client, transaction: tx, missing: m.missing, channelTemplates: ctx.config.channelTemplates });
        } else {
          built = followupReminder({ client, transaction: tx, channelTemplates: ctx.config.channelTemplates });
        }
        refs = { transaction_id: tx.id, dedupe: `agent:${input.kind}:${tx.id}:${ctx.today}` };
      }
      return ctx.queueReminder({
        client, kind: input.kind, channel, built, document_id: refs.document_id, transaction_id: refs.transaction_id, dedupe_key: refs.dedupe,
      });
    },
  },
  {
    name: 'propose_transaction_status',
    description: 'يقترح تغيير حالة معاملة. لا يغيّر الحالة مباشرة: ينشئ إجراءً ينتظر اعتماد مدير أو مالك، ويُرفض إن لم يكن الانتقال مسموحاً.',
    permission: 'transaction.propose_status',
    mode: 'approval',
    input_schema: {
      type: 'object',
      properties: {
        transaction_id: ID,
        new_status: { type: 'string', enum: Object.keys(TX_STATUSES) },
        reason: { type: 'string', minLength: 3, maxLength: 500 },
      },
      required: ['transaction_id', 'new_status', 'reason'],
      additionalProperties: false,
    },
    prepare(ctx, input) {
      const t = mustTx(ctx, input.transaction_id);
      if (t.status === input.new_status) throw new OpsError('no_change', `المعاملة بالفعل في حالة «${statusLabel(t.status)}».`);
      if (!canTransition(t.status, input.new_status)) {
        throw new OpsError('invalid_transition', `لا يُسمح بالانتقال من «${statusLabel(t.status)}» إلى «${statusLabel(input.new_status)}». المسموح: ${allowedNext(t.status).map(statusLabel).join('، ') || 'لا شيء (معاملة مغلقة)'}.`);
      }
      return {
        input: { ...input, expected_status: t.status },
        summary: `تغيير حالة «${t.title}» من «${statusLabel(t.status)}» إلى «${statusLabel(input.new_status)}» — السبب: ${input.reason}`,
        idempotency_key: `status:${t.id}:${t.status}:${input.new_status}`,
      };
    },
  },
  {
    name: 'record_outcome',
    description: 'يسجل نتيجة أو ملاحظة على معاملة (مثل: تم التواصل، استُلم مستند). يمكن تمرير received_documents لتسجيل مستندات استُلمت فعلاً.',
    permission: 'transaction.note',
    mode: 'write',
    input_schema: {
      type: 'object',
      properties: {
        transaction_id: ID,
        outcome: { type: 'string', minLength: 3, maxLength: 1000 },
        received_documents: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 2, maxLength: 200 } },
      },
      required: ['transaction_id', 'outcome'],
      additionalProperties: false,
    },
    run(ctx, { transaction_id, outcome, received_documents }) {
      const t = mustTx(ctx, transaction_id);
      if (CLOSED_STATUSES.includes(t.status)) throw new OpsError('conflict', 'المعاملة مغلقة؛ لا يمكن تسجيل نتائج جديدة عليها.');
      ctx.store.addEvent(ctx.tenantId, t.id, { kind: 'outcome', note: outcome, actor: ctx.user.id });
      let received = t.received_docs;
      if (received_documents?.length) received = ctx.store.addReceivedDocs(ctx.tenantId, t.id, received_documents, ctx.user.id).received_docs;
      return { _status: 'done', transaction_id: t.id, recorded: true, received_docs: received };
    },
  },
  {
    name: 'escalate_to_staff',
    description: 'يحوّل الحالة لمدير المكتب بمهمة عاجلة: عند نقص معلومة لازمة، أو شكوى، أو طلب خصم، أو حالة قانونية/معقدة، أو خدمة غير موجودة، أو تعارض بيانات.',
    permission: 'task.write',
    mode: 'write',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['missing_knowledge', 'data_conflict', 'complaint', 'discount_request', 'legal_or_complex', 'unknown_service', 'other'] },
        summary: { type: 'string', minLength: 5, maxLength: 1000 },
        client_id: ID,
        transaction_id: ID,
        priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
      },
      required: ['reason', 'summary'],
      additionalProperties: false,
    },
    run(ctx, input) {
      if (input.client_id) mustClient(ctx, input.client_id);
      if (input.transaction_id) mustTx(ctx, input.transaction_id);
      const key = `escalate:${sha256([input.reason, input.client_id, input.transaction_id, normalizeArabic(input.summary)].join('|')).slice(0, 24)}`;
      const { task, created } = ctx.store.createTask(ctx.tenantId, {
        title: `تحويل للمدير: ${REASONS[input.reason]}`,
        details: input.summary,
        priority: input.priority || 'high',
        client_id: input.client_id,
        transaction_id: input.transaction_id,
        assignee_role: 'manager',
        source: 'agent',
        dedupe_key: key,
        created_by: ctx.user.id,
      });
      return { _status: created ? 'done' : 'duplicate', task_id: task.id, escalated_to: 'manager' };
    },
  },
];

const REASONS = {
  missing_knowledge: 'معلومة غير متوفرة في قاعدة المعرفة',
  data_conflict: 'تعارض في البيانات',
  complaint: 'شكوى',
  discount_request: 'طلب خصم أو استثناء',
  legal_or_complex: 'حالة قانونية أو معقدة',
  unknown_service: 'خدمة غير موجودة في الكتالوج',
  other: 'يحتاج تدخل موظف',
};
