// يتحقق من شكل الطلب المرسل لـ Claude API وتحويل الأخطاء، بـ fetch مُحاكى (لا اتصال بالشبكة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider } from '../src/ops/llm/anthropic.js';
import { loadConfig } from '../src/ops/config.js';

process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
const cfg = { ...loadConfig().llm, maxRetries: 0 };

function fakeFetch(status, body, seen) {
  return async (url, init) => {
    seen?.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  };
}

const okBody = {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null,
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'find_client', input: { query: 'فهد' } }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

test('شكل الطلب: النموذج والجهد والتخزين المؤقت والتحويل الاحتياطي، دون فرض أداة', async () => {
  const seen = [];
  const p = createAnthropicProvider(cfg, { fetch: fakeFetch(200, okBody, seen) });
  const res = await p.chat({ system: 'تعليمات', messages: [{ role: 'user', content: 'مرحبا' }], tools: [{ name: 'find_client', description: 'x', input_schema: { type: 'object' } }] });
  assert.equal(res.stop_reason, 'tool_use');
  assert.equal(res.content[0].name, 'find_client');
  const { url, headers, body } = seen[0];
  assert.match(url, /\/v1\/messages/);
  assert.match(headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(body.thinking, undefined);
  assert.equal(body.betas, undefined); // يُرسل كترويسة لا في الجسم
});

test('بدون التحويل الاحتياطي: طلب عادي بلا ترويسة beta', async () => {
  const seen = [];
  const p = createAnthropicProvider({ ...cfg, refusalFallback: 'off' }, { fetch: fakeFetch(200, okBody, seen) });
  await p.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.equal(seen[0].headers.get('anthropic-beta'), null);
  assert.equal(seen[0].body.fallbacks, undefined);
});

test('تحويل الأخطاء لرسائل مفهومة', async () => {
  const err = (status) => createAnthropicProvider(cfg, { fetch: fakeFetch(status, { type: 'error', error: { type: 'x', message: 'm' } }) })
    .chat({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
  await assert.rejects(err(401), (e) => e.code === 'llm_auth');
  await assert.rejects(err(404), (e) => e.code === 'llm_config');
  await assert.rejects(err(429), (e) => e.code === 'llm_rate_limited' && e.retryable === true);
  await assert.rejects(err(529), (e) => e.code === 'llm_unavailable' && e.retryable === true);
});
