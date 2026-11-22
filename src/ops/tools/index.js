// منفّذ الأدوات: صلاحيات، تحقق من المدخلات، مهلة، منع التكرار، اعتماد بشري، وتسجيل.
// نجاح أي إجراء يُعلن فقط من نتيجة هذا المنفّذ (ledger)، لا من نص النموذج.
import { TOOLS } from './definitions.js';
import { can } from '../permissions.js';
import { validate } from '../validate.js';
import { audit } from '../audit.js';
import { OpsError, withTimeout, redact } from '../util.js';
import { todayIn } from '../dates.js';
import { statusLabel, CLOSED_STATUSES } from '../workflow.js';

const KIND_LABEL = { renewal: 'تجديد', missing_documents: 'نقص مستندات', followup: 'متابعة' };

export function createOps({ store, kb, config, channels, extraTools = [], now = () => new Date() }) {
  const tools = [...TOOLS, ...extraTools];
  const byName = new Map(tools.map((t) => [t.name, t]));

  function ctxFor(user, { runId = null } = {}) {
    const tenant = store.getTenant(user.tenant_id);
    if (!tenant) throw new OpsError('not_found', 'المنشأة غير موجودة.');
    const ctx = {
      store, kb, config, channels, user, tenant, runId,
      tenantId: user.tenant_id,
      today: todayIn(tenant.timezone || config.timezone, now()),
      citable: new Set(),
      ledger: [],
    };
    ctx.queueReminder = (args) => queueReminder(ctx, args);
    return ctx;
  }

  // أدوات معروضة للنموذج حسب دور المستخدم (والمنفّذ يتحقق مرة أخرى)
  function toolSchemasFor(role) {
    return tools.filter((t) => can(role, t.permission)).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  }

  async function executeTool(ctx, name, rawInput) {
    const started = Date.now();
    const def = byName.get(name);
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    let result;
    try {
      if (!def) throw new OpsError('unknown_tool', `أداة غير معروفة: ${name}`);
      if (!can(ctx.user.role, def.permission)) {
        throw new OpsError('forbidden', `ليست لديك صلاحية تنفيذ «${name}» (دورك: ${ctx.user.role}).`);
      }
      const errors = validate(def.input_schema, input);
      if (errors.length) throw new OpsError('invalid_input', `مدخلات غير صالحة: ${errors.join('؛ ')}`);
      const data = await withTimeout(
        () => (def.mode === 'approval' ? proposeAction(ctx, def, input) : def.mode === 'write' ? store.tx(() => def.run(ctx, input)) : def.run(ctx, input)),
        config.agent.toolTimeoutMs,
        name
      );
      const status = data._status || 'done';
      delete data._status;
      result = { ok: true, status, data };
    } catch (e) {
      const known = e instanceof OpsError;
      if (!known) console.error(`[tool ${name}]`, e);
      result = { ok: false, status: 'failed', error: { code: known ? e.code : 'internal_error', message: known ? e.message : 'خطأ داخلي في الأداة؛ لم يُنفذ شيء.' } };
    }
    const entry = {
      tool: name,
      mode: def?.mode || 'unknown',
      ok: result.ok,
      status: result.status,
      ms: Date.now() - started,
      input: redact(input),
      ...(result.ok ? { refs: pickRefs(result.data), entities: extractEntities(result.data) } : { error: result.error }),
    };
    ctx.ledger.push(entry);
    audit(store.db, { tenantId: ctx.tenantId, userId: ctx.user.id, runId: ctx.runId, event: result.ok ? `tool.${result.status}` : 'tool.failed', tool: name, detail: entry });
    return result;
  }

  function proposeAction(ctx, def, input) {
    const prep = def.prepare(ctx, input);
    return store.tx(() => {
      const { action, created } = store.createAction(ctx.tenantId, {
        tool: def.name, input: prep.input, summary: prep.summary, idempotency_key: prep.idempotency_key,
        requested_by: ctx.user.id, run_id: ctx.runId,
      });
      return {
        _status: created ? 'pending_approval' : 'duplicate',
        action_id: action.id,
        summary: action.summary,
        note: created ? 'أُنشئ الإجراء وينتظر اعتماد مدير أو مالك. لم يُنفذ بعد.' : 'يوجد إجراء مطابق ينتظر الاعتماد مسبقاً؛ لم يُنشأ إجراء جديد.',
      };
    });
  }

  function queueReminder(ctx, { client, kind, channel, built, document_id, transaction_id, dedupe_key, scheduled_for }) {
    if (!channels.get(channel)) throw new OpsError('invalid_input', `قناة غير معروفة: ${channel}`);
    return store.tx(() => {
      const { reminder, created } = store.createReminder(ctx.tenantId, {
        client_id: client.id, document_id, transaction_id, kind, channel,
        template: channel === 'whatsapp' ? built.template : null, template_params: built.template_params,
        message: built.message, scheduled_for: scheduled_for || ctx.today, status: 'pending_approval', dedupe_key,
      });
      if (!created) return { _status: 'duplicate', reminder_id: reminder.id, reminder_status: reminder.status, action_id: reminder.action_id };
      const { action } = store.createAction(ctx.tenantId, {
        tool: 'send_reminder',
        input: { reminder_id: reminder.id },
        summary: `إرسال تذكير ${KIND_LABEL[kind]} إلى ${client.name} عبر ${channel === 'whatsapp' ? 'واتساب' : 'الإرسال اليدوي'}: «${built.message}»`,
        idempotency_key: `send:${reminder.id}`,
        requested_by: ctx.user.id,
        run_id: ctx.runId,
      });
      store.updateReminder(ctx.tenantId, reminder.id, { action_id: action.id });
      return { _status: 'pending_approval', reminder_id: reminder.id, action_id: action.id, channel, message: built.message, note: 'جُهّز التذكير ولم يُرسل؛ ينتظر اعتماد مدير.' };
    });
  }

  // ===== تنفيذ الإجراءات بعد الاعتماد =====
  const HANDLERS = {
    async propose_transaction_status(ctx, action) {
      const { transaction_id, new_status, expected_status, reason } = action.input;
      const ok = store.tx(() => {
        const updated = store.updateTransactionStatus(ctx.tenantId, transaction_id, { from: expected_status, to: new_status, actor: ctx.user.id, note: reason });
        if (updated && CLOSED_STATUSES.includes(new_status)) {
          store.cancelOpenTasks(ctx.tenantId, 'transaction_id', transaction_id);
          store.cancelPendingReminders(ctx.tenantId, 'transaction_id', transaction_id);
        }
        return updated;
      });
      if (!ok) {
        const cur = store.getTransaction(ctx.tenantId, transaction_id);
        if (!cur) throw new OpsError('not_found', 'المعاملة لم تعد موجودة.');
        throw new OpsError('conflict', `تعارض: حالة المعاملة الآن «${statusLabel(cur.status)}» وليست «${statusLabel(expected_status)}» كما عند الاقتراح. لم يُنفذ التغيير؛ راجع المعاملة وأعد الاقتراح.`);
      }
      return { transaction_id, from: expected_status, to: new_status, to_label: statusLabel(new_status) };
    },

    async send_reminder(ctx, action) {
      const r = store.getReminder(ctx.tenantId, action.input.reminder_id);
      if (!r) throw new OpsError('not_found', 'التذكير غير موجود.');
      if (r.status !== 'pending_approval') throw new OpsError('conflict', `التذكير في حالة «${r.status}» ولا يمكن إرساله.`);
      const client = store.getClient(ctx.tenantId, r.client_id);
      if (!client) throw new OpsError('not_found', 'العميل غير موجود.');
      if (client.opt_out_reminders) {
        store.updateReminder(ctx.tenantId, r.id, { status: 'skipped', error: 'العميل أوقف الرسائل' });
        throw new OpsError('opted_out', 'العميل طلب إيقاف الرسائل؛ لم يُرسل التذكير.');
      }
      const channel = channels.get(r.channel);
      if (!channel) throw new OpsError('not_configured', `القناة ${r.channel} غير متاحة.`);
      store.updateReminder(ctx.tenantId, r.id, { status: 'sending' });
      try {
        const res = await withTimeout(() => channel.send(r, { client }), config.agent.toolTimeoutMs, `إرسال عبر ${r.channel}`);
        store.updateReminder(ctx.tenantId, r.id, { status: res.status, provider_message_id: res.provider_message_id || null, error: null });
        return { reminder_id: r.id, channel: r.channel, delivery_status: res.status, provider_message_id: res.provider_message_id || null, note: res.note || null };
      } catch (e) {
        store.updateReminder(ctx.tenantId, r.id, { status: 'failed', error: e.message });
        throw e;
      }
    },
  };

  async function approveAction(user, actionId) {
    if (!can(user.role, 'action.approve')) throw new OpsError('forbidden', 'اعتماد الإجراءات متاح للمدير أو المالك فقط.');
    const ctx = ctxFor(user);
    const action = store.getAction(user.tenant_id, actionId);
    if (!action) throw new OpsError('not_found', 'الإجراء غير موجود.');
    if (action.status !== 'pending_approval') throw new OpsError('conflict', `لا يمكن الاعتماد: الإجراء في حالة «${action.status}».`);
    if (!store.claimAction(user.tenant_id, actionId, 'pending_approval', 'executing', user.id)) {
      throw new OpsError('conflict', 'عولج هذا الإجراء للتو من مستخدم آخر.');
    }
    audit(store.db, { tenantId: user.tenant_id, userId: user.id, event: 'action.approved', tool: action.tool, detail: { action_id: actionId } });
    const handler = HANDLERS[action.tool];
    try {
      if (!handler) throw new OpsError('not_configured', `لا يوجد منفّذ للإجراء ${action.tool}.`);
      const result = await handler(ctx, action);
      store.finishAction(user.tenant_id, actionId, { status: 'succeeded', result });
      audit(store.db, { tenantId: user.tenant_id, userId: user.id, event: 'action.succeeded', tool: action.tool, detail: { action_id: actionId, result } });
    } catch (e) {
      const msg = e instanceof OpsError ? e.message : 'خطأ داخلي أثناء التنفيذ.';
      if (!(e instanceof OpsError)) console.error('[action]', e);
      store.finishAction(user.tenant_id, actionId, { status: 'failed', error: msg });
      audit(store.db, { tenantId: user.tenant_id, userId: user.id, event: 'action.failed', tool: action.tool, detail: { action_id: actionId, error: msg } });
    }
    return store.getAction(user.tenant_id, actionId);
  }

  function rejectAction(user, actionId, reason = '') {
    if (!can(user.role, 'action.approve')) throw new OpsError('forbidden', 'رفض الإجراءات متاح للمدير أو المالك فقط.');
    const action = store.getAction(user.tenant_id, actionId);
    if (!action) throw new OpsError('not_found', 'الإجراء غير موجود.');
    if (!store.claimAction(user.tenant_id, actionId, 'pending_approval', 'rejected', user.id)) {
      throw new OpsError('conflict', `لا يمكن الرفض: الإجراء في حالة «${action.status}».`);
    }
    store.finishAction(user.tenant_id, actionId, { status: 'rejected', error: reason || null });
    if (action.tool === 'send_reminder') store.updateReminder(user.tenant_id, action.input.reminder_id, { status: 'cancelled', error: 'رُفض من المعتمِد' });
    audit(store.db, { tenantId: user.tenant_id, userId: user.id, event: 'action.rejected', tool: action.tool, detail: { action_id: actionId, reason } });
    return store.getAction(user.tenant_id, actionId);
  }

  function markReminderSent(user, reminderId) {
    if (!can(user.role, 'reminder.mark_sent')) throw new OpsError('forbidden', 'ليست لديك صلاحية.');
    const r = store.getReminder(user.tenant_id, reminderId);
    if (!r) throw new OpsError('not_found', 'التذكير غير موجود.');
    if (r.status !== 'queued_manual') throw new OpsError('conflict', `التذكير في حالة «${r.status}»؛ يُعلَّم كمرسل فقط بعد اعتماده للإرسال اليدوي.`);
    store.updateReminder(user.tenant_id, r.id, { status: 'sent', error: null });
    audit(store.db, { tenantId: user.tenant_id, userId: user.id, event: 'reminder.marked_sent', detail: { reminder_id: r.id } });
    return store.getReminder(user.tenant_id, r.id);
  }

  return { tools, ctxFor, toolSchemasFor, executeTool, approveAction, rejectAction, markReminderSent, queueReminder };
}

