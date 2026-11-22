// طبقة البيانات. كل دالة تأخذ tenantId وتقيّد الاستعلام به، فلا يمكن الوصول لبيانات منشأة أخرى.
import crypto from 'node:crypto';
import { newId, nowIso, sha256, parseJson, OpsError } from './util.js';

const json = (v) => JSON.stringify(v ?? null);

export function createStore(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  // ===== المنشآت والمستخدمون =====
  function createTenant({ id = newId('ten'), name, timezone = 'Asia/Riyadh' }) {
    run('INSERT INTO tenants (id, name, timezone, created_at) VALUES (?, ?, ?, ?)', id, name, timezone, nowIso());
    return getTenant(id);
  }
  const getTenant = (id) => one('SELECT * FROM tenants WHERE id = ?', id);

  // يعيد الرمز مرة واحدة فقط؛ يُخزَّن مُجزّأ (hash)
  function createUser({ tenantId, name, role, token = crypto.randomBytes(24).toString('base64url') }) {
    const id = newId('usr');
    run('INSERT INTO users (id, tenant_id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, tenantId, name, role, sha256(token), nowIso());
    return { user: getUser(tenantId, id), token };
  }
  const getUser = (tenantId, id) => one('SELECT id, tenant_id, name, role, active FROM users WHERE tenant_id = ? AND id = ?', tenantId, id);
  const userByToken = (token) =>
    token ? one('SELECT id, tenant_id, name, role FROM users WHERE token_hash = ? AND active = 1', sha256(token)) : null;

  // ===== العملاء =====
  function createClient(tenantId, c) {
    const id = newId('cli');
    const t = nowIso();
    try {
      run(
        `INSERT INTO clients (id, tenant_id, kind, name, phone, email, id_last4, cr_number, preferred_channel, language, opt_out_reminders, notes, external_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, tenantId, c.kind, c.name, c.phone || null, c.email || null, c.id_last4 || null, c.cr_number || null,
        c.preferred_channel || 'whatsapp', c.language || 'ar', c.opt_out_reminders ? 1 : 0, c.notes || null, c.external_ref || null, t, t
      );
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new OpsError('conflict', 'يوجد عميل مسجل بنفس رقم الجوال في هذه المنشأة.');
      throw e;
    }
    return getClient(tenantId, id);
  }
  const getClient = (tenantId, id) => one('SELECT * FROM clients WHERE tenant_id = ? AND id = ?', tenantId, id);

  function findClients(tenantId, { query, phone, limit = 10 }) {
    if (phone) {
      const digits = String(phone).replace(/\D/g, '').replace(/^0/, '966');
      return all('SELECT * FROM clients WHERE tenant_id = ? AND phone LIKE ? LIMIT ?', tenantId, `%${digits.slice(-9)}`, limit);
    }
    const q = `%${String(query || '').trim()}%`;
    return all(
      `SELECT * FROM clients WHERE tenant_id = ? AND (name LIKE ? OR cr_number LIKE ? OR id_last4 = ? OR phone LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`,
      tenantId, q, q, String(query || '').trim(), q, limit
    );
  }
  const listClients = (tenantId, limit = 200) => all('SELECT * FROM clients WHERE tenant_id = ? ORDER BY name LIMIT ?', tenantId, limit);

  // ===== المستندات =====
  function addDocument(tenantId, d) {
    if (!getClient(tenantId, d.client_id)) throw new OpsError('not_found', 'العميل غير موجود.');
    const id = newId('doc');
    const t = nowIso();
    run(
      `INSERT INTO documents (id, tenant_id, client_id, doc_type, label, holder_name, number_last4, expiry_date, expiry_original, expiry_calendar, status, data_source, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, tenantId, d.client_id, d.doc_type, d.label || null, d.holder_name || null, d.number_last4 || null,
      d.expiry_date || null, d.expiry_original || d.expiry_date || null, d.expiry_calendar || 'gregorian',
      d.status || 'valid', d.data_source || 'manual', d.verified_at || null, t, t
    );
    return getDocument(tenantId, id);
  }
  const getDocument = (tenantId, id) => one('SELECT * FROM documents WHERE tenant_id = ? AND id = ?', tenantId, id);
  const clientDocuments = (tenantId, clientId) =>
    all('SELECT * FROM documents WHERE tenant_id = ? AND client_id = ? AND status != ? ORDER BY expiry_date', tenantId, clientId, 'archived');
  const trackedDocuments = (tenantId) =>
    all("SELECT * FROM documents WHERE tenant_id = ? AND expiry_date IS NOT NULL AND status != 'archived'", tenantId);
  const setDocumentStatus = (tenantId, id, status) =>
    run('UPDATE documents SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?', status, nowIso(), tenantId, id);

  function updateDocumentExpiry(tenantId, id, { expiry_date, expiry_original, expiry_calendar, data_source, verified_at }) {
    const r = run(
      `UPDATE documents SET expiry_date = ?, expiry_original = ?, expiry_calendar = ?, data_source = ?, verified_at = ?, status = 'valid', updated_at = ?
       WHERE tenant_id = ? AND id = ?`,
      expiry_date, expiry_original || expiry_date, expiry_calendar || 'gregorian', data_source || 'manual', verified_at || null, nowIso(), tenantId, id
    );
    if (!r.changes) throw new OpsError('not_found', 'المستند غير موجود.');
    return getDocument(tenantId, id);
  }

  // ===== المعاملات =====
  function createTransaction(tenantId, tx) {
    if (!getClient(tenantId, tx.client_id)) throw new OpsError('not_found', 'العميل غير موجود.');
    const id = newId('trx');
    const t = nowIso();
    run(
      `INSERT INTO transactions (id, tenant_id, client_id, service_id, title, status, assigned_to, due_date, received_docs, external_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, tenantId, tx.client_id, tx.service_id || null, tx.title, tx.status || 'new', tx.assigned_to || null,
      tx.due_date || null, json(tx.received_docs || []), tx.external_ref || null, tx.created_at || t, tx.updated_at || t
    );
    addEvent(tenantId, id, { kind: 'created', to_status: tx.status || 'new', actor: tx.actor || null });
    return getTransaction(tenantId, id);
  }
  function getTransaction(tenantId, id) {
    const r = one('SELECT * FROM transactions WHERE tenant_id = ? AND id = ?', tenantId, id);
    return r ? { ...r, received_docs: parseJson(r.received_docs, []) } : null;
  }
  const clientTransactions = (tenantId, clientId) =>
    all('SELECT * FROM transactions WHERE tenant_id = ? AND client_id = ? ORDER BY updated_at DESC', tenantId, clientId)
      .map((r) => ({ ...r, received_docs: parseJson(r.received_docs, []) }));
  const openTransactions = (tenantId) =>
    all("SELECT * FROM transactions WHERE tenant_id = ? AND status NOT IN ('completed','cancelled')", tenantId)
      .map((r) => ({ ...r, received_docs: parseJson(r.received_docs, []) }));

  // تحديث متفائل: ينجح فقط إن كانت الحالة الحالية هي المتوقعة (يكشف التعارض)
  function updateTransactionStatus(tenantId, id, { from, to, actor, note }) {
    const r = run(
      'UPDATE transactions SET status = ?, version = version + 1, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = ?',
      to, nowIso(), tenantId, id, from
    );
    if (!r.changes) return false;
    addEvent(tenantId, id, { kind: 'status_change', from_status: from, to_status: to, note, actor });
    return true;
  }
  function addReceivedDocs(tenantId, id, items, actor) {
    const tx = getTransaction(tenantId, id);
    if (!tx) throw new OpsError('not_found', 'المعاملة غير موجودة.');
    const merged = [...new Set([...tx.received_docs, ...items])];
    run('UPDATE transactions SET received_docs = ?, updated_at = ? WHERE tenant_id = ? AND id = ?', json(merged), nowIso(), tenantId, id);
    addEvent(tenantId, id, { kind: 'document_received', note: items.join('، '), actor });
    return getTransaction(tenantId, id);
  }
  function addEvent(tenantId, transactionId, { kind, from_status = null, to_status = null, note = null, actor = null }) {
    run(
      'INSERT INTO transaction_events (tenant_id, transaction_id, kind, from_status, to_status, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      tenantId, transactionId, kind, from_status, to_status, note, actor, nowIso()
    );
  }
  const transactionEvents = (tenantId, id) =>
    all('SELECT kind, from_status, to_status, note, actor, created_at FROM transaction_events WHERE tenant_id = ? AND transaction_id = ? ORDER BY id', tenantId, id);
  const lastEventAt = (tenantId, id) =>
    one('SELECT MAX(created_at) AS at FROM transaction_events WHERE tenant_id = ? AND transaction_id = ?', tenantId, id)?.at;

  // ===== المهام (مع منع التكرار بمفتاح) =====
  function createTask(tenantId, task) {
    if (task.dedupe_key) {
      const existing = one('SELECT * FROM tasks WHERE tenant_id = ? AND dedupe_key = ?', tenantId, task.dedupe_key);
      if (existing) return { task: existing, created: false };
    }
    const id = newId('tsk');
    const t = nowIso();
    run(
      `INSERT INTO tasks (id, tenant_id, client_id, transaction_id, document_id, title, details, due_date, priority, status, assignee_role, source, dedupe_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      id, tenantId, task.client_id || null, task.transaction_id || null, task.document_id || null, task.title,
      task.details || null, task.due_date || null, task.priority || 'normal', task.assignee_role || null,
      task.source || 'user', task.dedupe_key || null, task.created_by || null, t, t
    );
    return { task: getTask(tenantId, id), created: true };
  }
  const getTask = (tenantId, id) => one('SELECT * FROM tasks WHERE tenant_id = ? AND id = ?', tenantId, id);
  const listTasks = (tenantId, { status = 'open', limit = 200 } = {}) =>
    all(
      `SELECT t.*, c.name AS client_name FROM tasks t LEFT JOIN clients c ON c.id = t.client_id AND c.tenant_id = t.tenant_id
       WHERE t.tenant_id = ? AND (? = 'all' OR t.status = ?)
       ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.due_date LIMIT ?`,
      tenantId, status, status, limit
    );
  const setTaskStatus = (tenantId, id, status) =>
    run('UPDATE tasks SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?', status, nowIso(), tenantId, id).changes > 0;
  const cancelOpenTasks = (tenantId, where, value) =>
    run(`UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE tenant_id = ? AND status = 'open' AND source = 'automation' AND ${where} = ?`,
      nowIso(), tenantId, value).changes;

  // ===== التذكيرات =====
  function createReminder(tenantId, r) {
    if (r.dedupe_key) {
      const existing = one('SELECT * FROM reminders WHERE tenant_id = ? AND dedupe_key = ?', tenantId, r.dedupe_key);
      if (existing) return { reminder: existing, created: false };
    }
    const id = newId('rem');
    const t = nowIso();
    run(
      `INSERT INTO reminders (id, tenant_id, client_id, document_id, transaction_id, kind, channel, template, template_params, message, scheduled_for, status, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, tenantId, r.client_id, r.document_id || null, r.transaction_id || null, r.kind, r.channel, r.template || null,
      json(r.template_params || []), r.message, r.scheduled_for, r.status || 'pending_approval', r.dedupe_key || null, t, t
    );
    return { reminder: getReminder(tenantId, id), created: true };
  }
  const getReminder = (tenantId, id) => one('SELECT * FROM reminders WHERE tenant_id = ? AND id = ?', tenantId, id);
  const listReminders = (tenantId, { status = 'all', limit = 200 } = {}) =>
    all(
      `SELECT r.*, c.name AS client_name FROM reminders r LEFT JOIN clients c ON c.id = r.client_id AND c.tenant_id = r.tenant_id
       WHERE r.tenant_id = ? AND (? = 'all' OR r.status = ?) ORDER BY r.scheduled_for DESC LIMIT ?`,
      tenantId, status, status, limit
    );
  function updateReminder(tenantId, id, fields) {
    const keys = Object.keys(fields);
    run(`UPDATE reminders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      ...keys.map((k) => fields[k]), nowIso(), tenantId, id);
    return getReminder(tenantId, id);
  }
  // إلغاء التذكيرات المعلقة التي لم تعد صالحة (تجديد المستند أو إغلاق المعاملة)
  function cancelPendingReminders(tenantId, where, value, { exceptExpiry } = {}) {
    const rows = all(
      `SELECT id, action_id, dedupe_key FROM reminders WHERE tenant_id = ? AND status = 'pending_approval' AND ${where} = ?`,
      tenantId, value
    ).filter((r) => !exceptExpiry || !String(r.dedupe_key || '').includes(`:${exceptExpiry}:`));
    for (const r of rows) {
      updateReminder(tenantId, r.id, { status: 'cancelled', error: 'أُلغي آلياً: تغيرت حالة المستند أو المعاملة' });
      if (r.action_id) run("UPDATE actions SET status = 'rejected', error = ?, idempotency_key = NULL, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'pending_approval'",
        'أُلغي آلياً لتغير الحالة', nowIso(), tenantId, r.action_id);
    }
    return rows.length;
  }

  // ===== الإجراءات التي تحتاج اعتماداً =====
  function createAction(tenantId, a) {
    if (a.idempotency_key) {
      const existing = one('SELECT * FROM actions WHERE tenant_id = ? AND idempotency_key = ?', tenantId, a.idempotency_key);
      if (existing) return { action: decodeAction(existing), created: false };
    }
    const id = newId('act');
    const t = nowIso();
    run(
      `INSERT INTO actions (id, tenant_id, tool, input, summary, status, requested_by, idempotency_key, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, tenantId, a.tool, json(a.input), a.summary || null, a.status || 'pending_approval', a.requested_by || null,
      a.idempotency_key || null, a.run_id || null, t, t
    );
    return { action: getAction(tenantId, id), created: true };
  }
  const decodeAction = (r) => (r ? { ...r, input: parseJson(r.input, {}), result: parseJson(r.result, null) } : null);
  const getAction = (tenantId, id) => decodeAction(one('SELECT * FROM actions WHERE tenant_id = ? AND id = ?', tenantId, id));
  const listActions = (tenantId, { status = 'pending_approval', limit = 200 } = {}) =>
    all("SELECT * FROM actions WHERE tenant_id = ? AND (? = 'all' OR status = ?) ORDER BY created_at DESC LIMIT ?", tenantId, status, status, limit).map(decodeAction);
  // حجز ذري: يمنع تنفيذ نفس الإجراء مرتين عند الضغط المتكرر على «اعتماد»
  const claimAction = (tenantId, id, from, to, decidedBy) =>
    run('UPDATE actions SET status = ?, decided_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = ?', to, decidedBy, nowIso(), tenantId, id, from).changes === 1;
  const finishAction = (tenantId, id, { status, result = null, error = null }) =>
    run('UPDATE actions SET status = ?, result = ?, error = ?, idempotency_key = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?', status, json(result), error, nowIso(), tenantId, id);

  // ===== تشغيلات الوكيل =====
  function createRun(tenantId, { userId, requestId, request, model }) {
    const id = newId('run');
    run('INSERT INTO agent_runs (id, tenant_id, user_id, request_id, request, status, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, tenantId, userId, requestId || null, request, 'running', model, nowIso());
    return id;
  }
  const finishRun = (tenantId, id, { status, response, error, usage }) =>
    run('UPDATE agent_runs SET status = ?, response = ?, error = ?, usage = ?, finished_at = ? WHERE tenant_id = ? AND id = ?',
      status, json(response), error || null, json(usage), nowIso(), tenantId, id);
  const decodeRun = (r) => (r ? { ...r, response: parseJson(r.response), usage: parseJson(r.usage) } : null);
  const getRun = (tenantId, id) => decodeRun(one('SELECT * FROM agent_runs WHERE tenant_id = ? AND id = ?', tenantId, id));
  const getRunByRequestId = (tenantId, requestId) =>
    decodeRun(one('SELECT * FROM agent_runs WHERE tenant_id = ? AND request_id = ?', tenantId, requestId));

  return {
    db,
    tx: (fn) => db.transaction(fn)(),
    createTenant, getTenant, createUser, getUser, userByToken,
    createClient, getClient, findClients, listClients,
    addDocument, getDocument, clientDocuments, trackedDocuments, setDocumentStatus, updateDocumentExpiry,
    createTransaction, getTransaction, clientTransactions, openTransactions, updateTransactionStatus, addReceivedDocs,
    addEvent, transactionEvents, lastEventAt,
    createTask, getTask, listTasks, setTaskStatus, cancelOpenTasks,
    createReminder, getReminder, listReminders, updateReminder, cancelPendingReminders,
    createAction, getAction, listActions, claimAction, finishAction,
    createRun, finishRun, getRun, getRunByRequestId,
  };
}
