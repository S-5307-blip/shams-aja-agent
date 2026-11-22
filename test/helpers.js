import { loadConfig } from '../src/ops/config.js';
import { buildRuntime } from '../src/ops/runtime.js';
import { openDb } from '../src/ops/db.js';
import { seedDemo } from '../scripts/seed-demo.js';
import { createMockProvider } from '../src/ops/llm/mock.js';

export const TODAY = '2026-11-22';
// "الآن" ثابت: ظهر اليوم بتوقيت الرياض
export const NOW = () => new Date('2026-11-22T09:00:00Z');

// بيئة اختبار كاملة: قاعدة في الذاكرة + بيانات تجريبية + نموذج محاكى
export function setup({ script, llm, channelOverrides, extraTools, configOverrides = {} } = {}) {
  const config = loadConfig({ ...configOverrides });
  config.llm.provider = 'mock';
  const model = llm || createMockProvider(script);
  const rt = buildRuntime(config, { db: openDb(':memory:'), llm: model, channelOverrides, extraTools, now: NOW });
  const seed = rt.store.tx(() => seedDemo(rt.store, { today: TODAY }));
  const user = (key) => rt.store.userByToken(seed.tokens[key]);
  return { ...rt, config, seed, user };
}
