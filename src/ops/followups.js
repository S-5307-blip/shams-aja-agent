// محرك المتابعة الآلي: قواعد ثابتة لحساب التواريخ وإنشاء المهام والتذكيرات.
// آمن لإعادة التشغيل (idempotent): مفاتيح منع التكرار تشمل المستند وتاريخ انتهائه ومرحلة التذكير،
// فتجديد المستند (تاريخ جديد) يبدأ دورة جديدة ويلغي التذكيرات المعلقة للتاريخ القديم.
import { addDays, daysBetween } from './dates.js';
import { renewalReminder } from './messages.js';
import { audit } from './audit.js';
import { computeMissing } from './tools/definitions.js';

export async function runFollowups({ store, kb, ops, config, tenantId, actor }) {
  const user = actor || { id: 'system:automation', tenant_id: tenantId, role: 'automation', name: 'المتابعة الآلية' };
  const ctx = ops.ctxFor(user);
  const today = ctx.today;
  const s = {
    tenant_id: tenantId, today,
    documents_checked: 0, status_updates: 0,
    reminders_created: 0, reminders_existing: 0, reminders_skipped_opt_out: 0, old_reminders_cancelled: 0,
    tasks_created: 0, tasks_existing: 0, stale_transactions: 0, errors: [],
  };

  for (const d of store.trackedDocuments(tenantId)) {
    s.documents_checked++;
    try {
      const type = kb.docType(d.doc_type) || kb.docType('other');
      const offsets = [...type.reminder_offsets_days].sort((a, b) => b - a);
      const days = daysBetween(today, d.expiry_date);

      // ١) حالة المستند
      if (d.status !== 'renewal_in_progress') {
        const status = days < 0 ? 'expired' : days <= offsets[0] ? 'expiring' : 'valid';
        if (status !== d.status) { store.setDocumentStatus(tenantId, d.id, status); s.status_updates++; }
      }
      // ٢) إلغاء تذكيرات معلقة لتاريخ انتهاء قديم
      s.old_reminders_cancelled += store.cancelPendingReminders(tenantId, 'document_id', d.id, { exceptExpiry: d.expiry_date });

      const client = store.getClient(tenantId, d.client_id);
      const holder = d.holder_name ? ` (${d.holder_name})` : '';

      // ٣) مهمة داخلية واحدة لكل دورة تجديد
      if (days <= type.task_offset_days) {
        const { created } = store.createTask(tenantId, {
          title: `${type.date_meaning ? '' : 'تجديد '}${type.name}${holder} — ${client.name}`,
          details: [
            `التاريخ: ${d.expiry_date} (متبقٍ ${days} يوم).`,
            `مصدر التاريخ: ${d.data_source}${d.verified_at ? `، آخر تحقق ${d.verified_at.slice(0, 10)}` : '، لم يُتحقق منه'}.`,
            type.renewal_service_id ? `الخدمة: ${type.renewal_service_id}.` : 'لا توجد خدمة تجديد مرتبطة في الكتالوج.',
            client.opt_out_reminders ? 'العميل أوقف الرسائل: تواصل معه بالطريقة المناسبة دون تذكير آلي.' : '',
          ].filter(Boolean).join(' '),
          due_date: days < 0 ? today : addDays(d.expiry_date, -Math.min(7, Math.max(days, 0))),
          priority: days < 0 ? 'urgent' : days <= 7 ? 'high' : 'normal',
          client_id: client.id,
          document_id: d.id,
          source: 'automation',
          dedupe_key: `auto:renewal-task:${d.id}:${d.expiry_date}`,
          created_by: user.id,
        });
        created ? s.tasks_created++ : s.tasks_existing++;
      }

      // ٤) تذكير العميل: مرحلة واحدة فقط (الأقرب) لكل تشغيل، ولا تكرار لنفس المرحلة
      if (d.status === 'renewal_in_progress') continue;
      const crossed = offsets.filter((o) => days <= o);
      if (!crossed.length) continue;
      const stage = Math.min(...crossed);
      if (client.opt_out_reminders) { s.reminders_skipped_opt_out++; continue; }
      const channel = config.channels.default === 'whatsapp' && client.phone ? 'whatsapp' : 'manual';
      const built = renewalReminder({ kb, client, document: d, docType: type, channelTemplates: config.channelTemplates });
      const res = ops.queueReminder(ctx, {
        client, kind: 'renewal', channel, built, document_id: d.id,
        dedupe_key: `auto:renewal:${d.id}:${d.expiry_date}:${stage}`,
      });
      res._status === 'duplicate' ? s.reminders_existing++ : s.reminders_created++;
    } catch (e) {
      s.errors.push({ document_id: d.id, error: e.message });
    }
  }

  // ٥) معاملات متوقفة دون تحديث
  const week = Math.floor(daysBetween('2020-01-06', today) / 7);
  for (const t of store.openTransactions(tenantId)) {
    if (t.status === 'on_hold') continue;
    const last = (store.lastEventAt(tenantId, t.id) || t.updated_at).slice(0, 10);
    const idle = daysBetween(last, today);
    if (idle < config.automation.staleTransactionDays) continue;
    s.stale_transactions++;
    const m = computeMissing(ctx, t);
    const client = store.getClient(tenantId, t.client_id);
    const { created } = store.createTask(tenantId, {
      title: `متابعة معاملة متوقفة: ${t.title} — ${client?.name || ''}`,
      details: `لا تحديث منذ ${idle} يوم (الحالة: ${t.status}).${m.requirements_known && m.missing.length ? ` النواقص: ${m.missing.join('، ')}.` : ''}`,
      due_date: today,
      priority: idle >= config.automation.staleTransactionDays * 2 ? 'high' : 'normal',
      client_id: t.client_id,
      transaction_id: t.id,
      source: 'automation',
      dedupe_key: `auto:stale:${t.id}:w${week}`,
      created_by: user.id,
    });
    created ? s.tasks_created++ : s.tasks_existing++;
  }

  audit(store.db, { tenantId, userId: user.id, event: 'automation.followups', detail: s });
  return s;
}
