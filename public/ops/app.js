// واجهة بسيطة بدون أطر عمل. الرمز يُحفظ في sessionStorage فقط.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS = {
  needs_clarification: ['يحتاج توضيحاً منك', 's-wait'], proposed: ['مقترح', 's-info'], pending_approval: ['ينتظر اعتماداً', 's-wait'], executing: ['جارٍ التنفيذ', 's-info'],
  succeeded: ['نجح', 's-ok'], done: ['تم', 's-ok'], failed: ['فشل', 's-bad'], rejected: ['مرفوض', 's-muted'],
  duplicate: ['موجود مسبقاً', 's-muted'], skipped: ['تُخطّي', 's-muted'], queued_manual: ['جاهز للإرسال اليدوي', 's-wait'],
  sending: ['جارٍ الإرسال', 's-info'], sent: ['أُرسل', 's-ok'], cancelled: ['ملغى', 's-muted'], open: ['مفتوحة', 's-wait'],
  running: ['قيد المعالجة', 's-info'], valid: ['سارٍ', 's-ok'], expiring: ['قريب الانتهاء', 's-wait'], expired: ['منتهٍ', 's-bad'],
  renewal_in_progress: ['تجديد جارٍ', 's-info'],
};
const APPROVAL = {
  approved: ['معتمد', 's-ok'], needs_approval: ['يحتاج اعتماد المالك', 's-wait'], needs_verification: ['يحتاج تحقق', 's-wait'],
  unverified: ['غير موثق رسمياً', 's-bad'], approved_listing_only: ['خدمة معتمدة — بلا متطلبات موثقة', 's-wait'],
  approved_listing_requirements_unverified: ['خدمة معتمدة — المتطلبات لم تُطابق رسمياً', 's-wait'],
};
const TOOL = {
  search_knowledge: 'بحث في المعرفة', find_client: 'بحث عن عميل', get_client: 'قراءة ملف عميل', get_transaction: 'قراءة معاملة',
  check_missing_requirements: 'فحص النواقص', list_expiring_documents: 'قائمة الانتهاءات', create_task: 'إنشاء مهمة',
  prepare_reminder: 'تجهيز تذكير', resolve_date: 'فهم تاريخ', get_daily_overview: 'ملخص اليوم', propose_transaction_status: 'اقتراح تغيير حالة', record_outcome: 'تسجيل نتيجة',
  escalate_to_staff: 'تحويل للمدير', send_reminder: 'إرسال تذكير', llm: 'النموذج',
};
const PRIORITY = { urgent: ['عاجل', 's-bad'], high: ['مرتفع', 's-wait'], normal: ['عادي', 's-muted'], low: ['منخفض', 's-muted'] };
const badge = (map, k) => { const [t, c] = map[k] || [k, 's-muted']; return `<span class="badge ${c}">${esc(t)}</span>`; };

let me = null;
let lastRequest = null;
let conversationId = null;
const CONF = { high: ['ثقة عالية', 's-ok'], medium: ['ثقة متوسطة', 's-wait'], low: ['ثقة منخفضة', 's-bad'] };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('token') || ''}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `خطأ ${res.status}`);
  return data;
}

function flash(msg, ok = false) {
  const el = $('#flash');
  el.textContent = msg; el.className = ok ? 'ok' : ''; el.hidden = !msg;
  if (msg) setTimeout(() => { if (el.textContent === msg) el.hidden = true; }, 6000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { flash(e.message); } };
const isApprover = () => ['owner', 'manager'].includes(me?.user.role);

// ===== الدخول =====
$('#login').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  sessionStorage.setItem('token', $('#token').value.trim());
  await start();
}));
$('#logout').addEventListener('click', () => { sessionStorage.removeItem('token'); location.reload(); });

async function start() {
  try { me = await api('/me'); } catch (e) { sessionStorage.removeItem('token'); if (e.message) flash(e.message); return; }
  $('#login').hidden = true; $('#who').hidden = false; $('#tabs').hidden = false;
  $('#whoText').textContent = `${me.user.name} (${me.user.role}) — اليوم ${me.today}`;
  $('#tenant').textContent = me.tenant.name;
  $('#runFollowups').hidden = !['owner', 'manager'].includes(me.user.role);
  refreshCounts();
}

