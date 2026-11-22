// قناة واتساب (WhatsApp Cloud API). الرسائل التي يبدأها المكتب تتطلب قالباً معتمداً من Meta.
import { OpsError } from '../util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function whatsappChannel(cfg, { fetchImpl = globalThis.fetch, timeoutMs = 10_000, retries = 2, backoffMs = 500 } = {}) {
  const configured = Boolean(cfg.accessToken && cfg.phoneNumberId);
  const endpoint = `https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`;

  async function post(body) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) return data;
        const msg = data?.error?.message || `HTTP ${res.status}`;
        // أخطاء 4xx (رقم غير صالح، قالب غير معتمد) لا تُعاد
        if (res.status < 500 && res.status !== 429) throw new OpsError('channel_rejected', `رفض واتساب الرسالة: ${msg}`, { retryable: false });
        lastErr = new OpsError('channel_unavailable', `واتساب غير متاح مؤقتاً: ${msg}`, { retryable: true });
      } catch (e) {
        if (e.retryable === false) throw e;
        lastErr = e.name === 'TimeoutError' || e.name === 'AbortError'
          ? new OpsError('timeout', 'انتهت مهلة الاتصال بواتساب', { retryable: true })
          : e instanceof OpsError ? e : new OpsError('channel_unavailable', `تعذر الاتصال بواتساب: ${e.message}`, { retryable: true });
      }
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    }
    throw lastErr;
  }

  return {
    name: 'whatsapp',
    configured,
    async send(reminder, { client }) {
      if (!configured) throw new OpsError('not_configured', 'قناة واتساب غير مهيأة (WA_ACCESS_TOKEN و WA_PHONE_NUMBER_ID).');
      if (!client?.phone) throw new OpsError('invalid_input', 'لا يوجد رقم جوال للعميل.');
      if (!reminder.template) throw new OpsError('not_configured', 'لا يوجد قالب واتساب معتمد لهذا النوع من التذكير. أرسله يدوياً أو اعتمد قالباً في Meta.');
      const params = JSON.parse(reminder.template_params || '[]');
      const data = await post({
        to: client.phone,
        type: 'template',
        template: {
          name: reminder.template,
          language: { code: cfg.templateLanguage },
          components: params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text: String(text) })) }] : [],
        },
      });
      const id = data?.messages?.[0]?.id;
      if (!id) throw new OpsError('channel_unconfirmed', 'لم يُرجع واتساب معرّف رسالة؛ لا يمكن تأكيد الإرسال.');
      // «sent» هنا = قَبِلها واتساب للإرسال. التسليم الفعلي يصل لاحقاً عبر webhook الحالات.
      return { status: 'sent', provider_message_id: id };
    },
  };
}
