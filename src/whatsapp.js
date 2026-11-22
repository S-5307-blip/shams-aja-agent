import { config } from './config.js';

const endpoint = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;

async function post(body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

export const sendText = (to, text) =>
  post({ to, type: 'text', text: { body: text, preview_url: false } });

// أزرار الرد السريع (حد أقصى 3، وعنوان الزر حتى 20 حرفاً)
export const sendButtons = (to, bodyText, buttons) =>
  post({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  });

export const markRead = (messageId) =>
  post({ status: 'read', message_id: messageId }).catch(() => {});