// ===== التبويبات =====
const loaders = { approvals: loadApprovals, tasks: loadTasks, reminders: loadReminders, expiring: loadExpiring, clients: () => loadClients(''), audit: loadAudit };
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${b.dataset.tab}`; });
  guard(loaders[b.dataset.tab] || (async () => {}))();
});

async function refreshCounts() {
  try {
    const [acts, tasks] = await Promise.all([api('/actions?status=pending_approval'), api('/tasks?status=open')]);
    $('#badgeApprovals').textContent = acts.length || ''; $('#badgeTasks').textContent = tasks.length || '';
  } catch { /* تجاهل */ }
}

// ===== الطلب =====
$('#askForm').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  lastRequest = { request: $('#request').value.trim(), request_id: crypto.randomUUID(), conversation_id: conversationId };
  await send();
}));
$('#retryBtn').addEventListener('click', guard(send));

async function send() {
  const btn = $('#askBtn'); btn.disabled = true; btn.textContent = 'جارٍ المعالجة…';
  $('#result').innerHTML = '<div class="card">الحالة: <span class="badge s-info">جارٍ التنفيذ</span></div>';
  try {
    const r = await api('/agent/ask', { method: 'POST', body: lastRequest });
    conversationId = r.conversation_id || conversationId;
    appendTurn(lastRequest.request, r);
    $('#request').value = '';
    $('#request').placeholder = r.status === 'needs_clarification' ? 'اكتب جوابك على سؤال الوكيل…' : 'تابع في نفس المحادثة (يتذكر ما سبق)…';
    $('#newConv').hidden = false;
    renderResult(r);
    $('#retryBtn').hidden = r.status !== 'failed';
  } catch (e) {
    $('#result').innerHTML = `<div class="card s-bad">${esc(e.message)}</div>`;
    $('#retryBtn').hidden = false; // نفس request_id: لا تكرار للإجراءات
  } finally {
    btn.disabled = false; btn.textContent = 'إرسال الطلب'; refreshCounts();
  }
}

function appendTurn(text, r) {
  const div = document.createElement('div');
  div.className = 'turn';
  div.innerHTML = `<div class="me">${esc(text)}</div><div class="bot">${esc(r.answer)}${r.clarifying_question ? `\n\n❓ ${esc(r.clarifying_question)}` : ''}</div>`;
  $('#thread').append(div);
}
$('#newConv').addEventListener('click', () => {
  conversationId = null; $('#thread').innerHTML = ''; $('#result').innerHTML = ''; $('#newConv').hidden = true;
  $('#request').placeholder = 'محادثة جديدة: اكتب طلبك…'; $('#request').focus();
});

function renderResult(r) {
  const parts = [];
  parts.push(`<div class="card"><div class="row"><b>النتيجة</b> ${badge(STATUS, r.status)} ${r.confidence ? badge(CONF, r.confidence) : ''}
    ${r.replayed ? '<span class="badge s-muted">نتيجة محفوظة لنفس الطلب</span>' : ''}
    ${r.needs_staff && r.status !== 'needs_clarification' ? `<span class="badge s-wait">يحتاج موظفاً مختصاً${r.staff_reason ? `: ${esc(r.staff_reason)}` : ''}</span>` : ''}</div>
    ${r.understood_request ? `<p class="understood">فهمت طلبك: ${esc(r.understood_request)}</p>` : ''}
    <p class="answer">${esc(r.answer)}</p>
    ${r.clarifying_question ? `<div class="clarify"><b>سؤال قبل ما أكمل:</b> ${esc(r.clarifying_question)}<div class="hint">اكتب جوابك في المربع وأرسله؛ الوكيل يتذكر المحادثة.</div></div>` : ''}</div>`);
  if (r.assumptions?.length) parts.push(`<div class="card"><h3>افتراضات بنيت عليها (صححني إن كانت خطأ)</h3><ul>${r.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>`);
  if (r.missing_info?.length) parts.push(`<div class="card"><h3>معلومات ناقصة</h3><ul>${r.missing_info.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`);
  if (r.sources?.length) {
    parts.push(`<div class="card"><h3>المصادر المستخدمة</h3><table><tr><th>المعرف</th><th>العنوان</th><th>الاعتماد</th><th>المصدر</th><th>تاريخ التحقق</th></tr>
      ${r.sources.map((s) => `<tr><td><code>${esc(s.id)}</code></td><td>${esc(s.title)}</td><td>${badge(APPROVAL, s.approval)}</td>
        <td>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.source)}</a>` : esc(s.source)}</td><td>${esc(s.checked_at)}</td></tr>`).join('')}</table></div>`);
  }
  if (r.actions?.length) {
    parts.push(`<div class="card"><h3>الإجراءات (من نتائج الأدوات الفعلية)</h3><table><tr><th>الإجراء</th><th>الحالة</th><th>التفاصيل</th><th></th></tr>
      ${r.actions.map((a) => `<tr><td>${esc(TOOL[a.tool] || a.tool)}</td><td>${badge(STATUS, a.status)}</td>
        <td>${esc(a.error || a.refs?.summary || a.refs?.note || a.refs?.reason || '')}</td>
        <td>${a.status === 'pending_approval' && a.refs?.action_id && isApprover() ? approveButtons(a.refs.action_id) : ''}</td></tr>`).join('')}</table></div>`);
  }
  if (r.errors?.length) parts.push(`<div class="card s-bad"><h3>أخطاء</h3><ul>${r.errors.map((x) => `<li>${esc(TOOL[x.tool] || x.tool)}: ${esc(x.message)}</li>`).join('')}</ul></div>`);
  if (r.warnings?.length) parts.push(`<div class="card s-wait"><h3>تنبيهات</h3><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`);
  if (r.log?.length) {
    parts.push(`<details class="card"><summary>سجل التنفيذ (${r.log.length} خطوة، ${esc(r.model)})</summary><table><tr><th>الأداة</th><th>الحالة</th><th>المدة</th><th>خطأ</th></tr>
      ${r.log.map((l) => `<tr><td>${esc(TOOL[l.tool] || l.tool)}</td><td>${badge(STATUS, l.status)}</td><td>${l.ms}ms</td><td>${esc(l.error || '')}</td></tr>`).join('')}</table></details>`);
  }
  $('#result').innerHTML = parts.join('');
}

