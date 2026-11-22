import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import * as db from './db.js';
import * as wa from './whatsapp.js';
import { proposeReply } from './agent.js';
import { isOpenNow } from './hours.js';
import { knowledge, fill } from './knowledge.js';

const OWNER = config.ownerPhone;
const STOP_WORDS = ['إيقاف', 'ايقاف', 'stop', 'unsubscribe'];
const ACK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // رد خارج الدوام مرة كل 6 ساعات لكل عميل
const norm = (s) => (s || '').trim().toLowerCase();

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/health', (_req, res) => res.send('ok'));

// التحقق من الويب هوك (يطلبه Meta عند الإعداد)
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// استقبال الرسائل
app.post('/webhook', (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200); // نرد فوراً على Meta ثم نعالج
  processPayload(req.body).catch((e) => console.error('payload error', e));
});

function validSignature(req) {
  const received = Buffer.from(req.get('x-hub-signature-256') || '');
  const expected = Buffer.from(
    'sha256=' + crypto.createHmac('sha256', config.appSecret).update(req.rawBody || Buffer.alloc(0)).digest('hex')
  );
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

async function processPayload(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages || []) {
        if (!db.markSeen(m.id)) continue; // رسالة مكررة
        try {
          if (m.from === OWNER) await handleOwner(m);
          else await handleCustomer(m, names[m.from]);
        } catch (e) {
          console.error('handler error', e);
        }
      }
    }
  }
}

function messageText(m) {
  if (m.type === 'text') return m.text?.body ?? null;
  if (m.type === 'interactive') return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
  if (m.type === 'button') return m.button?.text ?? null;
  return null;
}

// ===================== رسائل العملاء =====================
async function handleCustomer(m, name) {
  const phone = m.from;
  const text = messageText(m);
  wa.markRead(m.id);

  // إيقاف الرسائل التسويقية
  if (text && STOP_WORDS.includes(norm(text))) {
    db.optOut(phone);
    await wa.sendText(phone, knowledge.messages.optOutConfirmed);
    await safeOwnerText(`ℹ️ العميل +${phone} طلب إيقاف الرسائل التسويقية.`);
    return;
  }

  db.addMessage(phone, 'customer', text ?? `[${m.type}]`);

  // الرد التلقائي الوحيد المعتمد: خارج ساعات العمل (مرة كل 6 ساعات)
  if (!isOpenNow()) {
    const last = Number(db.kvGet(`ack:${phone}`) || 0);
    if (Date.now() - last > ACK_COOLDOWN_MS) {
      const ack = fill(knowledge.messages.offHours, { hours: knowledge.hours.label });
      await wa.sendText(phone, ack);
      db.addMessage(phone, 'business', ack);
      db.kvSet(`ack:${phone}`, String(Date.now()));
    }
  }

  // صور ومستندات: لا نقرأها، نوجّه العميل للبوابة الآمنة
  if (text === null) {
    const reply = fill(knowledge.messages.documentsGuidance, { portal: knowledge.business.portalUrl });
    const analysis = {
      reply, language: 'ar', customer_type: 'unknown', intent: 'إرسال مستند', confidence: 1,
      handoff: false, summary: `أرسل العميل رسالة من نوع (${m.type}). لم تُقرأ، والمقترح توجيهه للبوابة الآمنة.`,
    };
    const id = db.createDraft(phone, `[${m.type}]`, reply, analysis);
    return notifyOwner(id, phone, name, `[${m.type}]`, analysis);
  }

  // تجهيز الرد المقترح
  let analysis;
  try {
    analysis = await proposeReply(phone);
  } catch (e) {
    console.error('agent error', e);
    return safeOwnerText(`⚠️ تعذّر تجهيز رد تلقائي.\nالعميل: ${name || '—'} (+${phone})\nرسالته: ${text}`);
  }
  const id = db.createDraft(phone, text, analysis.reply, analysis);
  await notifyOwner(id, phone, name, text, analysis);
}

async function notifyOwner(draftId, phone, name, customerText, a) {
  const head = a.handoff ? `🔔 تحويل إليك: ${a.handoff_reason || 'يحتاج تدخلك'}` : '💬 رد مقترح';
  const body = [
    head,
    `العميل: ${name || '—'} (+${phone})`,
    `رسالته: ${customerText}`,
    '',
    `المقترح: ${a.reply}`,
    '',
    `الملخص: ${a.summary || '—'}`,
    `الثقة: ${Math.round((a.confidence ?? 0) * 100)}%`,
  ].join('\n').slice(0, 1000);
  try {
    await wa.sendButtons(OWNER, body, [
      { id: `approve:${draftId}`, title: 'موافقة وإرسال' },
      { id: `edit:${draftId}`, title: 'تعديل' },
      { id: `reject:${draftId}`, title: 'رفض' },
    ]);
  } catch (e) {
    console.error('owner notify failed (غالباً انتهت نافذة 24 ساعة للمالك)', e.message);
  }
}

// ===================== رسائل المالك =====================
async function handleOwner(m) {
  if (m.type === 'interactive' && m.interactive?.button_reply) {
    const [action, idStr] = m.interactive.button_reply.id.split(':');
    const id = Number(idStr);
    const draft = db.getDraft(id);
    if (!draft || draft.status !== 'pending') return wa.sendText(OWNER, 'هذا الرد تمت معالجته مسبقاً.');

    if (action === 'approve') return sendToCustomer(draft, draft.reply);
    if (action === 'edit') {
      db.kvSet('editing', String(id));
      return wa.sendText(OWNER, 'اكتب الرد المعدّل وسأرسله للعميل مباشرة. أو أرسل «إلغاء».');
    }
    if (action === 'reject') {
      db.setDraftStatus(id, 'rejected');
      return wa.sendText(OWNER, 'تم تجاهل الرد المقترح. يمكنك الرد على العميل مباشرة.');
    }
    return;
  }

  const text = messageText(m);
  if (!text) return;

  const editing = db.kvGet('editing');
  if (editing) {
    db.kvDel('editing');
    if (norm(text) === 'إلغاء') return wa.sendText(OWNER, 'تم الإلغاء.');
    const draft = db.getDraft(Number(editing));
    if (draft && draft.status === 'pending') return sendToCustomer(draft, text);
  }
  // أي رسالة أخرى من المالك تُبقي نافذة الـ24 ساعة مفتوحة لاستقبال الإشعارات
  return wa.sendText(OWNER, 'جاهز ✅ سأرسل لك الردود المقترحة هنا.');
}

async function sendToCustomer(draft, text) {
  try {
    await wa.sendText(draft.phone, text);
    db.addMessage(draft.phone, 'business', text);
    db.setDraftStatus(draft.id, 'sent');
    await wa.sendText(OWNER, '✅ أُرسل للعميل.');
  } catch (e) {
    console.error('send failed', e.message);
    await safeOwnerText('⚠️ تعذّر الإرسال، غالباً انتهت نافذة الـ24 ساعة للعميل. استخدم قالباً معتمداً أو رد عليه من التطبيق.');
  }
}

async function safeOwnerText(text) {
  try { await wa.sendText(OWNER, text); } catch (e) { console.error('owner text failed', e.message); }
}

app.listen(config.port, () => console.log(`مساعد شمس أجا يعمل على المنفذ ${config.port}`));
