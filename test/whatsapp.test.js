// قناة واتساب مع fetch مُحاكى (لا اتصال فعلي بـ Meta).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatsappChannel } from '../src/ops/channels/whatsapp.js';

const cfg = { accessToken: 'test-token', phoneNumberId: '123', graphVersion: 'v24.0', templateLanguage: 'ar' };
const reminder = { template: 'renewal_reminder', template_params: JSON.stringify(['الإقامة', '2026-12-17']) };
const client = { phone: '966500000001' };
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('نجاح: يُرسل قالباً ويعيد معرّف الرسالة', async () => {
  const calls = [];
  const ch = whatsappChannel(cfg, { fetchImpl: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return reply(200, { messages: [{ id: 'wamid.X' }] }); } });
  const r = await ch.send(reminder, { client });
  assert.deepEqual(r, { status: 'sent', provider_message_id: 'wamid.X' });
  assert.equal(calls[0].url, 'https://graph.facebook.com/v24.0/123/messages');
  assert.equal(calls[0].body.template.name, 'renewal_reminder');
  assert.deepEqual(calls[0].body.template.components[0].parameters.map((p) => p.text), ['الإقامة', '2026-12-17']);
});

test('خطأ 4xx (قالب غير معتمد) لا يُعاد ويظهر سببه', async () => {
  let n = 0;
  const ch = whatsappChannel(cfg, { fetchImpl: async () => { n++; return reply(400, { error: { message: 'Template name does not exist' } }); } });
  await assert.rejects(() => ch.send(reminder, { client }), /Template name does not exist/);
  assert.equal(n, 1);
});

test('خطأ 5xx يُعاد بتراجع ثم ينجح', async () => {
  let n = 0;
  const ch = whatsappChannel(cfg, { backoffMs: 1, fetchImpl: async () => (++n < 3 ? reply(503, {}) : reply(200, { messages: [{ id: 'wamid.Y' }] })) });
  const r = await ch.send(reminder, { client });
  assert.equal(r.provider_message_id, 'wamid.Y');
  assert.equal(n, 3);
});

test('انتهاء المهلة بعد استنفاد المحاولات', async () => {
  const ch = whatsappChannel(cfg, { backoffMs: 1, retries: 1, fetchImpl: async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; } });
  await assert.rejects(() => ch.send(reminder, { client }), (e) => e.code === 'timeout');
});

test('رد بلا معرّف رسالة لا يُعتبر نجاحاً', async () => {
  const ch = whatsappChannel(cfg, { fetchImpl: async () => reply(200, {}) });
  await assert.rejects(() => ch.send(reminder, { client }), (e) => e.code === 'channel_unconfirmed');
});

test('غير مهيأة أو بلا قالب: خطأ واضح دون اتصال', async () => {
  await assert.rejects(() => whatsappChannel({ ...cfg, accessToken: '' }).send(reminder, { client }), (e) => e.code === 'not_configured');
  await assert.rejects(() => whatsappChannel(cfg, { fetchImpl: async () => assert.fail() }).send({ template: null }, { client }), /لا يوجد قالب/);
});