const approveButtons = (id) => `<span class="row"><button data-approve="${esc(id)}">اعتماد</button><button class="danger" data-reject="${esc(id)}">رفض</button></span>`;
document.addEventListener('click', guard(async (e) => {
  const a = e.target.closest('[data-approve]'); const r = e.target.closest('[data-reject]');
  const s = e.target.closest('[data-sent]'); const t = e.target.closest('[data-done]'); const c = e.target.closest('[data-client]');
  if (a) {
    a.disabled = true;
    const res = await api(`/actions/${a.dataset.approve}/approve`, { method: 'POST' });
    flash(res.status === 'succeeded' ? 'نُفذ الإجراء بنجاح.' : `فشل التنفيذ: ${res.error}`, res.status === 'succeeded');
    a.closest('td').innerHTML = badge(STATUS, res.status);
    refreshCounts(); if (!$('#tab-approvals').hidden) loadApprovals();
  } else if (r) {
    r.disabled = true;
    const reason = prompt('سبب الرفض (اختياري):') || '';
    const res = await api(`/actions/${r.dataset.reject}/reject`, { method: 'POST', body: { reason } });
    r.closest('td').innerHTML = badge(STATUS, res.status); refreshCounts(); if (!$('#tab-approvals').hidden) loadApprovals();
  } else if (s) {
    await api(`/reminders/${s.dataset.sent}/mark-sent`, { method: 'POST' }); flash('سُجّل التذكير كمرسل.', true); loadReminders();
  } else if (t) {
    await api(`/tasks/${t.dataset.done}/complete`, { method: 'POST' }); loadTasks(); refreshCounts();
  } else if (c) {
    await loadClient(c.dataset.client);
  }
}));