// الكيانات التي ظهرت في نتيجة الأداة (لذاكرة المحادثة: «هو»، «المعاملة الثانية»)
export function extractEntities(data, out = new Map(), depth = 0) {
  if (!data || typeof data !== 'object' || depth > 4 || out.size >= 15) return [...out.values()];
  if (Array.isArray(data)) { data.forEach((x) => extractEntities(x, out, depth + 1)); return [...out.values()]; }
  const add = (type, id, name) => { if (id && !out.has(id)) out.set(id, { type, id, name: name || null }); };
  if (data.transaction_id && data.title) add('transaction', data.transaction_id, data.title);
  if (data.document_id && data.type_name) add('document', data.document_id, [data.type_name, data.holder_name, data.client_name].filter(Boolean).join(' — '));
  if (data.client_id && (data.name || data.client_name)) add('client', data.client_id, data.name || data.client_name);
  if (data.task_id && data.title) add('task', data.task_id, data.title);
  for (const v of Object.values(data)) if (v && typeof v === 'object') extractEntities(v, out, depth + 1);
  return [...out.values()];
}

function pickRefs(data) {
  const refs = {};
  for (const k of ['task_id', 'action_id', 'reminder_id', 'transaction_id', 'client_id']) if (data?.[k]) refs[k] = data[k];
  if (data?.summary) refs.summary = data.summary;
  if (data?.reason) refs.reason = data.reason;
  if (data?.note) refs.note = data.note;
  return refs;
}