// ===== القوائم =====
async function loadApprovals() {
  const [pending, recent] = await Promise.all([api('/actions?status=pending_approval'), api('/actions?status=all')]);
  $('#approvals').innerHTML = pending.length ? `<table><tr><th>الإجراء</th><th>الوصف</th><th>التاريخ</th><th></th></tr>
    ${pending.map((x) => `<tr><td>${esc(TOOL[x.tool] || x.tool)}</td><td>${esc(x.summary)}</td><td>${esc(x.created_at.slice(0, 16).replace('T', ' '))}</td>
      <td>${isApprover() ? approveButtons(x.id) : '<span class="hint">يعتمده مدير</span>'}</td></tr>`).join('')}</table>` : '<p class="hint">لا توجد إجراءات معلقة.</p>';
  $('#actionsAll').innerHTML = `<table><tr><th>الإجراء</th><th>الحالة</th><th>الوصف</th><th>النتيجة / الخطأ</th></tr>
    ${recent.filter((x) => x.status !== 'pending_approval').slice(0, 30).map((x) => `<tr><td>${esc(TOOL[x.tool] || x.tool)}</td><td>${badge(STATUS, x.status)}</td>
      <td>${esc(x.summary)}</td><td>${esc(x.error || (x.result ? JSON.stringify(x.result) : ''))}</td></tr>`).join('')}</table>`;
}

async function loadTasks() {
  const rows = await api('/tasks?status=open');
  $('#tasks').innerHTML = rows.length ? `<table><tr><th>المهمة</th><th>العميل</th><th>الأولوية</th><th>الاستحقاق</th><th>المصدر</th><th></th></tr>
    ${rows.map((t) => `<tr><td><b>${esc(t.title)}</b><div class="hint">${esc(t.details || '')}</div></td><td>${esc(t.client_name || '')}</td>
      <td>${badge(PRIORITY, t.priority)}</td><td>${esc(t.due_date || '')}</td><td>${esc({ agent: 'الوكيل', automation: 'آلي', user: 'موظف' }[t.source])}</td>
      <td><button class="secondary" data-done="${esc(t.id)}">إنجاز</button></td></tr>`).join('')}</table>` : '<p class="hint">لا توجد مهام مفتوحة.</p>';
}
$('#runFollowups').addEventListener('click', guard(async () => {
  const s = await api('/automation/followups', { method: 'POST' });
  $('#followupResult').innerHTML = `<div class="card">المتابعة الآلية (${esc(s.today)}): ${s.reminders_created} تذكير جديد، ${s.tasks_created} مهمة جديدة،
    ${s.reminders_existing + s.tasks_existing} موجود مسبقاً، ${s.reminders_skipped_opt_out} تُخطّي لإيقاف الرسائل، ${s.old_reminders_cancelled} أُلغي لتاريخ قديم.
    ${s.errors.length ? `<div class="s-bad">أخطاء: ${esc(s.errors.map((e) => e.error).join('، '))}</div>` : ''}</div>`;
  loadTasks(); refreshCounts();
}));

async function loadReminders() {
  const rows = await api('/reminders');
  $('#reminders').innerHTML = rows.length ? `<table><tr><th>العميل</th><th>النوع</th><th>القناة</th><th>الحالة</th><th>النص</th><th></th></tr>
    ${rows.map((r) => `<tr><td>${esc(r.client_name)}</td><td>${esc({ renewal: 'تجديد', missing_documents: 'نقص مستندات', followup: 'متابعة' }[r.kind])}</td>
      <td>${esc(r.channel === 'whatsapp' ? 'واتساب' : 'يدوي')}</td><td>${badge(STATUS, r.status)}${r.error ? `<div class="hint s-bad">${esc(r.error)}</div>` : ''}</td>
      <td><div class="msg">${esc(r.message)}</div></td>
      <td>${r.status === 'queued_manual' ? `<button class="secondary" data-sent="${esc(r.id)}">أرسلته</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="hint">لا توجد تذكيرات.</p>';
}

async function loadExpiring() {
  const r = await api(`/documents/expiring?days=${$('#days').value}`);
  $('#expiring').innerHTML = docTable(r.documents, true);
}
$('#days').addEventListener('change', guard(loadExpiring));

function docTable(docs, withClient) {
  if (!docs.length) return '<p class="hint">لا توجد مستندات.</p>';
  return `<table><tr>${withClient ? '<th>العميل</th>' : ''}<th>المستند</th><th>التاريخ</th><th>المتبقي</th><th>الحالة</th><th>مصدر التاريخ</th></tr>
    ${docs.map((d) => `<tr>${withClient ? `<td><button class="link" data-client="${esc(d.client_id)}">${esc(d.client_name)}</button></td>` : ''}
      <td>${esc(d.type_name)}${d.holder_name ? ` — ${esc(d.holder_name)}` : ''}<div class="hint">${esc(d.date_meaning)}</div></td>
      <td>${esc(d.expiry_date)}<div class="hint">${esc(d.expiry_hijri)}</div></td>
      <td class="${d.days_left < 0 ? 's-bad' : d.days_left <= 14 ? 's-wait' : ''}">${d.days_left < 0 ? `منتهٍ منذ ${-d.days_left} يوم` : `${d.days_left} يوم`}</td>
      <td>${badge(STATUS, d.status)}</td><td>${esc(d.data_source)}${d.verified_at ? `<div class="hint">تحقق: ${esc(d.verified_at.slice(0, 10))}</div>` : '<div class="hint s-wait">لم يُتحقق</div>'}</td></tr>`).join('')}</table>`;
}

$('#clientSearch').addEventListener('submit', guard(async (e) => { e.preventDefault(); await loadClients($('#clientQ').value); }));
async function loadClients(q) {
  const rows = await api(`/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('#clients').innerHTML = `<table><tr><th>الاسم</th><th>النوع</th><th>السجل</th><th>الرسائل</th></tr>
    ${rows.map((c) => `<tr><td><button class="link" data-client="${esc(c.id)}">${esc(c.name)}</button></td><td>${c.kind === 'business' ? 'منشأة' : 'فرد'}</td>
      <td>${esc(c.cr_number || '')}</td><td>${c.opt_out_reminders ? '<span class="badge s-muted">أوقف الرسائل</span>' : ''}</td></tr>`).join('')}</table>`;
}
async function loadClient(id) {
  const r = await api(`/clients/${id}`);
  document.querySelector('[data-tab="clients"]').click();
  $('#clientDetail').innerHTML = `<div class="card"><h3>${esc(r.client.name)}</h3>${docTable(r.documents, false)}
    <h3>المعاملات</h3><table><tr><th>المعاملة</th><th>الحالة</th><th>المستلم</th><th>آخر تحديث</th></tr>
    ${r.transactions.map((t) => `<tr><td>${esc(t.title)}<div class="hint">${esc(t.id)}</div></td><td>${esc(t.status_label)}</td>
      <td>${esc(t.received_docs.join('، '))}</td><td>${esc(t.updated_at.slice(0, 10))}</td></tr>`).join('')}</table></div>`;
}

async function loadAudit() {
  try {
    const rows = await api('/audit');
    $('#audit').innerHTML = `<table><tr><th>الوقت</th><th>الحدث</th><th>الأداة</th><th>التفاصيل</th></tr>
      ${rows.map((a) => `<tr><td>${esc(a.created_at.slice(0, 19).replace('T', ' '))}</td><td>${esc(a.event)}</td><td>${esc(TOOL[a.tool] || a.tool || '')}</td>
        <td><details><summary>عرض</summary><pre class="msg">${esc(JSON.stringify(a.detail, null, 1))}</pre></details></td></tr>`).join('')}</table>`;
  } catch (e) { $('#audit').innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}

if (sessionStorage.getItem('token')) start();
